package cli

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addRestoreCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "restore <bundle> <host> [backup-ref]",
		Short: "执行 bundle restore.hook（缺省时标记人工恢复）",
		RunE:  a.runRestore,
	}
	root.AddCommand(cmd)
}

func (a *App) runRestore(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool restore <bundle> <host> [backup-ref]")
	}
	bundle, host := args[0], args[1]
	ref := ""
	if len(args) >= 3 {
		ref = args[2]
	}
	manager, err := a.newDeployManager(bundle, host)
	if err != nil {
		return err
	}
	result, err := manager.Restore(context.Background(), bundle, host, ref)
	if err != nil {
		var manual *engine.ManualRestoreError
		if errors.As(err, &manual) {
			data := map[string]interface{}{
				"bundle":      bundle,
				"host":        host,
				"status":      "manual",
				"backup_dirs": manual.BackupDirs,
			}
			if jsonFlag {
				_ = writeJSON(cmd.OutOrStdout(), data, []string{err.Error()})
			} else {
				fmt.Printf("manual restore required for %s @ %s\n", bundle, host)
				for _, dir := range manual.BackupDirs {
					fmt.Printf("  artifact: %s\n", dir)
				}
			}
			return &ExitError{Code: ExitApproval, Kind: "manual_restore_required", Err: err, Silent: true}
		}
		return newExitError(ExitFailed, "execution_failed", err)
	}
	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), result, result.Warnings)
	}
	fmt.Printf("restore %s @ %s: %s\n", result.Bundle, result.Host, result.Status)
	return nil
}
