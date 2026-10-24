package cli

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/engine"
)

func (a *App) addAdoptCmd(root *cobra.Command) {
	var (
		bundle string
		class  string
		dryRun bool
		force  bool
	)
	cmd := &cobra.Command{
		Use:   "adopt <host>",
		Short: "纳管既有 compose stack（不重建容器）",
		Long: `发现目标 host 上已存在的 compose 项目，生成 manifest/state/lock。

默认只执行只读 docker 命令：不会 stop/start/recreate 任何容器，也不会修改远程文件。
--dry-run 只展示发现结果，不写任何本地文件。
已有 manifest/state/lock 时必须显式 --force 才会覆盖。`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runAdopt(cmd, args, engine.AdoptOptions{
				Bundle: bundle,
				Class:  class,
				DryRun: dryRun,
				Force:  force,
			})
		},
	}
	cmd.Flags().StringVar(&bundle, "bundle", "", "要纳管的 compose project / bundle 名（多项目时必填）")
	cmd.Flags().StringVar(&class, "class", "composition", "生成的 bundle class")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "只展示发现结果，不写本地文件")
	cmd.Flags().BoolVar(&force, "force", false, "覆盖已有 manifest/state/lock")
	root.AddCommand(cmd)
}

func (a *App) runAdopt(cmd *cobra.Command, args []string, opts engine.AdoptOptions) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool adopt <host> [--bundle <name>] [--dry-run] [--json]")
	}
	host := args[0]
	if err := a.LoadConfig(); err != nil {
		return err
	}
	hostCfg := a.Config.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("unknown host: %s", host)
	}
	sshKey, err := a.SSHKeyPath()
	if err != nil {
		return err
	}
	knownHosts := filepath.Join(a.BaseDir, "known_hosts")
	options := []engine.SSHClientOption{engine.WithKnownHosts(knownHosts)}
	if hostCfg.SSHPort != "" {
		options = append(options, engine.WithSSHPort(hostCfg.SSHPort))
	}
	client, err := engine.NewSSHClient(hostCfg.Address, sshKey, options...)
	if err != nil {
		return err
	}
	if err := client.Connect(); err != nil {
		return fmt.Errorf("SSH connect failed: %w", err)
	}
	defer client.Close()

	manager := engine.NewManager(a.BaseDir, a.Config, engine.NewSSHRunner(client))
	report, err := manager.Adopt(context.Background(), host, opts)
	if err != nil {
		return newExitError(ExitFailed, "execution_failed", err)
	}
	if jsonFlag {
		return writeJSON(cmd.OutOrStdout(), report, report.Warnings)
	}
	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "adopt %s: project=%s bundle=%s deploy=%s\n", report.Host, report.Project, report.Bundle, report.DeployPath)
	for _, container := range report.Containers {
		stateful := ""
		if container.Stateful {
			stateful = " stateful"
		}
		fmt.Fprintf(out, "  container %s (%s) %s%s\n", container.Service, container.Name, container.State, stateful)
	}
	for _, volume := range report.Volumes {
		fmt.Fprintf(out, "  volume %s\n", volume.Name)
	}
	for _, network := range report.Networks {
		fmt.Fprintf(out, "  network %s\n", network.Name)
	}
	if len(report.Stateful) > 0 {
		fmt.Fprintf(out, "  preserved stateful services: %v\n", report.Stateful)
	}
	if report.DryRun {
		fmt.Fprintf(out, "  dry-run: no files written (manifest=%s)\n", report.ManifestPath)
	} else if report.Written {
		fmt.Fprintf(out, "  wrote %s\n  wrote %s\n  wrote %s\n", report.ManifestPath, report.StatePath, report.LockPath)
	}
	for _, warning := range report.Warnings {
		fmt.Fprintf(out, "  warning: %s\n", warning)
	}
	return nil
}
