package engine

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// ServiceManager 服务控制管理器
type ServiceManager struct {
	baseDir string
	sshKey  string
}

// NewServiceManager 创建服务管理器
func NewServiceManager(baseDir string) (*ServiceManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	sshKey := config.ResolveSSHKeyPath(baseDir, cfg.Global.SSHKeyPath)

	return &ServiceManager{
		baseDir: baseDir,
		sshKey:  sshKey,
	}, nil
}

// ServiceInfo 服务信息
type ServiceInfo struct {
	Alias   string
	Name    string
	Type    string
	Status  string
	Healthy bool
}

// GetHostServices 获取主机服务列表
func (m *ServiceManager) GetHostServices(host string) ([]ServiceInfo, error) {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return nil, err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return nil, fmt.Errorf("host %s not found", host)
	}

	var services []ServiceInfo

	for _, svc := range hostCfg.Services {
		status := "unknown"
		cmd := m.buildStatusCommand(svc.Type, svc.Name)
		if cmd != "" {
			if out, err := m.execute(hostCfg, cmd); err == nil {
				status = m.parseStatus(svc.Type, out)
			}
		}

		services = append(services, ServiceInfo{
			Alias:   svc.Alias,
			Name:    svc.Name,
			Type:    svc.Type,
			Status:  status,
			Healthy: status == "running" || status == "Up" || status == "active",
		})
	}

	return services, nil
}

// GetServiceStatus 获取服务状态
func (m *ServiceManager) GetServiceStatus(host, serviceAlias string) (string, error) {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return "", err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return "", fmt.Errorf("host %s not found", host)
	}

	svc := hostCfg.GetService(serviceAlias)
	if svc == nil {
		return "", fmt.Errorf("service %s not found", serviceAlias)
	}

	cmd := m.buildStatusCommand(svc.Type, svc.Name)
	if cmd == "" {
		return "", fmt.Errorf("unknown service type: %s", svc.Type)
	}

	output, err := m.execute(hostCfg, cmd)
	if err != nil {
		return "", err
	}

	return m.parseStatus(svc.Type, output), nil
}

// StartService 启动服务
func (m *ServiceManager) StartService(host, serviceAlias string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	svc := hostCfg.GetService(serviceAlias)
	if svc == nil {
		return fmt.Errorf("service %s not found", serviceAlias)
	}

	cmd := m.buildStartCommand(svc.Type, svc.Name, !isRootSSHUser(hostCfg.Address))
	if cmd == "" {
		return fmt.Errorf("unknown service type: %s", svc.Type)
	}

	utils.Step("Starting %s on %s", serviceAlias, host)
	_, err = m.execute(hostCfg, cmd)
	return err
}

// StopService 停止服务
func (m *ServiceManager) StopService(host, serviceAlias string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	svc := hostCfg.GetService(serviceAlias)
	if svc == nil {
		return fmt.Errorf("service %s not found", serviceAlias)
	}

	cmd := m.buildStopCommand(svc.Type, svc.Name, !isRootSSHUser(hostCfg.Address))
	if cmd == "" {
		return fmt.Errorf("unknown service type: %s", svc.Type)
	}

	utils.Step("Stopping %s on %s", serviceAlias, host)
	_, err = m.execute(hostCfg, cmd)
	return err
}

// RestartService 重启服务
func (m *ServiceManager) RestartService(host, serviceAlias string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	svc := hostCfg.GetService(serviceAlias)
	if svc == nil {
		return fmt.Errorf("service %s not found", serviceAlias)
	}

	cmd := m.buildRestartCommand(svc.Type, svc.Name, !isRootSSHUser(hostCfg.Address))
	if cmd == "" {
		return fmt.Errorf("unknown service type: %s", svc.Type)
	}

	utils.Step("Restarting %s on %s", serviceAlias, host)
	_, err = m.execute(hostCfg, cmd)
	return err
}

// GetServiceLogs 获取服务日志
func (m *ServiceManager) GetServiceLogs(host, serviceAlias string, lines int) (string, error) {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return "", err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return "", fmt.Errorf("host %s not found", host)
	}

	svc := hostCfg.GetService(serviceAlias)
	if svc == nil {
		return "", fmt.Errorf("service %s not found", serviceAlias)
	}

	cmd := m.buildLogsCommand(svc.Type, svc.Name, lines, !isRootSSHUser(hostCfg.Address))
	if cmd == "" {
		return "", fmt.Errorf("unknown service type: %s", svc.Type)
	}

	return m.execute(hostCfg, cmd)
}

