package engine

import (
	"context"
	"errors"
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
	baseDir    string
	sshKey     string
	knownHosts string
	sops       *SOPSManager
}

// NewSyncManager 创建同步管理器
func NewSyncManager(baseDir string) (*SyncManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	sshKey := config.ResolveSSHKeyPath(baseDir, cfg.Global.SSHKeyPath)

	knownHosts := filepath.Join(baseDir, "known_hosts")

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
		baseDir:    baseDir,
		sshKey:     sshKey,
		knownHosts: knownHosts,
		sops:       sopsMgr,
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

	var errs []error
	// 遍历同步规则
	for _, rule := range hostCfg.SyncRules {
		localPath := joinLocalRulePath(m.baseDir, host, rule.Local)
		remotePath := rule.Remote

		if direction == "pull" {
			if err := m.pullFile(hostCfg, remotePath, localPath); err != nil {
				utils.Error("Pull failed: %s (%v)", rule.Local, err)
				errs = append(errs, fmt.Errorf("pull %s: %w", rule.Local, err))
			} else {
				utils.Success("Pulled: %s", rule.Local)
			}
		} else {
			// 优先处理 SOPS 加密文件 (<local>.enc)，否则常规推送
			if handled, err := m.tryPushEncrypted(hostCfg, host, rule); handled {
				if err != nil {
					utils.Error("Encrypted push failed: %s (%v)", rule.Local, err)
					errs = append(errs, fmt.Errorf("push encrypted %s: %w", rule.Local, err))
					continue
				}
				m.runPostPushHooks(host, hostCfg, rule.Local)
				continue
			}
			if err := m.pushFile(hostCfg, localPath, remotePath); err != nil {
				utils.Error("Push failed: %s (%v)", rule.Local, err)
				errs = append(errs, fmt.Errorf("push %s: %w", rule.Local, err))
			} else {
				utils.Success("Pushed: %s", rule.Local)
				// 执行 post-push hooks
				m.runPostPushHooks(host, hostCfg, rule.Local)
			}
		}
	}

	return errors.Join(errs...)
}

// SyncBundle 推送 bundle 自带的配置文件（manifest.sync_rules + 自动 .env）。
// 失败会聚合返回，不再静默成功。
func (m *SyncManager) SyncBundle(host, bundleName, deployPath string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	loaded, err := NewBundleRepository(m.baseDir, cfg).Load(context.Background(), bundleName, nil)
	if err != nil {
		return fmt.Errorf("failed to load manifest for %s: %w", bundleName, err)
	}
	manifest := loaded.Manifest

	configDir := BundleConfigDir(m.baseDir, host, bundleName, manifest)
	legacyDir := filepath.Join(m.baseDir, "hosts", host)
	rules := append([]BundleSyncRule(nil), manifest.SyncRules...)

	// 默认将 .env 推到 deploy_path/.env；显式规则优先。
	hasEnvDefault := false
	for _, def := range manifest.Defaults {
		if filepath.Clean(def.Path) == ".env" {
			hasEnvDefault = true
			break
		}
	}
	if hasEnvDefault {
		explicit := false
		for _, rule := range rules {
			if filepath.Clean(rule.Local) == ".env" {
				explicit = true
				break
			}
		}
		if !explicit {
			rules = append(rules, BundleSyncRule{Local: ".env", Remote: "${deploy_path}/.env"})
		}
	}

	var errs []error
	for _, rule := range rules {
		if strings.TrimSpace(rule.Local) == "" || strings.TrimSpace(rule.Remote) == "" {
			errs = append(errs, fmt.Errorf("bundle %s: invalid sync rule %q -> %q", bundleName, rule.Local, rule.Remote))
			continue
		}

		localPath := joinBundleRulePath(configDir, rule.Local)
		if _, statErr := os.Stat(strings.TrimSuffix(localPath, "/")); statErr != nil && manifest.ConfigRootOrDefault() == "bundle" {
			legacyPath := joinBundleRulePath(legacyDir, rule.Local)
			if _, legacyErr := os.Stat(strings.TrimSuffix(legacyPath, "/")); legacyErr == nil {
				localPath = legacyPath
			}
		}
		if _, statErr := os.Stat(strings.TrimSuffix(localPath, "/")); statErr != nil {
			errs = append(errs, fmt.Errorf("bundle %s sync %s: local file not found: %s", bundleName, rule.Local, localPath))
			continue
		}

		remotePath := strings.ReplaceAll(rule.Remote, "${deploy_path}", deployPath)
		remotePath = strings.ReplaceAll(remotePath, "${host}", host)
		if err := m.pushFile(hostCfg, localPath, remotePath); err != nil {
			utils.Error("Bundle push failed: %s (%v)", rule.Local, err)
			errs = append(errs, fmt.Errorf("push %s: %w", rule.Local, err))
			continue
		}
		utils.Success("Pushed: %s", remotePath)
	}

	return errors.Join(errs...)
}

