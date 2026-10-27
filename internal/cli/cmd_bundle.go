package cli

import (
	"context"
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
  setup             映射到 apply（推送配置 + 初始化 + 部署）
  up                映射到 apply（有 plan diff 时需要 --yes）
  down              停止服务
  status            查看服务状态
  upgrade           升级到最新版本 (需 bundle 提供 *-upgrade.sh 模板)
  service <svc> <action>  管理单个服务
  backup            执行 bundle/product backup.hook
  restore [ref]     执行 restore.hook（缺省时标记人工恢复）

子命令:
  check-updates <name>  列出固定 digest 镜像的可更新版本

兼容选项:
  --skip-plan          弃用：跳过 apply 前的 online plan
  --locked             apply 时使用本地 lock 快照
  --allow-irreversible 允许执行不可逆迁移

示例:
  ./spool bundle keeper init keeper
  ./spool bundle keeper up keeper
  ./spool bundle csai upgrade csai
  ./spool bundle keeper service keeper bellkeeper up`,
		RunE: a.runBundle,
	}
	cmd.Flags().Bool("yes", false, "跳过危险操作 (down/cleanup) 或 plan diff 的二次确认")
	cmd.Flags().Bool("force", false, "upgrade: 强制重装（即使已是最新版本）")
	cmd.Flags().Bool("skip-plan", false, "弃用：跳过 apply 前的 online plan")
	cmd.Flags().Bool("locked", false, "apply: 使用本地 lock 快照")
	cmd.Flags().Bool("allow-irreversible", false, "apply: 允许不可逆迁移")
	cmd.AddCommand(a.newBundleCheckUpdatesCmd())
	root.AddCommand(cmd)
}

func (a *App) runBundle(cmd *cobra.Command, args []string) error {
	if len(args) < 3 {
		return fmt.Errorf("usage: spool bundle <name> <action> <host> [service] [svc-action]")
	}

	name := args[0]
	action := args[1]
	host := args[2]

	if action == "setup" || action == "up" {
		manifest, err := engine.LoadBundleManifest(a.BaseDir, name)
		if err != nil || manifest.Type == "compose" {
			return a.runBundleApply(cmd, name, host)
		}
	}

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

	if action == "backup" {
		manager, err := a.newDeployManager(name, host)
		if err != nil {
			return err
		}
		path, err := manager.Backup(context.Background(), name, host, nil, nil)
		if err != nil {
			return newExitError(ExitFailed, "execution_failed", err)
		}
		if jsonFlag {
			return writeJSON(cmd.OutOrStdout(), map[string]string{"bundle": name, "host": host, "backup_dir": path}, nil)
		}
		fmt.Printf("backup %s @ %s: %s\n", name, host, path)
		return nil
	}

	if action == "restore" {
		manager, err := a.newDeployManager(name, host)
		if err != nil {
			return err
		}
		ref := ""
		if len(args) >= 4 {
			ref = args[3]
		}
		result, err := manager.Restore(context.Background(), name, host, ref)
		if err != nil {
			if manual, ok := err.(*engine.ManualRestoreError); ok {
				if jsonFlag {
					_ = writeJSON(cmd.OutOrStdout(), map[string]interface{}{
						"bundle": name, "host": host, "status": "manual", "backup_dirs": manual.BackupDirs,
					}, []string{err.Error()})
					return &ExitError{Code: ExitApproval, Kind: "manual_restore_required", Err: err, Silent: true}
				}
				return &ExitError{Code: ExitApproval, Kind: "manual_restore_required", Err: err}
			}
			return newExitError(ExitFailed, "execution_failed", err)
		}
		if jsonFlag {
			return writeJSON(cmd.OutOrStdout(), result, result.Warnings)
		}
		fmt.Printf("restore %s @ %s: %s\n", name, host, result.Status)
		return nil
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

func (a *App) runBundleApply(cmd *cobra.Command, name, host string) error {
	yes, _ := cmd.Flags().GetBool("yes")
	skipPlan, _ := cmd.Flags().GetBool("skip-plan")
	locked, _ := cmd.Flags().GetBool("locked")
	allowIrreversible, _ := cmd.Flags().GetBool("allow-irreversible")

	manager, err := a.newDeployManager(name, host)
	if err != nil {
		return err
	}
	if skipPlan {
		utils.Warn("--skip-plan is deprecated; apply now runs plan automatically unless --skip-plan is passed")
	} else {
		plan, err := manager.Plan(context.Background(), name, host, engine.PlanOptions{NoLockWrite: locked})
		if err != nil {
			return err
		}
		if len(plan.Diff) > 0 && !yes {
			if !jsonFlag {
				printPlan(plan)
			}
			return newExitError(ExitApproval, "approval_required",
				fmt.Errorf("plan has diff; re-run with --yes to apply (or --skip-plan to bypass the deprecated way)"))
		}
	}
	result, err := manager.Apply(context.Background(), name, host, engine.ApplyOptions{
		Locked:            locked,
		Yes:               yes,
		AllowIrreversible: allowIrreversible,
	})
	if err != nil {
		return applyError(err, result)
	}
	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), result, result.Warnings)
	}
	printApply(result)
	return nil
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
