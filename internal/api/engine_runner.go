package api

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/engine"
)

// EngineRunner 把 HTTP action 映射到 engine.Manager。
type EngineRunner struct {
	BaseDir    string
	Config     *config.Config
	SSHKey     string
	KnownHosts string
}

// Run 执行 action；apply/rollback 使用 10 分钟 host lock 等待，实现同 host 排队。
func (r *EngineRunner) Run(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error) {
	if r.Config == nil {
		return nil, fmt.Errorf("config is required")
	}
	hostCfg := r.Config.GetHost(target.Host)
	if hostCfg == nil {
		return nil, fmt.Errorf("unknown host: %s", target.Host)
	}

	if action == "bundle.plan" && opts.Offline {
		manager := engine.NewManager(r.BaseDir, r.Config, nil)
		return manager.Plan(ctx, target.Bundle, target.Host, engine.PlanOptions{
			Offline: true,
			Inputs:  opts.Inputs,
		})
	}

	client, err := engine.NewSSHClient(hostCfg.Address, r.SSHKey, sshOptions(hostCfg.SSHPort, r.KnownHosts)...)
	if err != nil {
		return nil, err
	}
	if err := client.Connect(); err != nil {
		return nil, fmt.Errorf("SSH connect failed: %w", err)
	}
	defer client.Close()
	manager := engine.NewManager(r.BaseDir, r.Config, engine.NewSSHRunner(client))
	manager.HostLockTimeout = 10 * time.Minute
	manager.SyncFunc = func() error {
		bundleManager, err := engine.NewBundleManager(r.BaseDir)
		if err != nil {
			return err
		}
		_ = bundleManager.InitBundleDefaults(target.Bundle, target.Host)
		syncManager, err := engine.NewSyncManager(r.BaseDir)
		if err != nil {
			return err
		}
		if err := syncManager.SyncHost(target.Host, "push"); err != nil {
			return err
		}
		return syncManager.SyncBundle(target.Host, target.Bundle, bundleManager.DeployPath(target.Bundle))
	}

	switch action {
	case "bundle.plan":
		return manager.Plan(ctx, target.Bundle, target.Host, engine.PlanOptions{Inputs: opts.Inputs})
	case "bundle.apply":
		return manager.Apply(ctx, target.Bundle, target.Host, engine.ApplyOptions{
			Locked:            opts.Locked,
			DryRun:            opts.DryRun,
			Yes:               true,
			AllowIrreversible: opts.AllowIrreversible,
			Inputs:            opts.Inputs,
		})
	case "bundle.rollback":
		return manager.Rollback(ctx, target.Bundle, target.Host, opts.Generation)
	default:
		return nil, fmt.Errorf("unsupported action %q", action)
	}
}

func sshOptions(port, knownHosts string) []engine.SSHClientOption {
	options := []engine.SSHClientOption{engine.WithKnownHosts(knownHosts)}
	if port != "" {
		options = append(options, engine.WithSSHPort(port))
	}
	return options
}

// ResolveSSHKey 返回配置中的 SSH 私钥路径。
func ResolveSSHKey(baseDir string, cfg *config.Config) string {
	if cfg == nil {
		return ""
	}
	return config.ResolveSSHKeyPath(baseDir, cfg.Global.SSHKeyPath)
}

// KnownHostsPath 返回 known_hosts 路径。
func KnownHostsPath(baseDir string) string {
	return filepath.Join(baseDir, "known_hosts")
}
