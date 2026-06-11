package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addStackCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "stack <host>",
		Short: "安装二进制服务栈 (caddy, headscale, etc.)",
		Long: `安装主机配置的基础二进制服务栈。

示例:
  ./spool stack txhk`,
		RunE: a.runStack,
	}
	root.AddCommand(cmd)
}

func (a *App) runStack(cmd *cobra.Command, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool stack <host>")
	}

	mgr, err := engine.NewInstallManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init install manager: %w", err)
	}

	return mgr.InstallStack(args[0])
}