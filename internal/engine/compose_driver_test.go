package engine

import (
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestComposeDriverFiles(t *testing.T) {
	d := NewComposeDriver("/base", "/key", "mybundle")
	if got := d.composeFile("/opt/demo"); got != "/opt/demo/docker-compose.yaml" {
		t.Errorf("composeFile = %q", got)
	}
	if got := d.overrideFile("/opt/demo"); got != "/opt/demo/docker-compose.spool.yaml" {
		t.Errorf("overrideFile = %q", got)
	}
}

func TestNewComposeDriver(t *testing.T) {
	d := NewComposeDriver("/base", "/key", "mybundle")
	if d.baseDir != "/base" {
		t.Errorf("baseDir = %q, want %q", d.baseDir, "/base")
	}
	if d.sshKey != "/key" {
		t.Errorf("sshKey = %q, want %q", d.sshKey, "/key")
	}
	if d.bundleName != "mybundle" {
		t.Errorf("bundleName = %q, want %q", d.bundleName, "mybundle")
	}
}

func TestNewComposeDriverWithDefaults(t *testing.T) {
	defaults := config.DefaultsConfig{LogLines: 100}
	d := NewComposeDriverWithDefaults("/base", "/key", "mybundle", defaults)
	if d.defaults.LogLines != 100 {
		t.Errorf("defaults.LogLines = %d, want 100", d.defaults.LogLines)
	}
}
