package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addStackCmd(root *cobra.Command) {
	var force, dryRun bool
	cmd := &cobra.Command{
		Use:   "stack <host>",
		Short: "安装二进制服务栈 (caddy, headscale, etc.)",
		Long: `安装主机配置的基础二进制服务栈。

支持多种打包格式（tar.gz / tar.xz / tar.zst / zip / zst / gz / 裸 ELF），
按文件名后缀自动探测，可用 install_sources.format 字段覆盖。
安装源可用 repo（GitHub/GitLab release）或 url（任意直链），可选 sha256 校验完整性。

示例:
  ./spool stack txhk
  ./spool stack txhk --dry-run   # 只解析版本/URL/格式并打印，不执行安装（仍会探测远程架构）
  ./spool stack txhk --force     # 忽略版本标记强制重装`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runStack(cmd, args, force, dryRun)
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "忽略幂等检查，强制重装")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "只解析版本/URL/格式并打印，不执行安装（仍会探测远程架构）")
	root.AddCommand(cmd)
}

func (a *App) runStack(cmd *cobra.Command, args []string, force, dryRun bool) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool stack <host>")
	}

	mgr, err := engine.NewInstallManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init install manager: %w", err)
	}

	return mgr.InstallStackWithOptions(args[0], engine.InstallOptions{Force: force, DryRun: dryRun})
}
