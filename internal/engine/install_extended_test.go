package engine

import (
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestBuildDownloadURLAllArchs(t *testing.T) {
	m := &InstallManager{}
	archs := []string{"amd64", "arm64", "armv7"}
	for _, arch := range archs {
		url := m.buildDownloadURL("user/repo", "app_{ARCH}", "v1.0", arch)
		if !strings.Contains(url, arch) {
			t.Errorf("URL for arch %q should contain arch: %q", arch, url)
		}
	}
}

func TestBuildDownloadURLVersionSubstitution(t *testing.T) {
	m := &InstallManager{}
	url := m.buildDownloadURL("user/repo", "app_{VERSION}_{ARCH}.tar.gz", "v2.5.0", "amd64")
	if !strings.Contains(url, "v2.5.0") {
		t.Errorf("URL should contain version v2.5.0: %q", url)
	}
	if !strings.Contains(url, "amd64") {
		t.Errorf("URL should contain arch amd64: %q", url)
	}
}

func TestBuildDownloadURLGitLabWithSubstitution(t *testing.T) {
	m := &InstallManager{}
	url := m.buildDownloadURL("gitlab:org/project", "bin_{VERSION}_{ARCH}", "v3.0", "arm64")
	if !strings.Contains(url, "gitlab.com/org/project") {
		t.Errorf("URL should contain gitlab base: %q", url)
	}
	if !strings.Contains(url, "v3.0") {
		t.Errorf("URL should contain version: %q", url)
	}
	if !strings.Contains(url, "arm64") {
		t.Errorf("URL should contain arch: %q", url)
	}
}

func TestBuildDownloadURLNoSubstitution(t *testing.T) {
	m := &InstallManager{}
	url := m.buildDownloadURL("user/repo", "static-binary", "v1.0", "amd64")
	if !strings.Contains(url, "static-binary") {
		t.Errorf("URL should contain static pattern: %q", url)
	}
}

func TestBuildInstallScriptBinaryNotTarball(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "mybin"}
	script := m.buildInstallScript(src, "https://example.com/mybin", "v1.0", "amd64")

	if strings.Contains(script, "tar -xzf") {
		t.Error("binary install should not use tar")
	}
	if !strings.Contains(script, "sudo cp mybin /usr/local/bin/mybin") {
		t.Error("should copy binary to /usr/local/bin")
	}
	if !strings.Contains(script, "sudo chmod +x /usr/local/bin/mybin") {
		t.Error("should make binary executable")
	}
}

func TestBuildInstallScriptTgzTarball(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "myapp"}
	script := m.buildInstallScript(src, "https://example.com/myapp.tgz", "v1.0", "amd64")

	if !strings.Contains(script, "tar -xzf") {
		t.Error("tgz install should use tar")
	}
}

func TestBuildInstallScriptWithServiceName(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "mydaemon", ServiceName: "mydaemon"}
	script := m.buildInstallScript(src, "https://example.com/mydaemon", "v1.0", "amd64")

	if !strings.Contains(script, "[Unit]") {
		t.Error("should create systemd unit")
	}
	if !strings.Contains(script, "ExecStart=/usr/local/bin/mydaemon") {
		t.Error("should set ExecStart")
	}
	if !strings.Contains(script, "Restart=always") {
		t.Error("should set Restart=always")
	}
	if !strings.Contains(script, "WantedBy=multi-user.target") {
		t.Error("should set WantedBy")
	}
}

func TestBuildInstallScriptWithoutServiceName(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "myapp"}
	script := m.buildInstallScript(src, "https://example.com/myapp", "v1.0", "amd64")

	if strings.Contains(script, "[Unit]") {
		t.Error("should not create systemd unit without ServiceName")
	}
}

func TestBuildInstallScriptContainsDownload(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "app"}
	script := m.buildInstallScript(src, "https://example.com/app", "v1.0", "amd64")

	if !strings.Contains(script, "curl -fSL") {
		t.Error("should download with curl")
	}
	if !strings.Contains(script, "https://example.com/app") {
		t.Error("should contain download URL")
	}
}

func TestBuildInstallScriptCleanup(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "app"}
	script := m.buildInstallScript(src, "https://example.com/app", "v1.0", "amd64")

	if !strings.Contains(script, "rm -rf $TMPDIR") {
		t.Error("should clean up temp directory")
	}
}

func TestInstallManagerStruct(t *testing.T) {
	m := &InstallManager{baseDir: "/opt", sshKey: "/key"}
	if m.baseDir != "/opt" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sshKey != "/key" {
		t.Errorf("sshKey = %q", m.sshKey)
	}
}

func TestNewInstallManagerMissingConfig(t *testing.T) {
	_, err := NewInstallManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestBuildDownloadURLEmptyVersion(t *testing.T) {
	m := &InstallManager{}
	url := m.buildDownloadURL("user/repo", "app", "", "amd64")
	if !strings.Contains(url, "github.com/user/repo/releases/download/") {
		t.Errorf("URL should still be valid with empty version: %q", url)
	}
}