// SyncAll 同步所有主机
func (m *SyncManager) SyncAll(direction string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	var errs []error
	for host := range cfg.Hosts {
		if err := m.SyncHost(host, direction); err != nil {
			utils.Warn("Sync %s failed: %v", host, err)
			errs = append(errs, fmt.Errorf("sync %s: %w", host, err))
		}
	}

	return errors.Join(errs...)
}

// pullFile 拉取远程文件到本地
func (m *SyncManager) pullFile(hostCfg *config.HostConfig, remotePath, localPath string) error {
	// 确保本地目录存在
	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return fmt.Errorf("failed to create local dir: %w", err)
	}

	sshPort := hostCfg.SSHPort
	if sshPort == "" {
		sshPort = "22"
	}

	// 使用 rsync 拉取
	cmd := exec.Command("rsync", "-azc",
		"-e", fmt.Sprintf("ssh -i %s -p %s -o UserKnownHostsFile=%s -o StrictHostKeyChecking=yes", m.sshKey, sshPort, m.knownHosts),
		fmt.Sprintf("%s:%s", hostCfg.Address, remotePath),
		localPath,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// pushFile 推送本地文件到远程
func (m *SyncManager) pushFile(hostCfg *config.HostConfig, localPath, remotePath string) error {
	// 检查本地文件是否存在
	if _, err := os.Stat(localPath); os.IsNotExist(err) {
		return fmt.Errorf("local file not found: %s", localPath)
	}

	sshPort := hostCfg.SSHPort
	if sshPort == "" {
		sshPort = "22"
	}

	// 确保远程父目录存在 (与旧 shell 版一致: push 前 mkdir -p)
	m.ensureRemoteDir(hostCfg, filepath.Dir(remotePath))

	// 解析用户名
	user := strings.Split(hostCfg.Address, "@")[0]

	// 远程需要 sudo (如果是非 root 用户)
	rsyncPath := "rsync"
	if user != "root" {
		rsyncPath = "sudo rsync"
	}

	// 使用 rsync 推送
	cmd := exec.Command("rsync", "-azc",
		"-e", fmt.Sprintf("ssh -i %s -p %s -o UserKnownHostsFile=%s -o StrictHostKeyChecking=yes", m.sshKey, sshPort, m.knownHosts),
		"--rsync-path", rsyncPath,
		localPath,
		fmt.Sprintf("%s:%s", hostCfg.Address, remotePath),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// runPostPushHooks 执行推送后钩子
func (m *SyncManager) runPostPushHooks(host string, hostCfg *config.HostConfig, localPath string) {
	sshPort := hostCfg.SSHPort
	if sshPort == "" {
		sshPort = "22"
	}

	for _, hook := range hostCfg.PostPushHooks {
		// 检查是否匹配
		if !strings.Contains(localPath, hook.Pattern) {
			continue
		}

		utils.Info("Running post-push hook: %s", hook.Pattern)

		// 构建 SSH 命令
		cmd := exec.Command("ssh",
			"-i", m.sshKey,
			"-p", sshPort,
			"-o", fmt.Sprintf("UserKnownHostsFile=%s", m.knownHosts),
			"-o", "StrictHostKeyChecking=yes",
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

	localFullPath := joinLocalRulePath(m.baseDir, host, localPath)

	if direction == "pull" {
		return m.pullFile(hostCfg, remotePath, localFullPath)
	}
	return m.pushFile(hostCfg, localFullPath, remotePath)
}

// joinLocalRulePath 拼接 hosts/<host>/<rule.Local>；
// rule.Local 以 / 结尾（目录同步）时保留尾部斜杠 —— filepath.Join 会将其清除，
// 而 rsync 依赖 src 尾部斜杠区分"同步目录内容"与"拷贝目录本身"，
// 丢失斜杠会在远程形成双层嵌套（tools/ → tools/tools）
func joinLocalRulePath(baseDir, host, ruleLocal string) string {
	p := filepath.Join(baseDir, "hosts", host, ruleLocal)
	if strings.HasSuffix(ruleLocal, "/") && !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
}

// joinBundleRulePath 拼接 bundle 配置根目录与规则路径，保留目录规则的尾部斜杠。
func joinBundleRulePath(root, ruleLocal string) string {
	p := filepath.Join(root, ruleLocal)
	if strings.HasSuffix(ruleLocal, "/") && !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
}

// ensureRemoteDir 确保远程父目录存在
func (m *SyncManager) ensureRemoteDir(hostCfg *config.HostConfig, dir string) {
	if dir == "" || dir == "." || dir == "/" {
		return
	}
	user := strings.Split(hostCfg.Address, "@")[0]
	mkdir := fmt.Sprintf("mkdir -p %q", dir)
	if user != "root" {
		mkdir = fmt.Sprintf(`if [ ! -d %q ]; then sudo mkdir -p %q && sudo chown $(id -u):$(id -g) %q; fi`, dir, dir, dir)
	}

	sshPort := hostCfg.SSHPort
	if sshPort == "" {
		sshPort = "22"
	}

	client, err := NewSSHClient(hostCfg.Address, m.sshKey,
		WithSSHPort(sshPort),
		WithKnownHosts(m.knownHosts),
	)
	if err != nil {
		utils.Warn("Failed to create SSH client for ensuring remote dir %s: %v", dir, err)
		return
	}
	defer client.Close()
	if err := client.Connect(); err != nil {
		utils.Warn("Failed to connect for ensuring remote dir %s: %v", dir, err)
		return
	}
	if _, err := client.Execute(mkdir); err != nil {
		utils.Warn("Failed to ensure remote dir %s: %v", dir, err)
	}
}

// tryPushEncrypted 若存在 <local>.enc 加密文件，则解密并上传到远程。
// handled 表示该规则应走加密路径（无论成功失败）；错误必须向上传播。
func (m *SyncManager) tryPushEncrypted(hostCfg *config.HostConfig, host string, rule config.SyncRule) (bool, error) {
	encPath := filepath.Join(m.baseDir, "hosts", host, rule.Local+".enc")
	if _, err := os.Stat(encPath); err != nil {
		return false, nil
	}

	if m.sops == nil {
		return true, fmt.Errorf("found %s.enc but SOPS age key is not configured", rule.Local)
	}

	utils.Info("Decrypting and pushing: %s.enc -> %s", rule.Local, rule.Remote)
	plaintext, err := m.sops.Decrypt(encPath)
	if err != nil {
		return true, fmt.Errorf("decrypt %s.enc: %w", rule.Local, err)
	}

	sshPort := hostCfg.SSHPort
	if sshPort == "" {
		sshPort = "22"
	}

	m.ensureRemoteDir(hostCfg, filepath.Dir(rule.Remote))
	client, err := NewSSHClient(hostCfg.Address, m.sshKey,
		WithSSHPort(sshPort),
		WithKnownHosts(m.knownHosts),
	)
	if err != nil {
		return true, fmt.Errorf("ssh client for %s: %w", rule.Local, err)
	}
	defer client.Close()
	if err := client.Connect(); err != nil {
		return true, fmt.Errorf("ssh connect for %s: %w", rule.Local, err)
	}
	if err := client.Upload(string(plaintext), rule.Remote); err != nil {
		return true, fmt.Errorf("upload decrypted %s: %w", rule.Local, err)
	}

	utils.Success("Pushed (decrypted): %s", rule.Local)
	return true, nil
}
