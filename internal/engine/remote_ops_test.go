package engine

import (
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestGetDriver(t *testing.T) {
	tests := []struct {
		driverType string
		wantErr    bool
	}{
		{"compose", false},
		{"stack", false},
		{"unknown", true},
	}

	for _, tt := range tests {
		t.Run(tt.driverType, func(t *testing.T) {
			d, err := GetDriver(tt.driverType, "/base", "/key", "test", config.DefaultsConfig{})
			if (err != nil) != tt.wantErr {
				t.Errorf("GetDriver(%q) error = %v, wantErr %v", tt.driverType, err, tt.wantErr)
				return
			}
			if !tt.wantErr && d == nil {
				t.Errorf("GetDriver(%q) returned nil driver", tt.driverType)
			}
		})
	}
}

func TestRegisterDriver(t *testing.T) {
	customCalled := false
	factory := func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) BundleDriver {
		customCalled = true
		return &ComposeDriver{}
	}

	RegisterDriver("custom-test", factory)
	defer func() {
		delete(driverRegistry, "custom-test")
	}()

	d, err := GetDriver("custom-test", "/base", "/key", "test", config.DefaultsConfig{})
	if err != nil {
		t.Fatalf("GetDriver(custom-test) error: %v", err)
	}
	if d == nil {
		t.Error("GetDriver(custom-test) returned nil")
	}
	if !customCalled {
		t.Error("custom factory was not called")
	}
}

func TestCreateDockerNetworkEmpty(t *testing.T) {
	re := &RemoteExecutor{}
	err := re.CreateDockerNetwork("")
	if err != nil {
		t.Errorf("CreateDockerNetwork('') should return nil, got %v", err)
	}
}

func TestBundleDriverInterface(t *testing.T) {
	var _ BundleDriver = &ComposeDriver{}
	var _ BundleDriver = &StackDriver{}
}

func TestNewComposeDriverTypes(t *testing.T) {
	d1 := NewComposeDriver("/b", "/k", "bundle")
	if d1.bundleName != "bundle" {
		t.Errorf("bundleName = %q, want %q", d1.bundleName, "bundle")
	}
	d2 := NewComposeDriverWithDefaults("/b", "/k", "bundle", config.DefaultsConfig{LogLines: 50})
	if d2.defaults.LogLines != 50 {
		t.Errorf("LogLines = %d, want 50", d2.defaults.LogLines)
	}
}

func TestNewStackDriverTypes(t *testing.T) {
	d1 := NewStackDriver("/b", "/k", "bundle")
	if d1.bundleName != "bundle" {
		t.Errorf("bundleName = %q, want %q", d1.bundleName, "bundle")
	}
	d2 := NewStackDriverWithDefaults("/b", "/k", "bundle", config.DefaultsConfig{DeployPath: "/opt"})
	if d2.defaults.DeployPath != "/opt" {
		t.Errorf("DeployPath = %q, want %q", d2.defaults.DeployPath, "/opt")
	}
}

func TestStackDriverCleanup(t *testing.T) {
	d := &StackDriver{}
	err := d.Cleanup("host", nil, "/path", "normal")
	if err != nil {
		t.Errorf("Cleanup should always return nil, got %v", err)
	}
}