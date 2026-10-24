package cli

import (
	"context"
	"fmt"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addRollbackCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "rollback <bundle> <host> [generation]",
		Short: "回滚到远端 generation 快照",
		Long: `基于远端 .spool-gen/<n>/ 恢复 compose/env，然后执行健康检查。
不传 generation 时回滚到 current-1。`,
		RunE: a.runRollback,
	}
	root.AddCommand(cmd)
}

func (a *App) runRollback(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool rollback <bundle> <host> [generation]")
	}
	bundle, host := args[0], args[1]
	generation := 0
	if len(args) >= 3 {
		value, err := strconv.Atoi(args[2])
		if err != nil {
			return newExitError(ExitUsage, "usage", fmt.Errorf("invalid generation %q", args[2]))
		}
		generation = value
	}
	manager, err := a.newDeployManager(bundle, host)
	if err != nil {
		return err
	}
	result, err := manager.Rollback(context.Background(), bundle, host, generation)
	if err != nil {
		if _, ok := err.(*engine.ManualRestoreError); ok {
			return newExitError(ExitApproval, "approval_required", err)
		}
		return newExitError(ExitFailed, "execution_failed", err)
	}
	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), result, result.Warnings)
	}
	fmt.Printf("rollback %s @ %s: generation %d (%s)\n", result.Bundle, result.Host, result.Generation, result.Status)
	return nil
}
