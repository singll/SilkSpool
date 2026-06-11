package cli

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/pkg/utils"
)

func (a *App) addBackupCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "backup <host>",
		Short: "备份主机数据",
		Long: `备份远程主机的 Docker 卷和配置目录。

示例:
  ./spool backup keeper
  ./spool backup all`,
		RunE: a.runBackup,
	}
	root.AddCommand(cmd)
}

func (a *App) runBackup(cmd *cobra.Command, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: spool backup <host|all>")
	}

	cfg, err := config.LoadConfig(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}
	sshKey := filepath.Join(a.BaseDir, cfg.Global.SSHKeyPath)

	runOne := func(host string, hostCfg *config.HostConfig) error {
		if len(hostCfg.Backups) == 0 {
			utils.Warn("No backup rules for %s, skipping", host)
			return nil
		}
		mgr := engine.NewBackupManagerFromConfig(host, hostCfg)
		sshTimeout := config.ParseDuration(cfg.Global.Timeouts.SSHConnect, 30*time.Second)
		client, err := engine.NewSSHClient(hostCfg.Address, sshKey, engine.WithTimeout(sshTimeout))
		if err != nil {
			utils.Error("SSH client failed for %s: %v", host, err)
			return nil
		}
		defer client.Close()
		mgr.SetSSHClient(client)

		results, err := mgr.Run(context.Background())
		if err != nil {
			utils.Error("Backup %s failed: %v", host, err)
			return nil
		}
		utils.Success("Backup %s -> %s (%d items)", host, mgr.LocalDir(), len(results))
		return nil
	}

	if args[0] == "all" {
		for host := range cfg.Hosts {
			hc := cfg.GetHost(host)
			if err := runOne(host, hc); err != nil {
				return err
			}
		}
		return nil
	}

	hc := cfg.GetHost(args[0])
	if hc == nil {
		return fmt.Errorf("unknown host: %s", args[0])
	}
	return runOne(args[0], hc)
}
