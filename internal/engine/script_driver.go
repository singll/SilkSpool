package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// ScriptDriver 脚本驱动：推送 bundle 脚本/配置到远程并执行幂等安装脚本，
// 适用于需要源码构建或纳管既有安装的非容器化应用（非 compose、非单二进制 stack）。
type ScriptDriver struct {
	baseDir    string
	sshKey     string
	bundleName string
	defaults   config.DefaultsConfig
}

func NewScriptDriverWithDefaults(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) *ScriptDriver {
	return &ScriptDriver{
		baseDir:    baseDir,
		sshKey:     sshKey,
		bundleName: bundleName,
		defaults:   defaults,
	}
}

// Setup 推送模板 + 同步配置 + 执行 setup.sh（幂等，可重复运行用于升级）
func (d *ScriptDriver) Setup(host string, hostCfg *config.HostConfig, deployPath string) error {
	manifest, err := d.loadManifest()
	if err != nil {
		return err
	}

	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}

	// 1. 确保远程部署目录
	if err := re.EnsureDir(deployPath); err != nil {
		return err
	}

	// 2. 推送 bundle 模板（{{BASE_DIR}} 占位符替换；.sh 加可执行；.service 走 systemd 安装）
	if err := d.pushTemplates(re, deployPath, manifest); err != nil {
		return err
	}

	// 3. 同步 hosts/<host>/ 配置（.env / config.yaml 等 sync_rules）
	syncMgr, err := NewSyncManager(d.baseDir)
	if err != nil {
		return err
	}
	if err := syncMgr.SyncHost(host, "push"); err != nil {
		return fmt.Errorf("push config failed: %w", err)
	}

	// 4. 远程执行幂等安装脚本
	if d.hasScript(manifest, "setup.sh") {
		utils.Step("Running setup.sh on %s", host)
		out, err := re.Exec(fmt.Sprintf("cd %s && bash setup.sh", deployPath))
		fmt.Print(out)
		if err != nil {
			return fmt.Errorf("setup script failed: %w", err)
		}
	}

	utils.Success("Bundle %s setup complete on %s (start with: spool bundle %s up %s)", d.bundleName, host, d.bundleName, host)
	return nil
}

// Up 启动所有服务
func (d *ScriptDriver) Up(host string, hostCfg *config.HostConfig, deployPath string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	for _, svc := range d.serviceNames(hostCfg) {
		if err := re.Systemctl("start", svc); err != nil {
			utils.Warn("Failed to start %s: %v", svc, err)
		}
	}
	return nil
}

// Down 停止所有服务
func (d *ScriptDriver) Down(host string, hostCfg *config.HostConfig, deployPath string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	for _, svc := range d.serviceNames(hostCfg) {
		if err := re.Systemctl("stop", svc); err != nil {
			utils.Warn("Failed to stop %s: %v", svc, err)
		}
	}
	return nil
}

// Status 查看所有服务状态
func (d *ScriptDriver) Status(host string, hostCfg *config.HostConfig, deployPath string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	for _, svc := range d.serviceNames(hostCfg) {
		cmd := fmt.Sprintf("systemctl is-active %s", svc)
		out, err := re.Exec(cmd)
		if err != nil {
			fmt.Printf("%s: inactive\n", svc)
		} else {
			fmt.Printf("%s: %s\n", svc, strings.TrimSpace(out))
		}
	}
	return nil
}

// Cleanup 空实现（脚本驱动无 cleanup action）
func (d *ScriptDriver) Cleanup(host string, hostCfg *config.HostConfig, deployPath string, mode string) error {
	return nil
}

// Service 管理单个 Systemd 服务
func (d *ScriptDriver) Service(host string, hostCfg *config.HostConfig, deployPath string, svc string, action string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}

	var systemctlAction string
	switch action {
	case "up", "start":
		systemctlAction = "start"
	case "down", "stop":
		systemctlAction = "stop"
	case "restart":
		systemctlAction = "restart"
	case "logs":
		logLines := config.DefaultInt(d.defaults.LogLines, 100)
		cmd := fmt.Sprintf("sudo journalctl -u %s -n %d --no-pager", svc, logLines)
		out, err := re.Exec(cmd)
		if err == nil {
			fmt.Print(out)
		}
		return err
	case "status":
		cmd := fmt.Sprintf("systemctl is-active %s", svc)
		out, err := re.Exec(cmd)
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

func (d *ScriptDriver) loadManifest() (*BundleManifest, error) {
	loader := NewManifestLoader(d.baseDir)
	return loader.Load(d.bundleName)
}

// serviceNames 服务清单：优先 manifest.Services，回退 hostCfg.Stack
func (d *ScriptDriver) serviceNames(hostCfg *config.HostConfig) []string {
	manifest, err := d.loadManifest()
	if err == nil && len(manifest.Services) > 0 {
		return manifest.Services
	}
	return hostCfg.Stack
}

func (d *ScriptDriver) hasScript(manifest *BundleManifest, name string) bool {
	for _, t := range manifest.Templates {
		if t == name {
			return true
		}
	}
	return false
}

// pushTemplates 推送全部模板到 deployPath（{{BASE_DIR}} 替换）
// .sh 上传后 chmod +x；.service 安装到 /etc/systemd/system 并 enable
func (d *ScriptDriver) pushTemplates(re *RemoteExecutor, deployPath string, manifest *BundleManifest) error {
	bundleRoot := filepath.Join(d.baseDir, "bundles", d.bundleName)

	for _, t := range manifest.Templates {
		localPath := filepath.Join(bundleRoot, "templates", t)
		data, err := os.ReadFile(localPath)
		if err != nil {
			return fmt.Errorf("read template %s failed: %w", t, err)
		}
		content := strings.ReplaceAll(string(data), "{{BASE_DIR}}", deployPath)
		name := filepath.Base(t)

		if strings.HasSuffix(name, ".service") {
			unitName := strings.TrimSuffix(name, ".service")
			if err := re.SetupSystemd(unitName, content); err != nil {
				return fmt.Errorf("setup systemd %s failed: %w", unitName, err)
			}
			continue
		}

		remotePath := filepath.Join(deployPath, name)
		if err := re.WriteFile(content, remotePath); err != nil {
			return fmt.Errorf("upload %s failed: %w", name, err)
		}
		if strings.HasSuffix(name, ".sh") {
			if _, err := re.Exec(fmt.Sprintf("chmod +x %s", remotePath)); err != nil {
				return fmt.Errorf("chmod %s failed: %w", name, err)
			}
		}
		utils.Info("  Pushed: %s", name)
	}

	return nil
}
