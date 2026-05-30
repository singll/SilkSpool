package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// StackDriver 二进制栈驱动（Systemd + InstallManager）
type StackDriver struct {
	baseDir string
	sshKey  string
	install *InstallManager
}

// NewStackDriver 创建 Stack 驱动
func NewStackDriver(baseDir, sshKey string) *StackDriver {
	install, _ := NewInstallManager(baseDir)
	return &StackDriver{
		baseDir: baseDir,
		sshKey:  sshKey,
		install: install,
	}
}

// Setup 安装整个栈
func (d *StackDriver) Setup(host string, hostCfg *config.HostConfig, deployPath string) error {
	if d.install == nil {
		return fmt.Errorf("install manager not available")
	}

	utils.Step("Installing stack on %s", host)
	if err := d.install.InstallStack(host); err != nil {
		return fmt.Errorf("stack install failed: %w", err)
	}

	// 推送 Systemd 服务文件（如果 templates 中有）
	manifest, err := d.loadManifest(hostCfg)
	if err == nil && len(manifest.Templates) > 0 {
		if err := d.pushSystemdTemplates(host, hostCfg, deployPath, manifest); err != nil {
			utils.Warn("Systemd template push failed: %v", err)
		}
	}

	return nil
}

// Up 启动所有服务
func (d *StackDriver) Up(host string, hostCfg *config.HostConfig, deployPath string) error {
	re := NewRemoteExecutor(hostCfg.Address, d.sshKey)
	for _, app := range hostCfg.Stack {
		if err := re.Systemctl("start", app); err != nil {
			utils.Warn("Failed to start %s: %v", app, err)
		}
	}
	return nil
}

// Down 停止所有服务
func (d *StackDriver) Down(host string, hostCfg *config.HostConfig, deployPath string) error {
	re := NewRemoteExecutor(hostCfg.Address, d.sshKey)
	for _, app := range hostCfg.Stack {
		if err := re.Systemctl("stop", app); err != nil {
			utils.Warn("Failed to stop %s: %v", app, err)
		}
	}
	return nil
}

// Status 查看所有服务状态
func (d *StackDriver) Status(host string, hostCfg *config.HostConfig, deployPath string) error {
	for _, app := range hostCfg.Stack {
		cmd := fmt.Sprintf("systemctl is-active %s", app)
		out, err := SSHExecute(hostCfg.Address, d.sshKey, cmd)
		if err != nil {
			fmt.Printf("%s: inactive\n", app)
		} else {
			fmt.Printf("%s: %s\n", app, strings.TrimSpace(out))
		}
	}
	return nil
}

// Cleanup 空实现（Stack 没有 cleanup action）
func (d *StackDriver) Cleanup(host string, hostCfg *config.HostConfig, deployPath string, mode string) error {
	return nil
}

// Service 管理单个 Systemd 服务
func (d *StackDriver) Service(host string, hostCfg *config.HostConfig, deployPath string, svc string, action string) error {
	re := NewRemoteExecutor(hostCfg.Address, d.sshKey)

	var systemctlAction string
	switch action {
	case "up", "start":
		systemctlAction = "start"
	case "down", "stop":
		systemctlAction = "stop"
	case "restart":
		systemctlAction = "restart"
	case "logs":
		// journalctl 查看日志
		cmd := fmt.Sprintf("sudo journalctl -u %s -n 100 --no-pager", svc)
		out, err := SSHExecute(hostCfg.Address, d.sshKey, cmd)
		if err == nil {
			fmt.Print(out)
		}
		return err
	case "status":
		cmd := fmt.Sprintf("systemctl is-active %s", svc)
		out, err := SSHExecute(hostCfg.Address, d.sshKey, cmd)
		if err == nil {
			fmt.Printf("%s: %s\n", svc, strings.TrimSpace(out))
		}
		return err
	default:
		return fmt.Errorf("unknown service action: %s", action)
	}

	return re.Systemctl(systemctlAction, svc)
}

// ==================== 内部方法 ====================

// loadManifest 加载当前 bundle 的 manifest
func (d *StackDriver) loadManifest(hostCfg *config.HostConfig) (*BundleManifest, error) {
	if len(hostCfg.Bundles) == 0 {
		return nil, fmt.Errorf("no bundle assigned to host")
	}
	bundleName := hostCfg.Bundles[0]
	loader := NewManifestLoader(d.baseDir)
	return loader.Load(bundleName)
}

// pushSystemdTemplates 推送 Systemd 服务模板
func (d *StackDriver) pushSystemdTemplates(host string, hostCfg *config.HostConfig, deployPath string, manifest *BundleManifest) error {
	re := NewRemoteExecutor(hostCfg.Address, d.sshKey)
	bundleRoot := filepath.Join(d.baseDir, "bundles", manifest.Name)

	for _, t := range manifest.Templates {
		if filepath.Ext(t) != ".service" {
			continue
		}

		localPath := filepath.Join(bundleRoot, "templates", t)
		data, err := os.ReadFile(localPath)
		if err != nil {
			return fmt.Errorf("read template %s failed: %w", t, err)
		}

		// 替换 {{BASE_DIR}} 占位符
		content := strings.ReplaceAll(string(data), "{{BASE_DIR}}", deployPath)

		unitName := filepath.Base(t)
		if err := re.SetupSystemd(unitName, content); err != nil {
			return fmt.Errorf("setup systemd %s failed: %w", unitName, err)
		}
	}

	return nil
}
