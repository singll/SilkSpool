package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addKeyCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "key <command>",
		Short: "SSH 管控密钥管理",
		Long: `管理 spool 用于访问受管控主机的 SSH 密钥。

命令:
  rotate            在所有受管控主机上轮换 SSH 密钥 (旧 -> 新)
  status [host]     检查每台主机是否已授权当前公钥

rotate 采用两阶段、全有或全无的安全时序: 先在每台主机部署并验证新密钥，
全部通过后才切换本地密钥并移除远程旧密钥，过程中不会把自己锁在门外。
若有主机已永久失联，请先 decommission 该主机再 rotate。

示例:
  ./spool key status --all
  ./spool key rotate --dry-run     # 预演 (不修改任何内容)
  ./spool key rotate               # 自动生成新 ed25519 密钥并轮换
  ./spool key rotate --new ./keys/id_new --keep-old-remote`,
		RunE: a.runKey,
	}
	cmd.Flags().String("new", "", "指定新私钥路径 (默认自动生成 ed25519)")
	cmd.Flags().Bool("keep-old-remote", false, "保留远程旧公钥作为兜底 (不移除)")
	cmd.Flags().Bool("dry-run", false, "仅验证可达性并打印计划，不修改任何内容")
	cmd.Flags().Bool("all", false, "key status: 检查所有主机")
	cmd.Flags().Bool("yes", false, "跳过危险操作二次确认")
	root.AddCommand(cmd)
}

func (a *App) runKey(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		_ = cmd.Help()
		return nil
	}

	mgr, err := engine.NewKeyManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init key manager: %w", err)
	}

	switch args[0] {
	case "rotate":
		newKey, _ := cmd.Flags().GetString("new")
		keepOld, _ := cmd.Flags().GetBool("keep-old-remote")
		dryRun, _ := cmd.Flags().GetBool("dry-run")
		assumeYes, _ := cmd.Flags().GetBool("yes")
		return mgr.Rotate(engine.RotateOptions{
			NewKeyPath:    newKey,
			KeepOldRemote: keepOld,
			DryRun:        dryRun,
			AssumeYes:     assumeYes,
		})
	case "status":
		var hosts []string
		if all, _ := cmd.Flags().GetBool("all"); !all && len(args) > 1 {
			hosts = args[1:]
		}
		return mgr.Status(hosts)
	default:
		_ = cmd.Help()
		return nil
	}
}

func (a *App) addDecommissionCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:     "decommission <host>",
		Aliases: []string{"unmanage"},
		Short:   "解除主机管控 (吊销 SSH 访问)",
		Long: `把主机从 SilkSpool 管控中下线: 从远程 authorized_keys 移除 spool 公钥，
使 spool 不再能登录该主机。与 init (接入) 对称。

默认不修改配置文件，只打印需手动清理的内容。
加 --purge-config 才会从 silkspool.yaml 删除该主机块 (保留其它主机注释，先写 .bak 备份)。

示例:
  ./spool decommission bili-node
  ./spool decommission bili-node --purge-config --yes`,
		RunE: a.runDecommission,
	}
	cmd.Flags().Bool("purge-config", false, "同时从 silkspool.yaml 删除该主机块")
	cmd.Flags().Bool("yes", false, "跳过危险操作二次确认")
	root.AddCommand(cmd)
}

func (a *App) runDecommission(cmd *cobra.Command, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool decommission <host> [--purge-config] [--yes]")
	}

	mgr, err := engine.NewKeyManager(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to init key manager: %w", err)
	}

	purge, _ := cmd.Flags().GetBool("purge-config")
	assumeYes, _ := cmd.Flags().GetBool("yes")
	return mgr.Decommission(args[0], engine.DecommissionOptions{
		PurgeConfig: purge,
		AssumeYes:   assumeYes,
	})
}