package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/pkg/utils"
)

func (a *App) addServiceCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "service <host> <action> [service]",
		Short: "服务控制",
		Long: `管理远程服务 (Docker 容器 / Systemd 服务 / OpenWrt init.d)

Actions:
  status [svc]      查看服务状态
  start [svc]      启动服务
  stop [svc]       停止服务
  restart [svc]    重启服务
  logs [svc] [N]   查看日志 (默认 50 行)

示例:
  ./spool service keeper status
  ./spool service keeper restart n8n
  ./spool service keeper logs n8n 100`,
		RunE: a.runService,
	}
	root.AddCommand(cmd)

	root.AddCommand(&cobra.Command{
		Use:   "status [host]",
		Short: "查看服务状态",
		RunE:  a.runStatus,
	})
	root.AddCommand(&cobra.Command{
		Use:   "restart <host> [service]",
		Short: "重启服务",
		RunE:  a.runRestart,
	})
	root.AddCommand(&cobra.Command{
		Use:   "logs <host> <service> [lines]",
		Short: "查看服务日志",
		RunE:  a.runLogs,
	})
}

func (a *App) runService(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool service <host> <action> [service]")
	}

	host := args[0]
	action := args[1]
	service := ""
	if len(args) > 2 {
		service = args[2]
	}

	mgr, err := engine.NewServiceManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init service manager: %w", err)
	}

	switch action {
	case "status":
		if service == "" {
			return a.runServiceList(mgr, host)
		}
		return a.runServiceStatus(mgr, host, service)
	case "start":
		if service == "" {
			return fmt.Errorf("usage: spool service <host> start <service>")
		}
		return mgr.StartService(host, service)
	case "stop":
		if service == "" {
			return fmt.Errorf("usage: spool service <host> stop <service>")
		}
		return mgr.StopService(host, service)
	case "restart":
		if service == "" {
			return fmt.Errorf("usage: spool service <host> restart <service>")
		}
		return mgr.RestartService(host, service)
	case "logs":
		if service == "" {
			return fmt.Errorf("usage: spool service <host> logs <service> [lines]")
		}
		lines := 50
		if len(args) > 3 {
			fmt.Sscanf(args[3], "%d", &lines)
		}
		output, err := mgr.GetServiceLogs(host, service, lines)
		if err != nil {
			return fmt.Errorf("failed to get logs: %w", err)
		}
		fmt.Print(output)
		return nil
	default:
		return fmt.Errorf("usage: spool service <host> <action> [service]")
	}
}

func (a *App) runServiceList(mgr *engine.ServiceManager, host string) error {
	services, err := mgr.GetHostServices(host)
	if err != nil {
		return fmt.Errorf("failed to list services: %w", err)
	}

	utils.Info("Services on %s:", host)
	for _, s := range services {
		status := "running"
		if !s.Healthy {
			status = "stopped"
		}
		utils.Info("  %s (%s) - %s", s.Alias, s.Name, status)
	}
	return nil
}

func (a *App) runServiceStatus(mgr *engine.ServiceManager, host, service string) error {
	status, err := mgr.GetServiceStatus(host, service)
	if err != nil {
		return err
	}
	utils.Info("%s: %s", service, status)
	return nil
}

func (a *App) runStatus(cmd *cobra.Command, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool status <host>")
	}
	return a.runService(cmd, append(args, "status"))
}

func (a *App) runRestart(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool restart <host> [service]")
	}
	return a.runService(cmd, []string{args[0], "restart", args[1]})
}

func (a *App) runLogs(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool logs <host> <service> [lines]")
	}
	lines := 50
	if len(args) > 2 {
		fmt.Sscanf(args[2], "%d", &lines)
	}
	return a.runService(cmd, []string{args[0], "logs", args[1], fmt.Sprintf("%d", lines)})
}