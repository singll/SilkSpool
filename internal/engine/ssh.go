package engine

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHClient SSH 客户端
type SSHClient struct {
	address   string
	sshKey    string
	timeout   time.Duration
	client    *ssh.Client
	keySigner ssh.Signer
}

// NewSSHClient 创建 SSH 客户端
func NewSSHClient(address, sshKey string) (*SSHClient, error) {
	return &SSHClient{
		address: address,
		sshKey:  sshKey,
		timeout: 30 * time.Second,
	}, nil
}

// Connect 建立连接
func (c *SSHClient) Connect() error {
	if c.client != nil {
		return nil
	}

	if c.keySigner == nil {
		key, err := os.ReadFile(c.sshKey)
		if err != nil {
			return fmt.Errorf("failed to read SSH key: %w", err)
		}
		signer, err := ssh.ParsePrivateKey(key)
		if err != nil {
			return fmt.Errorf("failed to parse SSH key: %w", err)
		}
		c.keySigner = signer
	}

	user, host, err := parseSSHAddress(c.address)
	if err != nil {
		return err
	}

	config := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(c.keySigner)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         c.timeout,
	}

	addr := net.JoinHostPort(host, "22")
	conn, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.client = conn
	return nil
}

// Close 关闭连接
func (c *SSHClient) Close() error {
	if c.client != nil {
		c.client.Close()
		c.client = nil
	}
	return nil
}

// IsConnected 检查连接是否存活（非阻塞，仅检查 nil 状态）
func (c *SSHClient) IsConnected() bool {
	return c.client != nil
}

// Address 返回 SSH 地址
func (c *SSHClient) Address() string {
	return c.address
}

// SSHClientPool SSH 连接池，按 address+sshKey 缓存复用连接
type SSHClientPool struct {
	mu      sync.Mutex
	clients map[string]*SSHClient
}

// NewSSHClientPool 创建连接池
func NewSSHClientPool() *SSHClientPool {
	return &SSHClientPool{
		clients: make(map[string]*SSHClient),
	}
}

// poolKey 生成缓存键
func poolKey(address, sshKey string) string {
	return address + "|" + sshKey
}

// Get 获取或创建 SSH 客户端（同一 address+sshKey 复用连接）
func (p *SSHClientPool) Get(address, sshKey string) (*SSHClient, error) {
	key := poolKey(address, sshKey)

	p.mu.Lock()
	if c, ok := p.clients[key]; ok {
		if c.IsConnected() {
			p.mu.Unlock()
			return c, nil
		}
		c.Close()
		delete(p.clients, key)
	}
	p.mu.Unlock()

	client, err := NewSSHClient(address, sshKey)
	if err != nil {
		return nil, err
	}
	if err := client.Connect(); err != nil {
		return nil, err
	}

	p.mu.Lock()
	p.clients[key] = client
	p.mu.Unlock()

	return client, nil
}

// CloseAll 关闭所有缓存的连接
func (p *SSHClientPool) CloseAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.clients {
		c.Close()
	}
	p.clients = make(map[string]*SSHClient)
}

// Execute 执行命令（含自动重连）
func (c *SSHClient) Execute(cmd string) (string, error) {
	if err := c.Connect(); err != nil {
		return "", err
	}

	session, err := c.client.NewSession()
	if err != nil {
		c.Close()
		if err2 := c.Connect(); err2 != nil {
			return "", fmt.Errorf("reconnect failed: %w (original: %v)", err2, err)
		}
		session, err = c.client.NewSession()
		if err != nil {
			return "", fmt.Errorf("failed to create session after reconnect: %w", err)
		}
	}
	defer session.Close()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr

	if err := session.Run(cmd); err != nil {
		return "", fmt.Errorf("command failed: %s (stderr: %s)", err, stderr.String())
	}

	return stdout.String(), nil
}

