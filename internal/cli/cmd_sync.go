package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/pkg/utils"
)

func (a *App) addSyncCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "sync <pull|push> [host]",
		Short: "同步配置文件",
		Long: `在本地 hosts/ 目录与远程服务器之间同步文件。

pull: 拉取远程配置到本地
push: 推送本地配置到远程

示例:
  ./spool sync pull keeper    # 拉取 keeper 配置
  ./spool sync push all       # 推送所有主机配置
  ./spool pull keeper         # 快捷方式
  ./spool push keeper         # 快捷方式`,
		RunE: a.runSync,
	}
	root.AddCommand(cmd)

	root.AddCommand(&cobra.Command{
		Use:   "pull [host]",
		Short: "同步拉取 (sync pull 的快捷方式)",
		RunE:  a.runSyncPull,
	})

	root.AddCommand(&cobra.Command{
		Use:   "push [host]",
		Short: "同步推送 (sync push 的快捷方式)",
		RunE:  a.runSyncPush,
	})
}

func (a *App) runSync(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool sync <pull|push> <host|all>")
	}

	direction := args[0]
	host := args[1]

	mgr, err := engine.NewSyncManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init sync manager: %w", err)
	}

	if host == "all" {
		return mgr.SyncAll(direction)
	}
	return mgr.SyncHost(host, direction)
}

func (a *App) runSyncPull(cmd *cobra.Command, args []string) error {
	return a.runSync(cmd, append([]string{"pull"}, args...))
}

func (a *App) runSyncPush(cmd *cobra.Command, args []string) error {
	return a.runSync(cmd, append([]string{"push"}, args...))
}

func (a *App) runDNSList(mgr *engine.DNSManager) error {
	records, err := mgr.ListDNSRecords()
	if err != nil {
		return fmt.Errorf("failed to list DNS records: %w", err)
	}

	utils.Info("DNS Records:")
	for _, r := range records {
		utils.Info("  %s -> %s", r.Domain, r.IP)
	}
	return nil
}