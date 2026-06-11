package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addDNSCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "dns <command>",
		Short: "DNS 记录管理",
		Long: `管理内网域名解析，同时更新多个 DNS 配置源。

命令:
  list              列出所有 DNS 记录
  add <domain> [ip] 添加域名 (默认指向网关 IP)
  remove <domain>   删除域名
  push              推送配置到远程服务器
  deploy <domain>   一键部署 (添加+推送+重启服务)
  pull              拉取远程 DNS 配置
  sync-caddy        从 Caddyfile 同步域名

示例:
  ./spool dns list
  ./spool dns add myapp.singll.net
  ./spool dns deploy myapp.singll.net
  ./spool dns sync-caddy    # 从 Caddyfile 同步域名`,
		RunE: a.runDNS,
	}
	root.AddCommand(cmd)
}

func (a *App) runDNS(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		dnsHelp()
		return nil
	}

	mgr, err := engine.NewDNSManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init DNS manager: %w", err)
	}

	switch args[0] {
	case "list", "ls":
		return a.runDNSList(mgr)
	case "add":
		if len(args) < 2 {
			return fmt.Errorf("usage: dns add <domain> [ip]")
		}
		ip := ""
		if len(args) > 2 {
			ip = args[2]
		}
		return mgr.AddDomain(args[1], ip)
	case "remove", "rm":
		if len(args) < 2 {
			return fmt.Errorf("usage: dns remove <domain>")
		}
		return mgr.RemoveDomain(args[1])
	case "push":
		return mgr.PushDNS()
	case "sync-caddy":
		return mgr.SyncFromCaddyfile()
	case "deploy":
		if len(args) < 2 {
			return fmt.Errorf("usage: dns deploy <domain> [ip]")
		}
		ip := ""
		if len(args) > 2 {
			ip = args[2]
		}
		return mgr.DeployDomain(args[1], ip)
	case "pull":
		return mgr.PullDNS()
	default:
		dnsHelp()
		return nil
	}
}

func dnsHelp() {
	fmt.Println(`DNS Management

Usage: ./spool dns <command>

Commands:
  list              List DNS records
  add <domain> [ip] Add DNS record
  remove <domain>   Remove DNS record
  push              Push DNS config to remote
  pull              Pull DNS config from remote
  deploy <domain>   One-click deploy (add + push + restart)
  sync-caddy        Sync domains from Caddyfile

Examples:
  ./spool dns list
  ./spool dns add myapp.singll.net
  ./spool dns deploy myapp.singll.net`)
}