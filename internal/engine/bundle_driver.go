package engine

import (
	"fmt"

	"github.com/singll/silkspool/internal/config"
)

// BundleDriver 定义 bundle 部署驱动的接口
type BundleDriver interface {
	Setup(host string, hostCfg *config.HostConfig, deployPath string) error
	Up(host string, hostCfg *config.HostConfig, deployPath string) error
	Down(host string, hostCfg *config.HostConfig, deployPath string) error
	Status(host string, hostCfg *config.HostConfig, deployPath string) error
	Cleanup(host string, hostCfg *config.HostConfig, deployPath string, mode string) error
	Service(host string, hostCfg *config.HostConfig, deployPath string, svc string, action string) error
	Upgrade(host string, hostCfg *config.HostConfig, deployPath string, force bool) error
}

// driverRegistry bundle 驱动注册表
var driverRegistry = map[string]func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver{
	"compose": func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver {
		return NewComposeDriverWithDefaults(baseDir, sshKey, bundleName, defaults)
	},
	"stack": func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver {
		return NewStackDriverWithDefaults(baseDir, sshKey, bundleName, defaults)
	},
	"script": func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver {
		return NewScriptDriverWithDefaults(baseDir, sshKey, bundleName, defaults)
	},
}

func GetDriver(driverType string, baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) (BundleDriver, error) {
	factory, ok := driverRegistry[driverType]
	if !ok {
		return nil, fmt.Errorf("unknown bundle driver type: %s", driverType)
	}
	return factory(baseDir, sshKey, bundleName, defaults), nil
}

func RegisterDriver(name string, factory func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver) {
	driverRegistry[name] = factory
}
