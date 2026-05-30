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
}

// driverRegistry bundle 驱动注册表
var driverRegistry = map[string]func(baseDir, sshKey string) BundleDriver{
	"compose": func(baseDir, sshKey string) BundleDriver {
		return NewComposeDriver(baseDir, sshKey)
	},
	"stack": func(baseDir, sshKey string) BundleDriver {
		return NewStackDriver(baseDir, sshKey)
	},
}

// GetDriver 根据类型获取对应的 bundle 驱动
func GetDriver(driverType string, baseDir, sshKey string) (BundleDriver, error) {
	factory, ok := driverRegistry[driverType]
	if !ok {
		return nil, fmt.Errorf("unknown bundle driver type: %s", driverType)
	}
	return factory(baseDir, sshKey), nil
}

// RegisterDriver 注册自定义驱动（用于扩展）
func RegisterDriver(name string, factory func(baseDir, sshKey string) BundleDriver) {
	driverRegistry[name] = factory
}
