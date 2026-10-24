// Package driver 是公开的 bundle 驱动接口（编译期注册，P1 不做进程外插件）。
// 该包不依赖 internal/*，外部消费者可以实现或包装驱动。
package driver

import (
	"fmt"
	"sort"
	"sync"
)

// ProtocolVersion 是驱动接口版本；internal/engine 实现必须在加载时注册。
const ProtocolVersion = "spool-driver/v1"

// Capability 描述驱动支持的动词。
type Capability string

const (
	CapStatus   Capability = "status"
	CapPlan     Capability = "plan"
	CapApply    Capability = "apply"
	CapRollback Capability = "rollback"
	CapHealth   Capability = "health"
	CapBackup   Capability = "backup"
	CapRestore  Capability = "restore"
	CapUpgrade  Capability = "upgrade"
)

// HostConfig 是公开的驱动主机视图（substrate 不需要完整 internal 配置）。
type HostConfig struct {
	Address   string
	SSHPort   string
	AppPrefix string
	MagicDNS  string
	Stack     []string
}

// Defaults 是公开的驱动默认值。
type Defaults struct {
	LogLines     int
	DockerLogMax string
	DockerLogNum int
	DeployPath   string
	ComposeVer   string
}

// Options 是驱动工厂输入。
type Options struct {
	BaseDir    string
	SSHKey     string
	BundleName string
	Defaults   Defaults
}

// BundleDriver 是公开驱动接口，保留旧方法形态以兼容现有调用。
type BundleDriver interface {
	ProtocolVersion() string
	Capabilities() []Capability

	Setup(host string, hostCfg *HostConfig, deployPath string) error
	Up(host string, hostCfg *HostConfig, deployPath string) error
	Down(host string, hostCfg *HostConfig, deployPath string) error
	Status(host string, hostCfg *HostConfig, deployPath string) error
	Cleanup(host string, hostCfg *HostConfig, deployPath string, mode string) error
	Service(host string, hostCfg *HostConfig, deployPath string, svc string, action string) error
	Upgrade(host string, hostCfg *HostConfig, deployPath string, force bool) error
}

// Factory 创建驱动。
type Factory func(opts Options) BundleDriver

var (
	mu       sync.RWMutex
	registry = map[string]Factory{}
)

// Register 注册驱动；重复注册返回错误。
func Register(name string, factory Factory) error {
	if name == "" {
		return fmt.Errorf("driver name is empty")
	}
	if factory == nil {
		return fmt.Errorf("driver %s: factory is nil", name)
	}
	mu.Lock()
	defer mu.Unlock()
	if _, ok := registry[name]; ok {
		return fmt.Errorf("driver %s already registered", name)
	}
	registry[name] = factory
	return nil
}

// Get 按名字创建驱动，并校验协议版本。
func Get(name string, opts Options) (BundleDriver, error) {
	mu.RLock()
	factory, ok := registry[name]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown bundle driver type: %s", name)
	}
	d := factory(opts)
	if d == nil {
		return nil, fmt.Errorf("driver %s: factory returned nil", name)
	}
	if d.ProtocolVersion() != ProtocolVersion {
		return nil, fmt.Errorf("driver %s: unsupported protocol %q (want %q)", name, d.ProtocolVersion(), ProtocolVersion)
	}
	return d, nil
}

// Registered 返回已注册驱动名（排序）。
func Registered() []string {
	mu.RLock()
	defer mu.RUnlock()
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Supports 判断驱动是否声明能力。
func Supports(d BundleDriver, capability Capability) bool {
	for _, item := range d.Capabilities() {
		if item == capability {
			return true
		}
	}
	return false
}
