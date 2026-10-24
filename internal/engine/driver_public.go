package engine

import (
	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/driver"
)

// publicDriverAdapter 把 internal 驱动适配为 pkg/driver 公共接口。
type publicDriverAdapter struct {
	inner BundleDriver
	caps  []driver.Capability
}

var (
	_ driver.BundleDriver = (*publicDriverAdapter)(nil)
)

func (a *publicDriverAdapter) ProtocolVersion() string { return driver.ProtocolVersion }

func (a *publicDriverAdapter) Capabilities() []driver.Capability { return a.caps }

func toInternalHost(hostCfg *driver.HostConfig) *config.HostConfig {
	if hostCfg == nil {
		return &config.HostConfig{}
	}
	return &config.HostConfig{
		Address:   hostCfg.Address,
		SSHPort:   hostCfg.SSHPort,
		AppPrefix: hostCfg.AppPrefix,
		MagicDNS:  hostCfg.MagicDNS,
		Stack:     append([]string(nil), hostCfg.Stack...),
	}
}

func toInternalDefaults(defaults driver.Defaults) config.DefaultsConfig {
	return config.DefaultsConfig{
		LogLines:     defaults.LogLines,
		DockerLogMax: defaults.DockerLogMax,
		DockerLogNum: defaults.DockerLogNum,
		DeployPath:   defaults.DeployPath,
		ComposeVer:   defaults.ComposeVer,
	}
}

func (a *publicDriverAdapter) Setup(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return a.inner.Setup(host, toInternalHost(hostCfg), deployPath)
}

func (a *publicDriverAdapter) Up(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return a.inner.Up(host, toInternalHost(hostCfg), deployPath)
}

func (a *publicDriverAdapter) Down(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return a.inner.Down(host, toInternalHost(hostCfg), deployPath)
}

func (a *publicDriverAdapter) Status(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return a.inner.Status(host, toInternalHost(hostCfg), deployPath)
}

func (a *publicDriverAdapter) Cleanup(host string, hostCfg *driver.HostConfig, deployPath string, mode string) error {
	return a.inner.Cleanup(host, toInternalHost(hostCfg), deployPath, mode)
}

func (a *publicDriverAdapter) Service(host string, hostCfg *driver.HostConfig, deployPath string, svc string, action string) error {
	return a.inner.Service(host, toInternalHost(hostCfg), deployPath, svc, action)
}

func (a *publicDriverAdapter) Upgrade(host string, hostCfg *driver.HostConfig, deployPath string, force bool) error {
	return a.inner.Upgrade(host, toInternalHost(hostCfg), deployPath, force)
}

// Capabilities 返回 internal 驱动的能力（不依赖公共包）。
func (d *ComposeDriver) Capabilities() []driver.Capability {
	return []driver.Capability{
		driver.CapStatus, driver.CapPlan, driver.CapApply, driver.CapRollback,
		driver.CapHealth, driver.CapBackup, driver.CapRestore,
	}
}

func (d *StackDriver) Capabilities() []driver.Capability {
	return []driver.Capability{driver.CapStatus, driver.CapApply, driver.CapUpgrade}
}

func (d *ScriptDriver) Capabilities() []driver.Capability {
	return []driver.Capability{driver.CapStatus, driver.CapApply, driver.CapUpgrade}
}

func init() {
	registerPublic := func(name string, caps []driver.Capability, factory func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver) {
		_ = driver.Register(name, func(opts driver.Options) driver.BundleDriver {
			return &publicDriverAdapter{
				inner: factory(opts.BaseDir, opts.SSHKey, opts.BundleName, toInternalDefaults(opts.Defaults)),
				caps:  caps,
			}
		})
	}
	registerPublic("compose", []driver.Capability{
		driver.CapStatus, driver.CapPlan, driver.CapApply, driver.CapRollback,
		driver.CapHealth, driver.CapBackup, driver.CapRestore,
	}, func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver {
		return NewComposeDriverWithDefaults(baseDir, sshKey, bundleName, defaults)
	})
	registerPublic("stack", []driver.Capability{driver.CapStatus, driver.CapApply, driver.CapUpgrade},
		func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver {
			return NewStackDriverWithDefaults(baseDir, sshKey, bundleName, defaults)
		})
	registerPublic("script", []driver.Capability{driver.CapStatus, driver.CapApply, driver.CapUpgrade},
		func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver {
			return NewScriptDriverWithDefaults(baseDir, sshKey, bundleName, defaults)
		})
}

func (d *ComposeDriver) ProtocolVersion() string { return driver.ProtocolVersion }
func (d *StackDriver) ProtocolVersion() string   { return driver.ProtocolVersion }
func (d *ScriptDriver) ProtocolVersion() string  { return driver.ProtocolVersion }
