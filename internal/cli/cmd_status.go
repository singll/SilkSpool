package cli

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addStatusCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "status <bundle> <host>",
		Short: "查看 bundle 的统一资源状态（可 --json）",
		RunE:  a.runResourceStatus,
	}
	root.AddCommand(cmd)
}

func (a *App) runResourceStatus(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool status <bundle> <host> [--json]")
	}
	bundle, host := args[0], args[1]
	if err := a.LoadConfig(); err != nil {
		return err
	}
	manager := engine.NewManager(a.BaseDir, a.Config, nil)
	resource := engine.NewBundleResource(manager, bundle, host)
	status, err := resource.Status(context.Background())
	if err != nil {
		return err
	}
	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), status, nil)
	}
	fmt.Printf("%s %s @ %s: %s", status.Kind, status.Name, status.Host, status.Status)
	if status.Generation > 0 {
		fmt.Printf(" (generation %d)", status.Generation)
	}
	fmt.Println()
	for key, value := range status.Outputs {
		fmt.Printf("  output %s = %s\n", key, value)
	}
	return nil
}
