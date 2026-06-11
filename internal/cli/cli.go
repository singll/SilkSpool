package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/engine"
)

var (
	Version   = "1.0.0"
	BuildTime = "unknown"
	GitCommit = "unknown"
)

type App struct {
	BaseDir string
	Config  *config.Config
}

func NewApp(baseDir string) *App {
	return &App{BaseDir: baseDir}
}

func (a *App) LoadConfig() error {
	if a.Config != nil {
		return nil
	}
	cfg, err := config.LoadConfig(a.BaseDir)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}
	a.Config = cfg
	return nil
}

func (a *App) SSHKeyPath() (string, error) {
	if err := a.LoadConfig(); err != nil {
		return "", err
	}
	return config.ResolveSSHKeyPath(a.BaseDir, a.Config.Global.SSHKeyPath), nil
}

func NewRootCmd() *cobra.Command {
	app := &App{}

	root := &cobra.Command{
		Use:          "spool",
		Short:        "SilkSpool V2 - 云基础设施编排 CLI 工具",
		Long: `SilkSpool (丝轴) - 云基础设施编排工具
基于 Go 重构，提供跨平台支持

主要功能:
  - 配置文件同步 (sync pull/push)
  - DNS 记录管理 (dns add/remove/push)
  - 站点快速部署 (site deploy)
  - Bundle 编排 (bundle <name> <action> <host>)
  - n8n 工作流管理 (n8n list/import/export)
  - TrueNAS 存储管理 (nas info/pool/dataset)
  - 主机接入/下线 (init / decommission)
  - SSH 管控密钥轮换 (key rotate/status)

使用 ./spool --help 查看完整帮助`,
		SilenceUsage: true,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			app.BaseDir = resolveBaseDir()
			knownHosts := filepath.Join(app.BaseDir, "known_hosts")
			sshKey, err := app.SSHKeyPath()
			if err == nil && sshKey != "" {
				engine.InitGlobalPool(
					engine.WithKnownHosts(knownHosts),
				)
			} else {
				engine.InitGlobalPool()
			}
			return nil
		},
	}

	root.PersistentFlags().BoolVarP(&verboseFlag, "verbose", "v", false, "verbose output")
	root.PersistentFlags().StringVar(&configFlag, "config", "", "config file path (default: silkspool.yaml)")

	root.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "显示版本信息",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Printf("SilkSpool V%s\n", Version)
			fmt.Printf("  Build: %s (%s)\n", GitCommit, BuildTime)
		},
	})

	app.addInitCmd(root)
	app.addSyncCmd(root)
	app.addDNSCmd(root)
	app.addSiteCmd(root)
	app.addBundleCmd(root)
	app.addStackCmd(root)
	app.addServiceCmd(root)
	app.addN8NCmd(root)
	app.addNASCmd(root)
	app.addBackupCmd(root)
	app.addExecCmd(root)
	app.addKeyCmd(root)
	app.addDecommissionCmd(root)

	return root
}

var (
	verboseFlag bool
	configFlag  string
)

func resolveBaseDir() string {
	if configFlag != "" {
		if filepath.IsAbs(configFlag) {
			return filepath.Dir(configFlag)
		}
		cwd, err := os.Getwd()
		if err == nil {
			return filepath.Dir(filepath.Join(cwd, configFlag))
		}
		return filepath.Dir(configFlag)
	}

	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		if isValidSpoolDir(exeDir) {
			return exeDir
		}
	}

	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}

	return "."
}

func isValidSpoolDir(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "bundles")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(dir, "silkspool.yaml")); err == nil {
		return true
	}
	return false
}
