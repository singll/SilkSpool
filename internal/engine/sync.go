package engine

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// SyncManager 同步管理器
type SyncManager struct {
	baseDir string
	sshKey  string
	sops    *SOPSManager
}

// NewSyncManager 创建同步管理器
func NewSyncManager(baseDir string) (*SyncManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	sshKey := filepath.Join(baseDir, cfg.Global.SSHKeyPath)
	if !filepath.IsAbs(sshKey) {
		sshKey = filepath.Join(baseDir, sshKey)
	}

	// 初始化 SOPS (仅当 age 密钥存在时启用，否则保持明文同步)
	var sopsMgr *SOPSManager
	ageKey := cfg.Global.AgeKeyPath
	if ageKey == "" {
		ageKey = filepath.Join(baseDir, "keys", "age.key")
	} else if !filepath.IsAbs(ageKey) {
		ageKey = filepath.Join(baseDir, ageKey)
	}
	if _, err := os.Stat(ageKey); err == nil {
		sopsMgr = NewSOPSManagerWithKey(ageKey)
	}

	return &SyncManager{
		baseDir: baseDir,
		sshKey:  sshKey,
		sops:    sopsMgr,
	}, nil
}

// SyncHost 同步单个主机
func (m *SyncManager) SyncHost(host string, direction string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	utils.Step("Syncing config: %s (%s)", host, direction)

	// 遍历同步规则
	for _, rule := range hostCfg.SyncRules {
		localPath := filepath.Join(m.baseDir, "hosts", host, rule.Local)
		remotePath := rule.Remote

		if direction == "pull" {
			if err := m.pullFile(hostCfg.Address, remotePath, localPath); err != nil {
				utils.Error("Pull failed: %s (%v)", rule.Local, err)
			} else {
				utils.Success("Pulled: %s", rule.Local)
			}
		} else {
			// 优先处理 SOPS 加密文件 (<local>.enc)，否则常规推送
			if m.tryPushEncrypted(hostCfg.Address, host, rule) {
				m.runPostPushHooks(host, hostCfg, rule.Local)
				continue
			}
			if err := m.pushFile(hostCfg.Address, localPath, remotePath); err != nil {
				utils.Error("Push failed: %s (%v)", rule.Local, err)
			} else {
				utils.Success("Pushed: %s", rule.Local)
				// 执行 post-push hooks
				m.runPostPushHooks(host, hostCfg, rule.Local)
			}
		}
	}

	return nil
}

// SyncAll 同步所有主机
func (m *SyncManager) SyncAll(direction string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	for host := range cfg.Hosts {
		if err := m.SyncHost(host, direction); err != nil {
			utils.Warn("Sync %s failed: %v", host, err)
		}
	}

	return nil
}

