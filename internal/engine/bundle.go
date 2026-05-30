package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// BundleManager Bundle 编排管理器
type BundleManager struct {
	baseDir   string
	sshKey    string
	sshClient *SSHClient
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

	// 获取对应的驱动
	driver, err := GetDriver(manifest.Type, m.baseDir, m.sshKey)
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

	driver, err := GetDriver(manifest.Type, m.baseDir, m.sshKey)
	if err != nil {
		return err
	}

	return driver.Service(host, hostCfg, deployPath, svc, action)
}

// PushBundleConfig 推送 Bundle 配置文件
func (m *BundleManager) PushBundleConfig(bundleName, host string) error {
	syncMgr, err := NewSyncManager(m.baseDir)
	if err != nil {
		return err
	}

	utils.Info("Pushing bundle config files...")

	// 使用 sync 模块推送
	return syncMgr.SyncHost(host, "push")
}

// resolveDeployPath 解析部署路径
func (m *BundleManager) resolveDeployPath(bundleName, host string, hostCfg *config.HostConfig) string {
	defaultPath := fmt.Sprintf("/opt/silkspool/%s", bundleName)

	// 从同步规则中查找
	for _, rule := range hostCfg.SyncRules {
		if strings.Contains(rule.Remote, bundleName) {
			return filepath.Dir(rule.Remote)
		}
	}

	return defaultPath
}

// ensureRemoteDir 确保远程目录存在
func (m *BundleManager) ensureRemoteDir(address, path string) error {
	cmd := fmt.Sprintf("sudo mkdir -p %s && sudo chown $(id -u):$(id -g) %s", path, path)

	result, err := SSHExecute(address, m.sshKey, cmd)
	if err != nil {
		return fmt.Errorf("failed to create remote dir: %w", err)
	}

	_ = result // 忽略输出
	return nil
}

// ==================== YAML 模板合并 ====================

// mergeYAMLTemplates 合并 YAML 模板
func (m *BundleManager) mergeYAMLTemplates(bundleName, host, deployPath string) error {
	bundleRoot := filepath.Join(m.baseDir, "bundles", bundleName)
	templateDir := filepath.Join(bundleRoot, "templates")

	// 查找所有 YAML 文件
	yamlFiles, err := filepath.Glob(filepath.Join(templateDir, "*.yaml"))
	if err != nil || len(yamlFiles) == 0 {
		return nil // 没有 YAML 模板
	}

	utils.Info("Merging YAML templates...")

	// 合并 YAML
	merged, err := m.mergeYAMLFiles(yamlFiles)
	if err != nil {
		return fmt.Errorf("YAML merge failed: %w", err)
	}

	// 上传到远程
	cfg, _ := config.LoadConfig(m.baseDir)
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	remotePath := filepath.Join(deployPath, "docker-compose.yaml")

	// 通过 SSH 上传
	content := string(merged)
	_, err = SSHUploadContent(hostCfg.Address, m.sshKey, content, remotePath)
	if err != nil {
		return fmt.Errorf("failed to upload YAML: %w", err)
	}

	utils.Success("Uploaded docker-compose.yaml")
	return nil
}

// mergeYAMLFiles 合并多个 YAML 文件
func (m *BundleManager) mergeYAMLFiles(files []string) ([]byte, error) {
	var result map[string]interface{}

	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("failed to read %s: %w", file, err)
		}

		var doc map[string]interface{}
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("failed to parse %s: %w", file, err)
		}

		result = m.deepMerge(result, doc)
	}

	return yaml.Marshal(result)
}

// deepMerge 深度合并两个 map
func (m *BundleManager) deepMerge(base, overlay map[string]interface{}) map[string]interface{} {
	if base == nil {
		return overlay
	}
	if overlay == nil {
		return base
	}

	result := make(map[string]interface{})
	for k, v := range base {
		result[k] = v
	}

	for k, v := range overlay {
		if existing, ok := result[k]; ok {
			// 两者都是 map，递归合并
			if baseMap, ok1 := existing.(map[string]interface{}); ok1 {
				if overlayMap, ok2 := v.(map[string]interface{}); ok2 {
					result[k] = m.deepMerge(baseMap, overlayMap)
					continue
				}
			}
		}
		result[k] = v
	}

	return result
}

// ==================== 服务控制 ====================

// StartServices 启动服务
func (m *BundleManager) StartServices(host, serviceType string) error {
	cfg, _ := config.LoadConfig(m.baseDir)
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	utils.Step("Starting services on %s", host)

	switch serviceType {
	case "docker":
		cmd := "docker compose -f /opt/silkspool/" + host + "/docker-compose.yaml up -d"
		_, err := SSHExecute(hostCfg.Address, m.sshKey, cmd)
		return err
	case "systemd":
		// TODO: 实现 systemd 服务启动
		return fmt.Errorf("systemd not implemented")
	default:
		return fmt.Errorf("unknown service type: %s", serviceType)
	}
}

// StopServices 停止服务
func (m *BundleManager) StopServices(host, serviceType string) error {
	cfg, _ := config.LoadConfig(m.baseDir)
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	utils.Step("Stopping services on %s", host)

	switch serviceType {
	case "docker":
		cmd := "docker compose -f /opt/silkspool/" + host + "/docker-compose.yaml down"
		_, err := SSHExecute(hostCfg.Address, m.sshKey, cmd)
		return err
	case "systemd":
		return fmt.Errorf("systemd not implemented")
	default:
		return fmt.Errorf("unknown service type: %s", serviceType)
	}
}

// ServiceStatus 查看服务状态
func (m *BundleManager) ServiceStatus(host, serviceAlias string) (string, error) {
	cfg, _ := config.LoadConfig(m.baseDir)
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return "", fmt.Errorf("host %s not found", host)
	}

	svc := hostCfg.GetService(serviceAlias)
	if svc == nil {
		return "", fmt.Errorf("service %s not found on %s", serviceAlias, host)
	}

	switch svc.Type {
	case "docker":
		cmd := fmt.Sprintf("docker ps --filter name=^%s$ --format '{{.Status}}'", svc.Name)
		status, err := SSHExecute(hostCfg.Address, m.sshKey, cmd)
		return strings.TrimSpace(status), err
	case "systemd":
		cmd := fmt.Sprintf("systemctl is-active %s", svc.Name)
		status, err := SSHExecute(hostCfg.Address, m.sshKey, cmd)
		return strings.TrimSpace(status), err
	default:
		return "", fmt.Errorf("unknown service type: %s", svc.Type)
	}
}
