package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addUpgradeCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "upgrade <host>",
		Short: "升级主机业务包到最新版本",
		Long: `升级主机上的业务包到最新版本。

根据主机配置中的 bundle 自动选择升级策略（当前支持 script 驱动的 bundle，如 csai）。

流程: 拉取配置备份 (sync pull) → 推送升级脚本 → 远程执行升级 → 重启服务并验证

示例:
  ./spool upgrade csai
  ./spool upgrade csai --force   # 已是最新也强制重装`,
		RunE: a.runUpgrade,
	}
	cmd.Flags().Bool("force", false, "强制重装（即使已是最新版本）")
	root.AddCommand(cmd)
}

func (a *App) runUpgrade(cmd *cobra.Command, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool upgrade <host> [--force]")
	}

	host := args[0]
	if err := a.LoadConfig(); err != nil {
		return err
	}
	hostCfg := a.Config.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("unknown host: %s", host)
	}
	if len(hostCfg.Bundles) == 0 {
		return fmt.Errorf("host %s 未配置 bundle，无法确定升级策略", host)
	}
	if len(hostCfg.Bundles) > 1 {
		return fmt.Errorf("host %s 配置了多个 bundle %v，请使用 spool bundle <name> upgrade %s 指定", host, hostCfg.Bundles, host)
	}

	force, _ := cmd.Flags().GetBool("force")
	mgr, err := engine.NewBundleManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init bundle manager: %w", err)
	}
	return mgr.UpgradeBundle(hostCfg.Bundles[0], host, force)
}
