package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/config"
)

func (a *App) addExecCmd(root *cobra.Command) {
	cmd := &cobra.Command{
		Use:   "exec <host> <command...>",
		Short: "在远程主机执行命令",
		Long: `在远程主机上执行任意命令。

示例:
  ./spool exec keeper docker ps
  ./spool exec txhk "systemctl status headscale"`,
		RunE: a.runExec,
	}
	root.AddCommand(cmd)
}

func (a *App) runExec(cmd *cobra.Command, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: spool exec <host> <command...>")
	}

	host := args[0]
	cfg, err := config.LoadConfig(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("unknown host: %s", host)
	}

	sshKey := filepath.Join(a.BaseDir, cfg.Global.SSHKeyPath)
	sshTimeout := config.ParseDuration(cfg.Global.Timeouts.SSHConnect, 30*time.Second)
	connectTimeout := int(sshTimeout.Seconds())
	if connectTimeout <= 0 {
		connectTimeout = 30
	}
	sshArgs := []string{"-i", sshKey, "-o", fmt.Sprintf("ConnectTimeout=%d", connectTimeout), "-t", hostCfg.Address}
	sshArgs = append(sshArgs, args[1:]...)

	c := exec.Command("ssh", sshArgs...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}