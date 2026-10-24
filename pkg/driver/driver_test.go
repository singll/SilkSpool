package driver_test

import (
	"fmt"
	"testing"

	"github.com/singll/silkspool/pkg/driver"
)

type fakeDriver struct {
	version string
}

func (f *fakeDriver) ProtocolVersion() string { return f.version }
func (f *fakeDriver) Capabilities() []driver.Capability {
	return []driver.Capability{driver.CapStatus}
}
func (f *fakeDriver) Setup(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return nil
}
func (f *fakeDriver) Up(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return nil
}
func (f *fakeDriver) Down(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return nil
}
func (f *fakeDriver) Status(host string, hostCfg *driver.HostConfig, deployPath string) error {
	return nil
}
func (f *fakeDriver) Cleanup(host string, hostCfg *driver.HostConfig, deployPath string, mode string) error {
	return nil
}
func (f *fakeDriver) Service(host string, hostCfg *driver.HostConfig, deployPath string, svc string, action string) error {
	return nil
}
func (f *fakeDriver) Upgrade(host string, hostCfg *driver.HostConfig, deployPath string, force bool) error {
	return nil
}

func TestRegistryAndCapabilities(t *testing.T) {
	name := fmt.Sprintf("test-%s", t.Name())
	err := driver.Register(name, func(opts driver.Options) driver.BundleDriver {
		return &fakeDriver{version: driver.ProtocolVersion}
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	d, err := driver.Get(name, driver.Options{BaseDir: t.TempDir(), BundleName: "demo"})
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if d.ProtocolVersion() != driver.ProtocolVersion {
		t.Errorf("protocol = %q", d.ProtocolVersion())
	}
	if !driver.Supports(d, driver.CapStatus) {
		t.Error("expected status capability")
	}
	if driver.Supports(d, driver.CapPlan) {
		t.Error("fake driver should not support plan")
	}
	if err := driver.Register(name, func(opts driver.Options) driver.BundleDriver {
		return &fakeDriver{version: driver.ProtocolVersion}
	}); err == nil {
		t.Error("duplicate registration should fail")
	}
}

func TestRegistryRejectsUnsupportedProtocol(t *testing.T) {
	name := fmt.Sprintf("bad-%s", t.Name())
	if err := driver.Register(name, func(opts driver.Options) driver.BundleDriver {
		return &fakeDriver{version: "spool-driver/v0"}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := driver.Get(name, driver.Options{BaseDir: t.TempDir(), BundleName: "demo"}); err == nil {
		t.Error("expected protocol version error")
	}
}
