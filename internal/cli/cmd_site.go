package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/pkg/utils"
)

func (a *App) addSiteCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "site <command>",
		Short: "站点快速部署",
		Long: `一键部署站点: DNS + Caddy 反向代理 + Homepage 仪表盘。

命令:
  list              列出所有站点
  add <domain> <backend> <name> [desc] [icon]
  remove <domain>   删除站点
  deploy <domain> <backend> <name>  一键部署
  push              推送所有站点配置

示例:
  ./spool site deploy myapp.singll.net 192.168.7.100:8080 MyApp 'My Application'`,
		RunE: a.runSite,
	}
	root.AddCommand(cmd)
}

func (a *App) runSite(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		siteHelp()
		return nil
	}

	mgr, err := engine.NewSiteManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init site manager: %w", err)
	}

	switch args[0] {
	case "list", "ls":
		sites, err := mgr.ListSites()
		if err != nil {
			return fmt.Errorf("failed to list sites: %w", err)
		}
		utils.Info("Configured sites:")
		for _, s := range sites {
			utils.Info("  %s -> %s", s.Domain, s.Backend)
		}
		return nil
	case "add":
		if len(args) < 4 {
			return fmt.Errorf("usage: site add <domain> <backend> <name> [desc] [icon]")
		}
		desc, icon := "", ""
		if len(args) > 4 {
			desc = args[4]
		}
		if len(args) > 5 {
			icon = args[5]
		}
		return mgr.AddSite(args[1], args[2], args[3], desc, icon)
	case "remove", "rm":
		if len(args) < 2 {
			return fmt.Errorf("usage: site remove <domain>")
		}
		return mgr.RemoveSite(args[1])
	case "deploy":
		if len(args) < 4 {
			return fmt.Errorf("usage: site deploy <domain> <backend> <name> [desc] [icon]")
		}
		desc, icon := "", ""
		if len(args) > 4 {
			desc = args[4]
		}
		if len(args) > 5 {
			icon = args[5]
		}
		return mgr.DeploySite(args[1], args[2], args[3], desc, icon)
	case "push":
		return mgr.PushSites()
	default:
		siteHelp()
		return nil
	}
}

func siteHelp() {
	fmt.Println(`Site Management

Usage: ./spool site <command>

Commands:
  list                                            List all sites
  add <domain> <backend> <name> [desc] [icon]     Add site (DNS + Caddy + Homepage)
  remove <domain>                                 Remove site
  deploy <domain> <backend> <name> [desc] [icon]  One-click deploy (add + push + restart)
  push                                            Push all site configs

Examples:
  ./spool site deploy myapp.singll.net 192.168.7.100:8080 MyApp 'My Application'`)
}