// ExecuteStdin 通过 stdin 执行命令（含自动重连）
func (c *SSHClient) ExecuteStdin(script string) (string, error) {
	if err := c.Connect(); err != nil {
		return "", err
	}

	session, err := c.client.NewSession()
	if err != nil {
		c.Close()
		if err2 := c.Connect(); err2 != nil {
			return "", fmt.Errorf("reconnect failed: %w (original: %v)", err2, err)
		}
		session, err = c.client.NewSession()
		if err != nil {
			return "", fmt.Errorf("failed to create session after reconnect: %w", err)
		}
	}
	defer session.Close()

	session.Stdout = os.Stdout
	session.Stderr = os.Stderr
	session.Stdin = strings.NewReader(script)

	err = session.Shell()
	if err != nil {
		return "", fmt.Errorf("failed to start shell: %w", err)
	}

	return "", session.Wait()
}

// Upload 上传文件内容（含自动重连）
func (c *SSHClient) Upload(content, remotePath string) error {
	if err := c.Connect(); err != nil {
		return err
	}

	session, err := c.client.NewSession()
	if err != nil {
		c.Close()
		if err2 := c.Connect(); err2 != nil {
			return fmt.Errorf("reconnect failed: %w (original: %v)", err2, err)
		}
		session, err = c.client.NewSession()
		if err != nil {
			return fmt.Errorf("failed to create session after reconnect: %w", err)
		}
	}
	defer session.Close()

	session.Stdout = os.Stdout
	session.Stderr = os.Stderr
	session.Stdin = strings.NewReader(content)

	err = session.Run(fmt.Sprintf("cat > %s", remotePath))
	if err != nil {
		return fmt.Errorf("upload failed: %w", err)
	}

	return nil
}

// Download 下载远程文件到本地（通过 SSH cat + 写入本地，含自动重连）
func (c *SSHClient) Download(remotePath, localPath string) error {
	if err := c.Connect(); err != nil {
		return err
	}

	session, err := c.client.NewSession()
	if err != nil {
		c.Close()
		if err2 := c.Connect(); err2 != nil {
			return fmt.Errorf("reconnect failed: %w (original: %v)", err2, err)
		}
		session, err = c.client.NewSession()
		if err != nil {
			return fmt.Errorf("failed to create session after reconnect: %w", err)
		}
	}
	defer session.Close()

	var stdout bytes.Buffer
	session.Stdout = &stdout

	if err := session.Run(fmt.Sprintf("cat %s", remotePath)); err != nil {
		return fmt.Errorf("download failed: %w", err)
	}

	if err := os.WriteFile(localPath, stdout.Bytes(), 0644); err != nil {
		return fmt.Errorf("failed to write local file: %w", err)
	}

	return nil
}

// parseSSHAddress 解析 SSH 地址
func parseSSHAddress(address string) (user, host string, err error) {
	if idx := strings.LastIndex(address, "@"); idx != -1 {
		user = address[:idx]
		host = address[idx+1:]
	} else {
		user = os.Getenv("USER")
		host = address
	}

	if host == "" {
		return "", "", fmt.Errorf("invalid SSH address: %s", address)
	}

	return user, host, nil
}

// ==================== 全局便捷函数 ====================

// globalPool 全局连接池，供便捷函数使用
var globalPool = NewSSHClientPool()

// CloseGlobalPool 关闭全局连接池（程序退出时调用）
func CloseGlobalPool() {
	globalPool.CloseAll()
}

// SSHExecute 执行远程命令（使用全局连接池复用连接）
func SSHExecute(address, sshKey, cmd string) (string, error) {
	client, err := globalPool.Get(address, sshKey)
	if err != nil {
		return "", err
	}
	return client.Execute(cmd)
}

// SSHExecuteStdin 通过 stdin 执行脚本（使用全局连接池复用连接）
func SSHExecuteStdin(address, sshKey, script string) (string, error) {
	client, err := globalPool.Get(address, sshKey)
	if err != nil {
		return "", err
	}
	return client.ExecuteStdin(script)
}

// SSHUpload 上传文件内容（使用全局连接池复用连接）
func SSHUpload(address, sshKey, content, remotePath string) error {
	client, err := globalPool.Get(address, sshKey)
	if err != nil {
		return err
	}
	return client.Upload(content, remotePath)
}

// SSHUploadContent 上传内容 (别名)
func SSHUploadContent(address, sshKey, content, remotePath string) (string, error) {
	return "", SSHUpload(address, sshKey, content, remotePath)
}
