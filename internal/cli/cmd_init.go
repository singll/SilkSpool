package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addInitCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "init [host]",
		Short: "初始化主机 (SSH 信任 + Docker 权限)",
		Long: `初始化远程主机的 SSH 信任关系和 Docker 操作权限。

示例:
  ./spool init keeper      # 初始化 keeper 主机
  ./spool init --all       # 初始化所有主机`,
		RunE: a.runInit,
	}
	cmd.Flags().Bool("all", false, "初始化所有主机")
	root.AddCommand(cmd)
}

func (a *App) runInit(cmd *cobra.Command, args []string) error {
	mgr, err := engine.NewInitManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init: %w", err)
	}

	if all, _ := cmd.Flags().GetBool("all"); all {
		return mgr.RunAll()
	}

	if len(args) < 1 {
		return fmt.Errorf("usage: spool init <host> (or --all)")
	}
	return mgr.Run(args[0])
}