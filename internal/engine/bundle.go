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

	hostDir := BundleConfigDir(m.baseDir, host, bundleName, manifest)
	legacyDir := filepath.Join(m.baseDir, "hosts", host)
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

		// 兼容旧布局：hosts/<host>/<path> 已存在时不再创建 bundle 作用域的副本，
		// 同步阶段会回退到旧路径。
		if manifest.ConfigRootOrDefault() == "bundle" {
			if _, err := os.Stat(filepath.Join(legacyDir, def.Path)); err == nil {
				utils.Info("  Using legacy config: %s", def.Path)
				continue
			}
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
	deployPath := m.resolveDeployPath(bundleName)

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

	deployPath := m.resolveDeployPath(bundleName)

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

	deployPath := m.resolveDeployPath(bundleName)

	driver, err := GetDriver(manifest.Type, m.baseDir, m.sshKey, bundleName, cfg.Global.Defaults)
	if err != nil {
		return err
	}

	return driver.Service(host, hostCfg, deployPath, svc, action)
}

// BundleConfigDir 返回 bundle 配置在控制机上的根目录。
func BundleConfigDir(baseDir, host, bundleName string, manifest *BundleManifest) string {
	if manifest != nil && manifest.ConfigRootOrDefault() == "bundle" {
		return filepath.Join(baseDir, "hosts", host, bundleName)
	}
	return filepath.Join(baseDir, "hosts", host)
}

// BundleStatus 是 bundle 状态的结构化表示（用于 --json）。
type BundleStatus struct {
	Bundle     string                `json:"bundle"`
	Host       string                `json:"host"`
	Driver     string                `json:"driver"`
	DeployPath string                `json:"deploy_path"`
	Services   []BundleServiceStatus `json:"services"`
	Output     string                `json:"output,omitempty"`
}

// BundleServiceStatus 描述单个服务/容器的状态。
type BundleServiceStatus struct {
	Name    string `json:"name"`
	State   string `json:"state,omitempty"`
	Health  string `json:"health,omitempty"`
	Image   string `json:"image,omitempty"`
	Status  string `json:"status,omitempty"`
	Service string `json:"service,omitempty"`
}

// BundleStatus 读取 bundle 的结构化状态。script 驱动没有可观测状态，返回 unsupported。
func (m *BundleManager) BundleStatus(bundleName, host string) (*BundleStatus, error) {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return nil, err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return nil, fmt.Errorf("host %s not found", host)
	}

	manifest, err := NewManifestLoader(m.baseDir).Load(bundleName)
	if err != nil {
		return nil, fmt.Errorf("failed to load manifest for %s: %w", bundleName, err)
	}

	status := &BundleStatus{
		Bundle:     bundleName,
		Host:       host,
		Driver:     manifest.Type,
		DeployPath: m.resolveDeployPath(bundleName),
		Services:   []BundleServiceStatus{},
	}

	switch manifest.Type {
	case "compose":
		re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, m.sshKey, cfg.Global.Defaults)
		if err != nil {
			return nil, err
		}
		files := m.composeFiles(status.DeployPath)
		if out, err := re.Exec(fmt.Sprintf("test -f %q && echo yes || true", files[1])); err != nil || !strings.Contains(out, "yes") {
			files = files[:1]
		}
		services, raw, err := re.ComposePSJSON(files...)
		if err != nil {
			return nil, err
		}
		status.Services = services
		status.Output = raw
	case "stack":
		re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, m.sshKey, cfg.Global.Defaults)
		if err != nil {
			return nil, err
		}
		for _, app := range hostCfg.Stack {
			state := "unknown"
			if out, err := re.Exec(fmt.Sprintf("systemctl is-active %s", app)); err == nil {
				state = strings.TrimSpace(out)
			}
			status.Services = append(status.Services, BundleServiceStatus{Name: app, State: state, Status: state})
		}
	case "script":
		return nil, fmt.Errorf("status is unsupported for script driver (bundle %s)", bundleName)
	}

	return status, nil
}

// ComposeFiles 返回运行 bundle 所需的 compose 文件列表（基础 + spool override）。
func (m *BundleManager) ComposeFiles(bundleName string) []string {
	return m.composeFiles(m.resolveDeployPath(bundleName))
}

func (m *BundleManager) composeFiles(deployPath string) []string {
	return []string{
		filepath.Join(deployPath, "docker-compose.yaml"),
		filepath.Join(deployPath, "docker-compose.spool.yaml"),
	}
}

// DeployPath 返回 bundle 的远程部署目录。
func (m *BundleManager) DeployPath(bundleName string) string {
	return m.resolveDeployPath(bundleName)
}

// resolveDeployPath 解析部署路径：
// 1. bundle manifest 显式 deploy_path
// 2. global.defaults.deploy_path/<bundle>
func (m *BundleManager) resolveDeployPath(bundleName string) string {
	cfg, err := config.LoadConfig(m.baseDir)
	defaultBase := "/opt/silkspool"
	if err == nil {
		defaultBase = config.DefaultString(cfg.Global.Defaults.DeployPath, "/opt/silkspool")
	}

	if manifest, err := NewManifestLoader(m.baseDir).Load(bundleName); err == nil && manifest.DeployPath != "" {
		return manifest.DeployPath
	}

	return filepath.Join(defaultBase, bundleName)
}
