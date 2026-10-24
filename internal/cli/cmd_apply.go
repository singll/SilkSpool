package cli

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addApplyCmd(root *cobra.Command) {
	var (
		locked            bool
		dryRun            bool
		yes               bool
		allowIrreversible bool
	)
	cmd := &cobra.Command{
		Use:   "apply <bundle> <host>",
		Short: "应用 bundle（单 host、components only）",
		Long: `应用 bundle 到目标 host。dependencies 只用于渲染 wiring，不会被 apply/升级/回滚。

流程：resolve → per-host lock → 远端 generation 快照 → compose up → health gate
      → SSH 回连确认；失败自动回滚上一 generation（不可逆迁移除外）。

示例:
  spool plan knowledge-stack keeper
  spool apply knowledge-stack keeper --yes
  spool apply knowledge-stack keeper --locked --yes`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runApply(cmd, args, engine.ApplyOptions{
				Locked:            locked,
				DryRun:            dryRun,
				Yes:               yes,
				AllowIrreversible: allowIrreversible,
			})
		},
	}
	cmd.Flags().BoolVar(&locked, "locked", false, "只使用本地 lock 快照，若与当前 plan 不一致则拒绝")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "只显示将要执行的 diff")
	cmd.Flags().BoolVar(&yes, "yes", false, "显式确认（script driver / CI）")
	cmd.Flags().BoolVar(&allowIrreversible, "allow-irreversible", false, "允许执行不可逆迁移（必须已声明 backup.hook）")
	root.AddCommand(cmd)
}

func (a *App) runApply(cmd *cobra.Command, args []string, opts engine.ApplyOptions) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool apply <bundle> <host> [--locked] [--dry-run] [--yes] [--allow-irreversible]")
	}
	bundle, host := args[0], args[1]
	manager, err := a.newDeployManager(bundle, host)
	if err != nil {
		return err
	}
	result, err := manager.Apply(context.Background(), bundle, host, opts)
	if err != nil {
		return applyError(err, result)
	}
	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), result, result.Warnings)
	}
	printApply(result)
	return nil
}

func applyError(err error, result *engine.ApplyResult) error {
	switch {
	case errors.Is(err, engine.ErrApprovalRequired):
		return newExitError(ExitApproval, "approval_required", err)
	case errors.Is(err, engine.ErrLockMissing), errors.Is(err, engine.ErrLockMismatch):
		return newExitError(ExitUsage, "usage", err)
	}
	if result != nil && result.RolledBack {
		return newExitError(ExitFailed, "execution_failed", err)
	}
	return newExitError(ExitFailed, "execution_failed", err)
}
