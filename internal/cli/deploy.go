package cli

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/singll/silkspool/internal/engine"
	"github.com/singll/silkspool/pkg/utils"
)

func (a *App) newDeployManager(bundle, host string) (*engine.Manager, error) {
	if err := a.LoadConfig(); err != nil {
		return nil, err
	}
	hostCfg := a.Config.GetHost(host)
	if hostCfg == nil {
		return nil, fmt.Errorf("unknown host: %s", host)
	}
	sshKey, err := a.SSHKeyPath()
	if err != nil {
		return nil, err
	}
	sshPort := hostCfg.SSHPort
	knownHosts := filepath.Join(a.BaseDir, "known_hosts")
	var client *engine.SSHClient
	if sshPort != "" {
		client, err = engine.NewSSHClient(hostCfg.Address, sshKey, engine.WithSSHPort(sshPort), engine.WithKnownHosts(knownHosts))
	} else {
		client, err = engine.NewSSHClient(hostCfg.Address, sshKey, engine.WithKnownHosts(knownHosts))
	}
	if err != nil {
		return nil, err
	}
	if err := client.Connect(); err != nil {
		return nil, fmt.Errorf("SSH connect failed: %w", err)
	}
	manager := engine.NewManager(a.BaseDir, a.Config, engine.NewSSHRunner(client))
	manager.SyncFunc = func() error {
		bundleManager, err := engine.NewBundleManager(a.BaseDir)
		if err != nil {
			return err
		}
		_ = bundleManager.InitBundleDefaults(bundle, host)
		syncManager, err := engine.NewSyncManager(a.BaseDir)
		if err != nil {
			return err
		}
		if err := syncManager.SyncHost(host, "push"); err != nil {
			return err
		}
		return syncManager.SyncBundle(host, bundle, bundleManager.DeployPath(bundle))
	}
	return manager, nil
}

var runnerFactory = func(address, sshKey, sshPort, knownHosts string) (engine.RemoteRunner, error) {
	opts := []engine.SSHClientOption{engine.WithKnownHosts(knownHosts)}
	if sshPort != "" {
		opts = append(opts, engine.WithSSHPort(sshPort))
	}
	client, err := engine.NewSSHClient(address, sshKey, opts...)
	if err != nil {
		return nil, err
	}
	if err := client.Connect(); err != nil {
		return nil, err
	}
	return engine.NewSSHRunner(client), nil
}

func (a *App) newPlanManager(host string, offline bool) (*engine.Manager, error) {
	if err := a.LoadConfig(); err != nil {
		return nil, err
	}
	if offline {
		return engine.NewManager(a.BaseDir, a.Config, nil), nil
	}
	hostCfg := a.Config.GetHost(host)
	if hostCfg == nil {
		return nil, fmt.Errorf("unknown host: %s", host)
	}
	sshKey, err := a.SSHKeyPath()
	if err != nil {
		return nil, err
	}
	runner, err := runnerFactory(hostCfg.Address, sshKey, hostCfg.SSHPort, filepath.Join(a.BaseDir, "known_hosts"))
	if err != nil {
		return nil, fmt.Errorf("SSH connect failed: %w", err)
	}
	return engine.NewManager(a.BaseDir, a.Config, runner), nil
}

func printPlan(result *engine.PlanResult) {
	fmt.Printf("plan %s @ %s (%s)\n", result.Bundle, result.Host, result.Mode)
	fmt.Printf("  deploy_path: %s\n", result.Desired.DeployPath)
	fmt.Printf("  lock_hash:   %s\n", result.Desired.LockHash)
	fmt.Printf("  components:  %v\n", result.Desired.Components)
	if len(result.Desired.Dependencies) > 0 {
		fmt.Printf("  dependencies (read-only): %v\n", result.Desired.Dependencies)
	}
	if len(result.Diff) == 0 {
		fmt.Println("  diff: none")
	} else {
		fmt.Println("  diff:")
		for _, entry := range result.Diff {
			fmt.Printf("    %-24s desired=%q actual=%q %s\n", entry.Field, entry.Desired, entry.Actual, entry.Detail)
		}
	}
	for _, warning := range result.Warnings {
		fmt.Printf("  warning: %s\n", warning)
	}
}

func printApply(result *engine.ApplyResult) {
	if result.Generation > 0 {
		fmt.Printf("apply %s @ %s: %s (generation %d)\n", result.Bundle, result.Host, result.Status, result.Generation)
	} else {
		fmt.Printf("apply %s @ %s: %s\n", result.Bundle, result.Host, result.Status)
	}
	if result.BackupDir != "" {
		fmt.Printf("  backup: %s\n", result.BackupDir)
	}
	if result.RolledBack {
		fmt.Println("  rolled back to previous generation")
	}
	if result.NeedsAttention {
		fmt.Println("  needs attention: automatic rollback disabled")
	}
	for _, warning := range result.Warnings {
		utils.Warn("%s", warning)
	}
}

func (a *App) applyForBundle(bundle, host string, opts engine.ApplyOptions) (*engine.ApplyResult, error) {
	manager, err := a.newDeployManager(bundle, host)
	if err != nil {
		return nil, err
	}
	return manager.Apply(context.Background(), bundle, host, opts)
}
