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

	sshKey := filepath.Join(baseDir, cfg.Global.SSHKeyPath)
	if !filepath.IsAbs(sshKey) {
		sshKey = filepath.Join(baseDir, sshKey)
	}

	return &ServiceManager{
		baseDir: baseDir,
		sshKey: sshKey,
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
		status, err := m.GetServiceStatus(host, svc.Alias)
		if err != nil {
			status = "unknown"
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

	output, err := SSHExecute(hostCfg.Address, m.sshKey, cmd)
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

	cmd := m.buildStartCommand(svc.Type, svc.Name)
	if cmd == "" {
		return fmt.Errorf("unknown service type: %s", svc.Type)
	}

	utils.Step("Starting %s on %s", serviceAlias, host)
	_, err = SSHExecute(hostCfg.Address, m.sshKey, cmd)
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

	cmd := m.buildStopCommand(svc.Type, svc.Name)
	if cmd == "" {
		return fmt.Errorf("unknown service type: %s", svc.Type)
	}

	utils.Step("Stopping %s on %s", serviceAlias, host)
	_, err = SSHExecute(hostCfg.Address, m.sshKey, cmd)
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

	cmd := m.buildRestartCommand(svc.Type, svc.Name)
	if cmd == "" {
		return fmt.Errorf("unknown service type: %s", svc.Type)
	}

	utils.Step("Restarting %s on %s", serviceAlias, host)
	_, err = SSHExecute(hostCfg.Address, m.sshKey, cmd)
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

	cmd := m.buildLogsCommand(svc.Type, svc.Name, lines)
	if cmd == "" {
		return "", fmt.Errorf("unknown service type: %s", svc.Type)
	}

	return SSHExecute(hostCfg.Address, m.sshKey, cmd)
}

// ==================== 命令构建 ====================

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

func (m *ServiceManager) buildStartCommand(svcType, name string) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker start %s", name)
	case "systemd":
		return fmt.Sprintf("sudo systemctl start %s", name)
	case "initd", "openwrt":
		return fmt.Sprintf("sudo /etc/init.d/%s start", name)
	default:
		return ""
	}
}

func (m *ServiceManager) buildStopCommand(svcType, name string) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker stop %s", name)
	case "systemd":
		return fmt.Sprintf("sudo systemctl stop %s", name)
	case "initd", "openwrt":
		return fmt.Sprintf("sudo /etc/init.d/%s stop", name)
	default:
		return ""
	}
}

func (m *ServiceManager) buildRestartCommand(svcType, name string) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker restart %s", name)
	case "systemd":
		return fmt.Sprintf("sudo systemctl restart %s", name)
	case "initd", "openwrt":
		return fmt.Sprintf("sudo /etc/init.d/%s restart", name)
	default:
		return ""
	}
}

func (m *ServiceManager) buildLogsCommand(svcType, name string, lines int) string {
	switch svcType {
	case "docker":
		return fmt.Sprintf("docker logs --tail %d %s 2>&1", lines, name)
	case "systemd":
		return fmt.Sprintf("sudo journalctl -u %s -n %d --no-pager", name, lines)
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