// pullFile 拉取远程文件到本地
func (m *SyncManager) pullFile(address, remotePath, localPath string) error {
	// 确保本地目录存在
	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return fmt.Errorf("failed to create local dir: %w", err)
	}

	// 使用 rsync 拉取
	cmd := exec.Command("rsync", "-azc",
		"-e", fmt.Sprintf("ssh -i %s -o StrictHostKeyChecking=no", m.sshKey),
		fmt.Sprintf("%s:%s", address, remotePath),
		localPath,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// pushFile 推送本地文件到远程
func (m *SyncManager) pushFile(address, localPath, remotePath string) error {
	// 检查本地文件是否存在
	if _, err := os.Stat(localPath); os.IsNotExist(err) {
		return fmt.Errorf("local file not found: %s", localPath)
	}

	// 确保远程父目录存在 (与旧 shell 版一致: push 前 mkdir -p)
	m.ensureRemoteDir(address, filepath.Dir(remotePath))

	// 解析用户名
	user := strings.Split(address, "@")[0]

	// 远程需要 sudo (如果是非 root 用户)
	rsyncPath := "rsync"
	if user != "root" {
		rsyncPath = "sudo rsync"
	}

	// 使用 rsync 推送
	cmd := exec.Command("rsync", "-azc",
		"-e", fmt.Sprintf("ssh -i %s -o StrictHostKeyChecking=no", m.sshKey),
		"--rsync-path", rsyncPath,
		localPath,
		fmt.Sprintf("%s:%s", address, remotePath),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// runPostPushHooks 执行推送后钩子
func (m *SyncManager) runPostPushHooks(host string, hostCfg *config.HostConfig, localPath string) {
	for _, hook := range hostCfg.PostPushHooks {
		// 检查是否匹配
		if !strings.Contains(localPath, hook.Pattern) {
			continue
		}

		utils.Info("Running post-push hook: %s", hook.Pattern)

		// 构建 SSH 命令
		cmd := exec.Command("ssh",
			"-i", m.sshKey,
			"-o", "StrictHostKeyChecking=no",
			hostCfg.Address,
			hook.Command,
		)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		if err := cmd.Run(); err != nil {
			utils.Warn("Hook failed: %s", hook.Command)
		} else {
			utils.Success("Hook succeeded: %s", truncateCommand(hook.Command, 60))
		}
	}
}

// truncateCommand 截断命令显示
func truncateCommand(cmd string, maxLen int) string {
	if len(cmd) <= maxLen {
		return cmd
	}
	if maxLen < 3 {
		return "..."
	}
	return cmd[:maxLen-3] + "..."
}

// SyncHostFile 同步单个文件
func (m *SyncManager) SyncHostFile(host, direction, localPath string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	// 查找对应的远程路径
	var remotePath string
	for _, rule := range hostCfg.SyncRules {
		if rule.Local == localPath {
			remotePath = rule.Remote
			break
		}
	}

	if remotePath == "" {
		return fmt.Errorf("no sync rule for %s", localPath)
	}

	localFullPath := filepath.Join(m.baseDir, "hosts", host, localPath)

	if direction == "pull" {
		return m.pullFile(hostCfg.Address, remotePath, localFullPath)
	}
	return m.pushFile(hostCfg.Address, localFullPath, remotePath)
}

// ensureRemoteDir 确保远程父目录存在
func (m *SyncManager) ensureRemoteDir(address, dir string) {
	if dir == "" || dir == "." || dir == "/" {
		return
	}
	user := strings.Split(address, "@")[0]
	mkdir := fmt.Sprintf("mkdir -p %q", dir)
	if user != "root" {
		mkdir = fmt.Sprintf(`if [ ! -d %q ]; then sudo mkdir -p %q && sudo chown $(id -u):$(id -g) %q; fi`, dir, dir, dir)
	}
	client, err := globalPool.Get(address, m.sshKey)
	if err != nil {
		utils.Warn("Failed to connect for ensuring remote dir %s: %v", dir, err)
		return
	}
	if _, err := client.Execute(mkdir); err != nil {
		utils.Warn("Failed to ensure remote dir %s: %v", dir, err)
	}
}

// tryPushEncrypted 若存在 <local>.enc 加密文件，则解密并上传到远程。
// 返回 true 表示该规则已被处理(无论成功失败)，不应再走明文推送。
func (m *SyncManager) tryPushEncrypted(address, host string, rule config.SyncRule) bool {
	encPath := filepath.Join(m.baseDir, "hosts", host, rule.Local+".enc")
	if _, err := os.Stat(encPath); err != nil {
		return false
	}

	if m.sops == nil {
		utils.Warn("Found %s.enc but SOPS age key not configured, skipping", rule.Local)
		return true
	}

	utils.Info("Decrypting and pushing: %s.enc -> %s", rule.Local, rule.Remote)
	plaintext, err := m.sops.Decrypt(encPath)
	if err != nil {
		utils.Error("Decrypt %s.enc failed: %v", rule.Local, err)
		return true
	}

	m.ensureRemoteDir(address, filepath.Dir(rule.Remote))
	client, err := globalPool.Get(address, m.sshKey)
	if err != nil {
		utils.Error("SSH connect failed for pushing %s: %v", rule.Local, err)
		return true
	}
	if err := client.Upload(string(plaintext), rule.Remote); err != nil {
		utils.Error("Upload decrypted %s failed: %v", rule.Local, err)
		return true
	}

	utils.Success("Pushed (decrypted): %s", rule.Local)
	return true
}
