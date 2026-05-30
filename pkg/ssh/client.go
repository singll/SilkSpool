package ssh

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Client SSH 客户端封装
type Client struct {
	config  *ssh.ClientConfig
	address string
	client  *ssh.Client
}

// NewClient 创建一个新的 SSH 客户端
func NewClient(user, addr, privateKeyPath string, timeout time.Duration) (*Client, error) {
	key, err := os.ReadFile(privateKeyPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read private key: %w", err)
	}

	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	config := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicAuth(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         timeout,
	}

	return &Client{
		config:  config,
		address: addr,
	}, nil
}

// Connect 建立 SSH 连接
func (c *Client) Connect() error {
	if c.client != nil {
		return nil
	}

	conn, err := ssh.Dial("tcp", c.address, c.config)
	if err != nil {
		return fmt.Errorf("failed to dial SSH: %w", err)
	}

	c.client = conn
	return nil
}

// Close 关闭 SSH 连接
func (c *Client) Close() error {
	if c.client != nil {
		c.client.Close()
		c.client = nil
	}
	return nil
}

// Execute 执行远程命令并返回输出
func (c *Client) Execute(cmd string) (string, error) {
	if c.client == nil {
		return "", fmt.Errorf("not connected")
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

// ExecuteStreaming 执行命令并流式输出结果
func (c *Client) ExecuteStreaming(cmd string, stdout, stderr io.Writer) error {
	if c.client == nil {
		return fmt.Errorf("not connected")
	}

	session, err := c.client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()

	session.Stdout = stdout
	session.Stderr = stderr

	return session.Run(cmd)
}

// ExecuteWithSudo 使用 sudo 执行命令
func (c *Client) ExecuteWithSudo(cmd string) (string, error) {
	return c.Execute(fmt.Sprintf("sudo %s", cmd))
}

// UploadContent 上传文件内容 (通过 stdin)
func (c *Client) UploadContent(content string, remotePath string) error {
	if c.client == nil {
		return fmt.Errorf("not connected")
	}

	session, err := c.client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()

	session.Stdout = os.Stdout
	session.Stderr = os.Stderr
	session.Stdin = bytes.NewBufferString(content)

	err = session.Run(fmt.Sprintf("cat > %s", remotePath))
	if err != nil {
		return fmt.Errorf("upload failed: %w", err)
	}

	return nil
}

// UploadContentSudo 使用 sudo 上传文件内容
func (c *Client) UploadContentSudo(content string, remotePath string) (string, error) {
	return c.ExecuteWithSudo(fmt.Sprintf("cat > %s", remotePath))
}

// Address 返回 SSH 地址
func (c *Client) Address() string {
	return c.address
}

// ClientFromConfig 从 user@host 格式创建 SSH 客户端
func ClientFromConfig(address, sshKeyPath string) (*Client, error) {
	user, host, err := parseAddress(address)
	if err != nil {
		return nil, err
	}

	addr := net.JoinHostPort(host, "22")
	return NewClient(user, addr, sshKeyPath, 10*time.Second)
}

// parseAddress 解析 user@host 格式的地址
func parseAddress(address string) (user, host string, err error) {
	if idx := strings.LastIndex(address, "@"); idx != -1 {
		user = address[:idx]
		host = address[idx+1:]
	} else {
		user = os.Getenv("USER")
		host = address
	}

	if host == "" {
		return "", "", fmt.Errorf("invalid address: %s", address)
	}

	return user, host, nil
}
