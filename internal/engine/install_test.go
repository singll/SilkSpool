package engine

import (
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestBuildDownloadURL(t *testing.T) {
	m := &InstallManager{}

	tests := []struct {
		name, repo, pattern, version, arch string
		wantContains                       string
	}{
		{
			"github release",
			"user/repo",
			"app_{VERSION}_{ARCH}.tar.gz",
			"v1.0.0",
			"amd64",
			"github.com/user/repo/releases/download/v1.0.0/app_v1.0.0_amd64.tar.gz",
		},
		{
			"gitlab release",
			"gitlab:org/project",
			"bin_{ARCH}",
			"v2.0.0",
			"arm64",
			"gitlab.com/org/project/-/releases/v2.0.0/downloads/bin_arm64",
		},
		{
			"pattern substitution",
			"user/tool",
			"tool-{VERSION}-{ARCH}.zip",
			"v3.0",
			"amd64",
			"tool-v3.0-amd64.zip",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := m.buildDownloadURL(tt.repo, tt.pattern, tt.version, tt.arch)
			if !strings.Contains(got, tt.wantContains) {
				t.Errorf("buildDownloadURL() = %q, should contain %q", got, tt.wantContains)
			}
		})
	}
}

func TestBuildDownloadURLGitHub(t *testing.T) {
	m := &InstallManager{}
	got := m.buildDownloadURL("owner/repo", "app_linux_amd64", "v1.0", "amd64")
	expected := "https://github.com/owner/repo/releases/download/v1.0/app_linux_amd64"
	if got != expected {
		t.Errorf("got %q, want %q", got, expected)
	}
}

func TestBuildDownloadURLGitLab(t *testing.T) {
	m := &InstallManager{}
	got := m.buildDownloadURL("gitlab:org/repo", "app_{ARCH}", "v2.0", "arm64")
	expected := "https://gitlab.com/org/repo/-/releases/v2.0/downloads/app_arm64"
	if got != expected {
		t.Errorf("got %q, want %q", got, expected)
	}
}

func TestBuildInstallScript(t *testing.T) {
	m := &InstallManager{}

	t.Run("tarball install", func(t *testing.T) {
		src := &config.InstallSource{Alias: "myapp"}
		script := m.buildInstallScript(src, "https://example.com/myapp.tar.gz", "v1.0", "amd64")
		if !strings.Contains(script, "tar -xzf") {
			t.Error("tarball script should contain tar -xzf")
		}
		if !strings.Contains(script, "/usr/local/bin/myapp") {
			t.Error("script should install to /usr/local/bin/myapp")
		}
	})

	t.Run("binary install", func(t *testing.T) {
		src := &config.InstallSource{Alias: "mybin"}
		script := m.buildInstallScript(src, "https://example.com/mybin", "v1.0", "amd64")
		if strings.Contains(script, "tar -xzf") {
			t.Error("binary script should not contain tar -xzf")
		}
		if !strings.Contains(script, "/usr/local/bin/mybin") {
			t.Error("script should install to /usr/local/bin/mybin")
		}
	})

	t.Run("with systemd service", func(t *testing.T) {
		src := &config.InstallSource{Alias: "mydaemon", ServiceName: "mydaemon"}
		script := m.buildInstallScript(src, "https://example.com/mydaemon", "v1.0", "amd64")
		if !strings.Contains(script, "/etc/systemd/system/mydaemon.service") {
			t.Error("script should create systemd service unit")
		}
		if !strings.Contains(script, "daemon-reload") {
			t.Error("script should run daemon-reload")
		}
	})
}
