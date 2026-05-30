package engine

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHClient SSH 客户端
type SSHClient struct {
	address   string
	sshKey    string
	timeout   time.Duration
	client    *ssh.Client
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

	user, host, err := parseSSHAddress(c.address)
	if err != nil {
		return err
	}

	key, err := os.ReadFile(c.sshKey)
	if err != nil {
		return fmt.Errorf("failed to read SSH key: %w", err)
	}

	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		return fmt.Errorf("failed to parse SSH key: %w", err)
	}

	config := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
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

// Execute 执行命令
func (c *SSHClient) Execute(cmd string) (string, error) {
	if err := c.Connect(); err != nil {
		return "", err
	}

	session, err := c.client.NewSession()
	if err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}
	defer session.Close()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr

	err = session.Run(cmd)
	if err != nil {
		return "", fmt.Errorf("command failed: %s (stderr: %s)", err, stderr.String())
	}

	return stdout.String(), nil
}

// ExecuteStdin 通过 stdin 执行命令
func (c *SSHClient) ExecuteStdin(script string) (string, error) {
	if err := c.Connect(); err != nil {
		return "", err
	}

	session, err := c.client.NewSession()
	if err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
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

// Upload 上传文件内容
func (c *SSHClient) Upload(content, remotePath string) error {
	if err := c.Connect(); err != nil {
		return err
	}

	session, err := c.client.NewSession()
	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
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

// SSHExecute 执行远程命令
func SSHExecute(address, sshKey, cmd string) (string, error) {
	client, err := NewSSHClient(address, sshKey)
	if err != nil {
		return "", err
	}
	defer client.Close()
	return client.Execute(cmd)
}

// SSHExecuteStdin 通过 stdin 执行脚本
func SSHExecuteStdin(address, sshKey, script string) (string, error) {
	client, err := NewSSHClient(address, sshKey)
	if err != nil {
		return "", err
	}
	defer client.Close()
	return client.ExecuteStdin(script)
}

// SSHUpload 上传文件内容
func SSHUpload(address, sshKey, content, remotePath string) error {
	client, err := NewSSHClient(address, sshKey)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Upload(content, remotePath)
}

// SSHUploadContent 上传内容 (别名)
func SSHUploadContent(address, sshKey, content, remotePath string) (string, error) {
	return "", SSHUpload(address, sshKey, content, remotePath)
}
