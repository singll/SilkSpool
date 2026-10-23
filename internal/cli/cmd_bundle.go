package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/pkg/utils"
)

func (a *App) addBundleCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "bundle <name> <action> <host>",
		Short: "Bundle 编排",
		Long: `执行 Bundle 业务包编排操作。

Actions:
  init              初始化默认配置 (下载到 hosts/<host>/)
  setup             安装 + 推送配置 + 初始化
  up                启动服务
  down              停止服务
  status            查看服务状态
  upgrade           升级到最新版本 (需 bundle 提供 *-upgrade.sh 模板)
  service <svc> <action>  管理单个服务

示例:
  ./spool bundle keeper init keeper
  ./spool bundle keeper up keeper
  ./spool bundle csai upgrade csai
  ./spool bundle keeper service keeper bellkeeper up`,
		RunE: a.runBundle,
	}
	cmd.Flags().Bool("yes", false, "跳过危险操作 (down/cleanup) 的二次确认")
	cmd.Flags().Bool("force", false, "upgrade: 强制重装（即使已是最新版本）")
	root.AddCommand(cmd)
}

func (a *App) runBundle(cmd *cobra.Command, args []string) error {
	if len(args) < 3 {
		return fmt.Errorf("usage: spool bundle <name> <action> <host> [service] [svc-action]")
	}

	name := args[0]
	action := args[1]
	host := args[2]

	if action == "down" || action == "cleanup" {
		assumeYes, _ := cmd.Flags().GetBool("yes")
		if jsonFlag && !assumeYes {
			return newExitError(ExitApproval, "approval_required",
				fmt.Errorf("destructive action %q requires --yes in JSON mode", action))
		}
		if !engine.ConfirmDestructive(action, fmt.Sprintf("bundle %s on %s", name, host), assumeYes) {
			if jsonFlag {
				return newExitError(ExitApproval, "approval_required",
					fmt.Errorf("destructive action %q was not confirmed", action))
			}
			utils.Warn("Aborted")
			return nil
		}
	}

	mgr, err := engine.NewBundleManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init bundle manager: %w", err)
	}

	if action == "status" && jsonFlag {
		status, err := mgr.BundleStatus(name, host)
		if err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), status, nil)
	}

	if action == "service" {
		if len(args) < 5 {
			return fmt.Errorf("usage: spool bundle <name> service <host> <service> <action>")
		}
		svc := args[3]
		svcAction := args[4]
		if err := mgr.SetupBundleService(name, host, svc, svcAction); err != nil {
			return err
		}
		return a.bundleActionJSON(cmd, name, host, action, map[string]interface{}{
			"service": svc,
			"command": svcAction,
		})
	}

	if action == "upgrade" {
		force, _ := cmd.Flags().GetBool("force")
		if err := mgr.UpgradeBundle(name, host, force); err != nil {
			return err
		}
		return a.bundleActionJSON(cmd, name, host, action, map[string]interface{}{"force": force})
	}

	if err := mgr.SetupBundle(name, host, action); err != nil {
		return err
	}
	return a.bundleActionJSON(cmd, name, host, action, nil)
}

func (a *App) bundleActionJSON(cmd *cobra.Command, name, host, action string, extra map[string]interface{}) error {
	if !jsonFlag {
		return nil
	}
	data := map[string]interface{}{
		"bundle": name,
		"host":   host,
		"action": action,
		"ok":     true,
	}
	for k, v := range extra {
		data[k] = v
	}
	return writeJSON(cmd.OutOrStdout(), data, nil)
}
