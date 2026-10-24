package cli

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addPlanCmd(root *cobra.Command) {
	var offline bool
	cmd := &cobra.Command{
		Use:   "plan <bundle> <host>",
		Short: "显示 bundle 的 desired vs actual diff",
		Long: `plan 默认通过 SSH 读取远端实际状态并输出 diff；有 diff 时退出码 3。
--offline 只做 schema/引用/DAG/渲染静态校验，不连接远端：
  合法退出 0，非法退出 2，永不返回 3。`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runPlan(cmd, args, offline)
		},
	}
	cmd.Flags().BoolVar(&offline, "offline", false, "只做静态校验（不连接远端）")
	root.AddCommand(cmd)
}

func (a *App) runPlan(cmd *cobra.Command, args []string, offline bool) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool plan <bundle> <host> [--offline] [--json]")
	}
	bundle, host := args[0], args[1]

	manager, err := a.newPlanManager(host, offline)
	if err != nil {
		if offline {
			return newExitError(ExitUsage, "validation", err)
		}
		return newExitError(ExitFailed, "execution_failed", err)
	}
	result, err := manager.Plan(context.Background(), bundle, host, engine.PlanOptions{Offline: offline})
	if err != nil {
		if offline {
			return newExitError(ExitUsage, "validation", err)
		}
		return newExitError(ExitFailed, "execution_failed", err)
	}

	if jsonFlag {
		if err := writeJSON(cmd.OutOrStdout(), result, result.Warnings); err != nil {
			return err
		}
	} else {
		printPlan(result)
	}

	if result.Unsupported && !offline {
		return &ExitError{Code: ExitFailed, Kind: "unsupported", Err: fmt.Errorf("plan is unsupported for this bundle"), Silent: true}
	}
	if !offline && len(result.Diff) > 0 {
		return &ExitError{Code: ExitDiff, Kind: "diff", Err: fmt.Errorf("plan has diff"), Silent: true}
	}
	return nil
}
