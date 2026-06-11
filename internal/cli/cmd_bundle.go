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
  service <svc> <action>  管理单个服务

示例:
  ./spool bundle keeper init keeper
  ./spool bundle keeper up keeper
  ./spool bundle keeper service keeper bellkeeper up`,
		RunE: a.runBundle,
	}
	cmd.Flags().Bool("yes", false, "跳过危险操作 (down/cleanup) 的二次确认")
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
		if !engine.ConfirmDestructive(action, fmt.Sprintf("bundle %s on %s", name, host), assumeYes) {
			utils.Warn("Aborted")
			return nil
		}
	}

	mgr, err := engine.NewBundleManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init bundle manager: %w", err)
	}

	if action == "service" {
		if len(args) < 5 {
			return fmt.Errorf("usage: spool bundle <name> service <host> <service> <action>")
		}
		svc := args[3]
		svcAction := args[4]
		return mgr.SetupBundleService(name, host, svc, svcAction)
	}

	return mgr.SetupBundle(name, host, action)
}