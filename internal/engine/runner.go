package engine

import (
	"fmt"
	"strings"
)

// RemoteRunner 是 apply/plan/rollback 需要的最小远程接口。
// 生产实现基于 SSH，测试可用内存 fake 替代。
type RemoteRunner interface {
	Exec(cmd string) (string, error)
	Upload(content, remotePath string) error
	ReadFile(remotePath string) (string, error)
}

// Reconnectable 表示 runner 支持回连确认。
type Reconnectable interface {
	Reconnect() error
}

// SSHRunner 是 RemoteRunner 的 SSH 实现。
type SSHRunner struct {
	client *SSHClient
}

// NewSSHRunner 包装 SSHClient。
func NewSSHRunner(client *SSHClient) *SSHRunner {
	return &SSHRunner{client: client}
}

// Exec 在远端执行命令。
func (r *SSHRunner) Exec(cmd string) (string, error) {
	return r.client.Execute(cmd)
}

// Upload 上传文件。
func (r *SSHRunner) Upload(content, remotePath string) error {
	return r.client.Upload(content, remotePath)
}

// ReadFile 读取远端文件。
func (r *SSHRunner) ReadFile(remotePath string) (string, error) {
	return r.client.Execute(fmt.Sprintf("cat %s", shellQuote(remotePath)))
}

// Reconnect 关闭并重新建立 SSH 连接，用于 apply 后回连确认。
func (r *SSHRunner) Reconnect() error {
	_ = r.client.Close()
	return r.client.Connect()
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func composeCommand(deployPath string, files []string, args string) string {
	parts := []string{"cd", shellQuote(deployPath), "&&", "docker", "compose"}
	for _, file := range files {
		parts = append(parts, "-f", shellQuote(file))
	}
	if strings.TrimSpace(args) != "" {
		parts = append(parts, args)
	}
	return strings.Join(parts, " ")
}

func remoteBool(runner RemoteRunner, cmd string) bool {
	out, err := runner.Exec(cmd)
	return err == nil && (strings.TrimSpace(out) == "yes" || strings.TrimSpace(out) == "true" || strings.TrimSpace(out) == "1")
}

// NewSSHRunnerForHost 使用全局 SSH 连接池创建 runner。
func NewSSHRunnerForHost(address, sshKey string) (*SSHRunner, error) {
	if globalPool == nil {
		globalPool = NewSSHClientPool()
	}
	client, err := globalPool.Get(address, sshKey)
	if err != nil {
		return nil, err
	}
	return NewSSHRunner(client), nil
}
