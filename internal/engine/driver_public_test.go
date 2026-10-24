package engine

import (
	"testing"

	"github.com/singll/silkspool/pkg/driver"
)

func TestBuiltinDriversRegistered(t *testing.T) {
	registered := driver.Registered()
	for _, name := range []string{"compose", "stack", "script"} {
		found := false
		for _, item := range registered {
			if item == name {
				found = true
			}
		}
		if !found {
			t.Errorf("driver %s not registered: %v", name, registered)
		}
	}
	for _, name := range []string{"compose", "stack", "script"} {
		d, err := driver.Get(name, driver.Options{BaseDir: t.TempDir(), BundleName: "demo"})
		if err != nil {
			t.Errorf("Get(%s): %v", name, err)
			continue
		}
		if d.ProtocolVersion() != driver.ProtocolVersion {
			t.Errorf("%s protocol = %q", name, d.ProtocolVersion())
		}
	}
	compose, _ := driver.Get("compose", driver.Options{BaseDir: t.TempDir(), BundleName: "demo"})
	if !driver.Supports(compose, driver.CapPlan) || !driver.Supports(compose, driver.CapRollback) {
		t.Errorf("compose capabilities = %v", compose.Capabilities())
	}
	script, _ := driver.Get("script", driver.Options{BaseDir: t.TempDir(), BundleName: "demo"})
	if driver.Supports(script, driver.CapPlan) {
		t.Error("script driver must not claim plan capability")
	}
}
