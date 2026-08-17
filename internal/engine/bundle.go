package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// BundleManager Bundle 编排管理器
type BundleManager struct {
	baseDir string
	sshKey  string
}

// NewBundleManager 创建 Bundle 管理器
func NewBundleManager(baseDir string) (*BundleManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	sshKey := filepath.Join(baseDir, cfg.Global.SSHKeyPath)
	if !filepath.IsAbs(sshKey) {
		sshKey = filepath.Join(baseDir, sshKey)
	}

	return &BundleManager{
		baseDir: baseDir,
		sshKey:  sshKey,
	}, nil
}

// ==================== Bundle 操作 ====================

// InitBundleDefaults 初始化 Bundle 默认配置
// 根据 manifest.yaml 中的 defaults 字段生成默认配置文件到 hosts/<host>/
func (m *BundleManager) InitBundleDefaults(bundleName, host string) error {
	loader := NewManifestLoader(m.baseDir)
	manifest, err := loader.Load(bundleName)
	if err != nil {
		// 如果没有 manifest.yaml，跳过
		return nil
	}

	if len(manifest.Defaults) == 0 {
		return nil
	}

	utils.Step("Initializing bundle defaults: %s -> %s", bundleName, host)

	hostDir := filepath.Join(m.baseDir, "hosts", host)
	for _, def := range manifest.Defaults {
		targetPath := filepath.Join(hostDir, def.Path)
		targetDir := filepath.Dir(targetPath)

		if err := os.MkdirAll(targetDir, 0755); err != nil {
			utils.Warn("Failed to create dir %s: %v", targetDir, err)
			continue
		}

		// 如果文件已存在，不覆盖（保护用户已有配置）
		if _, err := os.Stat(targetPath); err == nil {
			utils.Info("  Skipping existing: %s", def.Path)
			continue
		}

		if err := os.WriteFile(targetPath, []byte(def.Content), 0644); err != nil {
			utils.Warn("Failed to write %s: %v", def.Path, err)
			continue
		}
		utils.Info("  Created: %s", def.Path)
	}

	utils.Success("Bundle defaults initialized")
	return nil
}

// SetupBundle 部署 Bundle
func (m *BundleManager) SetupBundle(bundleName, host, action string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	// 加载 manifest
	loader := NewManifestLoader(m.baseDir)
	manifest, err := loader.Load(bundleName)
	if err != nil {
		return fmt.Errorf("failed to load manifest for %s: %w", bundleName, err)
	}

	// 解析部署路径
	deployPath := m.resolveDeployPath(bundleName, host, hostCfg)

	utils.Step("Running Bundle: %s | Host: %s | Action: %s", bundleName, host, action)

	// 获取对应的驱动（使用命令行指定的 bundleName，而非 hostCfg.Bundles[0]）
	driver, err := GetDriver(manifest.Type, m.baseDir, m.sshKey, bundleName, cfg.Global.Defaults)
	if err != nil {
		return err
	}

	// 执行 action
	switch action {
	case "init":
		return m.InitBundleDefaults(bundleName, host)
	case "setup":
		// 初始化默认配置 + 驱动 Setup
		m.InitBundleDefaults(bundleName, host)
		return driver.Setup(host, hostCfg, deployPath)
	case "up":
		return driver.Up(host, hostCfg, deployPath)
	case "down":
		return driver.Down(host, hostCfg, deployPath)
	case "status":
		return driver.Status(host, hostCfg, deployPath)
	case "cleanup":
		return driver.Cleanup(host, hostCfg, deployPath, "normal")
	case "service":
		return fmt.Errorf("service action requires service name, use: bundle %s service <host> <svc> <action>", bundleName)
	default:
		return fmt.Errorf("unknown action: %s", action)
	}
}

// UpgradeBundle 升级 Bundle 到最新版本（当前仅 script 驱动支持）
func (m *BundleManager) UpgradeBundle(bundleName, host string, force bool) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	loader := NewManifestLoader(m.baseDir)
	manifest, err := loader.Load(bundleName)
	if err != nil {
		return fmt.Errorf("failed to load manifest for %s: %w", bundleName, err)
	}

	deployPath := m.resolveDeployPath(bundleName, host, hostCfg)

	utils.Step("Upgrading Bundle: %s | Host: %s | Force: %v", bundleName, host, force)

	driver, err := GetDriver(manifest.Type, m.baseDir, m.sshKey, bundleName, cfg.Global.Defaults)
	if err != nil {
		return err
	}

	return driver.Upgrade(host, hostCfg, deployPath, force)
}

// SetupBundleService 管理 Bundle 中的单个服务
func (m *BundleManager) SetupBundleService(bundleName, host, svc, action string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	loader := NewManifestLoader(m.baseDir)
	manifest, err := loader.Load(bundleName)
	if err != nil {
		return fmt.Errorf("failed to load manifest for %s: %w", bundleName, err)
	}

	deployPath := m.resolveDeployPath(bundleName, host, hostCfg)

	driver, err := GetDriver(manifest.Type, m.baseDir, m.sshKey, bundleName, cfg.Global.Defaults)
	if err != nil {
		return err
	}

	return driver.Service(host, hostCfg, deployPath, svc, action)
}

// resolveDeployPath 解析部署路径
func (m *BundleManager) resolveDeployPath(bundleName, host string, hostCfg *config.HostConfig) string {
	cfg, err := config.LoadConfig(m.baseDir)
	defaultBase := "/opt/silkspool"
	if err == nil {
		defaultBase = config.DefaultString(cfg.Global.Defaults.DeployPath, "/opt/silkspool")
	}
	defaultPath := fmt.Sprintf("%s/%s", defaultBase, bundleName)

	// 从同步规则中查找
	for _, rule := range hostCfg.SyncRules {
		if strings.Contains(rule.Remote, bundleName) {
			return filepath.Dir(rule.Remote)
		}
	}

	return defaultPath
}