// execute 使用 host 级别的 SSH 端口与 known_hosts，避免不同命令连接不同端口。
func (m *ServiceManager) execute(hostCfg *config.HostConfig, cmd string) (string, error) {
	opts := []SSHClientOption{WithKnownHosts(filepath.Join(m.baseDir, "known_hosts"))}
	if hostCfg.SSHPort != "" {
		opts = append(opts, WithSSHPort(hostCfg.SSHPort))
	}
	client, err := NewSSHClient(hostCfg.Address, m.sshKey, opts...)
	if err != nil {
		return "", fmt.Errorf("SSH client failed: %w", err)
	}
	defer client.Close()
	return client.Execute(cmd)
}

// ==================== 命令构建 ====================

// isRootSSHUser 判断 SSH 登录用户是否为 root（root 用户无需 sudo，如 OpenWrt/iStoreOS）
func isRootSSHUser(address string) bool {
	if i := strings.Index(address, "@"); i > 0 {
		return address[:i] == "root"
	}
	return false
}

// sudoPrefix 返回 sudo 前缀（非 root 用户需要提权）
func sudoPrefix(useSudo bool) string {
	if useSudo {
		return "sudo "
	}
	return ""
}

func (m *ServiceManager) buildStatusCommand(svcType, name string) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker ps --filter name=^%s$ --format '{{.Status}}'", name)
	case "systemd":
		return fmt.Sprintf("systemctl is-active %s", name)
	case "initd":
		return fmt.Sprintf("/etc/init.d/%s status 2>/dev/null || echo 'unknown'", name)
	case "openwrt":
		return fmt.Sprintf("/etc/init.d/%s status 2>/dev/null || echo 'unknown'", name)
	default:
		return ""
	}
}

func (m *ServiceManager) buildStartCommand(svcType, name string, useSudo bool) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker start %s", name)
	case "systemd":
		return fmt.Sprintf("%ssystemctl start %s", sudoPrefix(useSudo), name)
	case "initd", "openwrt":
		return fmt.Sprintf("%s/etc/init.d/%s start", sudoPrefix(useSudo), name)
	default:
		return ""
	}
}

func (m *ServiceManager) buildStopCommand(svcType, name string, useSudo bool) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker stop %s", name)
	case "systemd":
		return fmt.Sprintf("%ssystemctl stop %s", sudoPrefix(useSudo), name)
	case "initd", "openwrt":
		return fmt.Sprintf("%s/etc/init.d/%s stop", sudoPrefix(useSudo), name)
	default:
		return ""
	}
}

func (m *ServiceManager) buildRestartCommand(svcType, name string, useSudo bool) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker restart %s", name)
	case "systemd":
		return fmt.Sprintf("%ssystemctl restart %s", sudoPrefix(useSudo), name)
	case "initd", "openwrt":
		return fmt.Sprintf("%s/etc/init.d/%s restart", sudoPrefix(useSudo), name)
	default:
		return ""
	}
}

func (m *ServiceManager) buildLogsCommand(svcType, name string, lines int, useSudo bool) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker logs --tail %d %s 2>&1", lines, name)
	case "systemd":
		return fmt.Sprintf("%sjournalctl -u %s -n %d --no-pager", sudoPrefix(useSudo), name, lines)
	case "initd", "openwrt":
		return fmt.Sprintf("logread -e %s | tail -n %d", name, lines)
	default:
		return ""
	}
}

// ==================== 状态解析 ====================

func (m *ServiceManager) parseStatus(svcType, output string) string {
	output = strings.TrimSpace(output)

	switch svcType {
	case "docker":
		if strings.Contains(output, "Up") || strings.Contains(output, "running") {
			return "running"
		}
		return "stopped"
	case "systemd":
		if output == "active" {
			return "active"
		}
		return "inactive"
	case "initd", "openwrt":
		if strings.Contains(output, "running") || strings.Contains(output, "active") {
			return "running"
		}
		return "stopped"
	default:
		return output
	}
}
