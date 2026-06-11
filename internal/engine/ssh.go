package engine

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type SSHClient struct {
	address    string
	sshKey     string
	port       string
	timeout    time.Duration
	knownHosts string
	client     *ssh.Client
	keySigner  ssh.Signer
}

type SSHClientOption func(*SSHClient)

func WithSSHPort(port string) SSHClientOption {
	return func(c *SSHClient) { c.port = port }
}

func WithTimeout(d time.Duration) SSHClientOption {
	return func(c *SSHClient) { c.timeout = d }
}

func WithKnownHosts(path string) SSHClientOption {
	return func(c *SSHClient) { c.knownHosts = path }
}

func NewSSHClient(address, sshKey string, opts ...SSHClientOption) (*SSHClient, error) {
	c := &SSHClient{
		address: address,
		sshKey:  sshKey,
		port:    "22",
		timeout: 30 * time.Second,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c, nil
}

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

	hostKeyCallback, err := c.getHostKeyCallback()
	if err != nil {
		return fmt.Errorf("failed to setup host key verification: %w", err)
	}

	config := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(c.keySigner)},
		HostKeyCallback: hostKeyCallback,
		Timeout:         c.timeout,
	}

	addr := net.JoinHostPort(host, c.port)
	conn, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.client = conn
	return nil
}

func (c *SSHClient) getHostKeyCallback() (ssh.HostKeyCallback, error) {
	if c.knownHosts == "" {
		return ssh.InsecureIgnoreHostKey(), nil
	}

	if _, err := os.Stat(c.knownHosts); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(c.knownHosts), 0700); err != nil {
			return nil, fmt.Errorf("failed to create known_hosts dir: %w", err)
		}
		if err := os.WriteFile(c.knownHosts, []byte{}, 0600); err != nil {
			return nil, fmt.Errorf("failed to create known_hosts file: %w", err)
		}
	}

	return knownhosts.New(c.knownHosts)
}

func (c *SSHClient) Close() error {
	if c.client != nil {
		c.client.Close()
		c.client = nil
	}
	return nil
}

func (c *SSHClient) IsConnected() bool {
	return c.client != nil
}

func (c *SSHClient) Address() string {
	return c.address
}

type SSHClientPool struct {
	mu      sync.Mutex
	clients map[string]*SSHClient
	opts    []SSHClientOption
}

func NewSSHClientPool(opts ...SSHClientOption) *SSHClientPool {
	return &SSHClientPool{
		clients: make(map[string]*SSHClient),
		opts:    opts,
	}
}

func poolKey(address, sshKey string) string {
	return address + "|" + sshKey
}

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

	client, err := NewSSHClient(address, sshKey, p.opts...)
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

func (p *SSHClientPool) CloseAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.clients {
		c.Close()
	}
	p.clients = make(map[string]*SSHClient)
}

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

func (c *SSHClient) Upload(content, remotePath string) error {
	if err := c.Connect(); err != nil {
		return err
	}

	sftpClient, err := sftp.NewClient(c.client)
	if err != nil {
		return fmt.Errorf("failed to create SFTP client: %w", err)
	}
	defer sftpClient.Close()

	f, err := sftpClient.Create(remotePath)
	if err != nil {
		return fmt.Errorf("failed to create remote file: %w", err)
	}
	defer f.Close()

	if _, err := f.Write([]byte(content)); err != nil {
		return fmt.Errorf("failed to write remote file: %w", err)
	}

	return nil
}

func (c *SSHClient) Download(remotePath, localPath string) error {
	if err := c.Connect(); err != nil {
		return err
	}

	sftpClient, err := sftp.NewClient(c.client)
	if err != nil {
		return fmt.Errorf("failed to create SFTP client: %w", err)
	}
	defer sftpClient.Close()

	f, err := sftpClient.Open(remotePath)
	if err != nil {
		return fmt.Errorf("failed to open remote file: %w", err)
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		return fmt.Errorf("failed to read remote file: %w", err)
	}

	if err := os.WriteFile(localPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write local file: %w", err)
	}

	return nil
}

func (c *SSHClient) RemoveFile(remotePath string) error {
	if err := c.Connect(); err != nil {
		return err
	}

	sftpClient, err := sftp.NewClient(c.client)
	if err != nil {
		return fmt.Errorf("failed to create SFTP client: %w", err)
	}
	defer sftpClient.Close()

	return sftpClient.Remove(remotePath)
}

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

var globalPool *SSHClientPool

func InitGlobalPool(opts ...SSHClientOption) {
	globalPool = NewSSHClientPool(opts...)
}

func CloseGlobalPool() {
	if globalPool != nil {
		globalPool.CloseAll()
	}
}

func SSHExecute(address, sshKey, cmd string) (string, error) {
	if globalPool == nil {
		globalPool = NewSSHClientPool()
	}
	client, err := globalPool.Get(address, sshKey)
	if err != nil {
		return "", err
	}
	return client.Execute(cmd)
}

func SSHExecuteStdin(address, sshKey, script string) (string, error) {
	if globalPool == nil {
		globalPool = NewSSHClientPool()
	}
	client, err := globalPool.Get(address, sshKey)
	if err != nil {
		return "", err
	}
	return client.ExecuteStdin(script)
}

func SSHUpload(address, sshKey, content, remotePath string) error {
	if globalPool == nil {
		globalPool = NewSSHClientPool()
	}
	client, err := globalPool.Get(address, sshKey)
	if err != nil {
		return err
	}
	return client.Upload(content, remotePath)
}
