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
		sshKey: sshKey,
	}, nil
}

// ==================== Bundle 操作 ====================

// InitBundleDefaults 初始化 Bundle 默认配置
func (m *BundleManager) InitBundleDefaults(bundleName, host string) error {
	bundleRoot := filepath.Join(m.baseDir, "bundles", bundleName)
	defaultsScript := filepath.Join(bundleRoot, "defaults.sh")

	// 如果没有 defaults.sh，跳过
	if _, err := os.Stat(defaultsScript); os.IsNotExist(err) {
		return nil
	}

	utils.Step("Initializing bundle defaults: %s -> %s", bundleName, host)

	// 执行 defaults.sh 脚本
	// TODO: 解析 defaults.sh 并执行下载逻辑

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

	bundleRoot := filepath.Join(m.baseDir, "bundles", bundleName)
	_ = filepath.Join(bundleRoot, "templates") // templateDir - reserved for future use
	remoteScript := filepath.Join(bundleRoot, "remote.sh")

	utils.Step("Running Bundle: %s | Host: %s | Action: %s", bundleName, host, action)

	// 解析部署路径
	deployPath := m.resolveDeployPath(bundleName, host, hostCfg)

	// 处理模板 (setup 或 up)
	if action == "setup" || action == "up" {
		// 确保远程目录存在
		if err := m.ensureRemoteDir(hostCfg.Address, deployPath); err != nil {
			return err
		}

		// 初始化默认配置
		m.InitBundleDefaults(bundleName, host)

		// 推送配置文件
		m.PushBundleConfig(bundleName, host)

		// 处理 YAML 模板
		if err := m.mergeYAMLTemplates(bundleName, host, deployPath); err != nil {
			utils.Warn("YAML template merge failed: %v", err)
		}
	}

	// 执行远程脚本
	if _, err := os.Stat(remoteScript); err == nil {
		if err := m.executeRemoteScript(bundleName, host, action, deployPath, hostCfg); err != nil {
			return err
		}
	}

	return nil
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

// ==================== 远程脚本执行 ====================

// executeRemoteScript 执行远程脚本
func (m *BundleManager) executeRemoteScript(bundleName, host, action, deployPath string, hostCfg *config.HostConfig) error {
	bundleRoot := filepath.Join(m.baseDir, "bundles", bundleName)
	remoteScript := filepath.Join(bundleRoot, "remote.sh")

	// 读取远程脚本
	scriptData, err := os.ReadFile(remoteScript)
	if err != nil {
		return fmt.Errorf("failed to read remote script: %w", err)
	}

	script := string(scriptData)

	// 准备注入变量
	appPrefix := hostCfg.AppPrefix
	if appPrefix == "" {
		appPrefix = "sp-"
	}

	// 生成 Stack 数据 (用于 server bundle)
	stackData := m.generateStackData(hostCfg.Stack)

	// 准备脚本内容
	scriptContent := m.prepareScript(script, appPrefix, deployPath, stackData)

	// 执行远程脚本
	utils.Info("Executing remote script...")
	_, err = SSHExecuteStdin(hostCfg.Address, m.sshKey, scriptContent)
	if err != nil {
		return fmt.Errorf("remote script failed: %w", err)
	}

	utils.Success("Remote script executed")
	return nil
}

// generateStackData 生成 Stack 安装数据
func (m *BundleManager) generateStackData(stackList []string) string {
	if len(stackList) == 0 {
		return ""
	}

	cfg, _ := config.LoadConfig(m.baseDir)
	var lines []string

	for _, app := range stackList {
		src := cfg.GetInstallSource(app)
		if src == nil {
			utils.Warn("Install source not found: %s", app)
			continue
		}

		// 格式: REPO|PATTERN|SVC|VER
		line := fmt.Sprintf("%s|%s|%s|%s",
			src.Repo, src.Pattern, src.ServiceName, src.DefaultVersion)
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n")
}

// prepareScript 准备脚本内容 (替换占位符)
func (m *BundleManager) prepareScript(script, appPrefix, deployPath, stackData string) string {
	// 替换占位符
	script = strings.ReplaceAll(script, "{{APP_PREFIX}}", appPrefix)
	script = strings.ReplaceAll(script, "{{DEPLOY_PATH}}", deployPath)

	// 如果有 Stack 数据，添加
	if stackData != "" {
		stackBlock := fmt.Sprintf("read -r -d '' BATCH_INSTALL_DATA << 'EOF_BATCH'\n%s\nEOF_BATCH\n", stackData)
		script = stackBlock + script
	}

	return script
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
