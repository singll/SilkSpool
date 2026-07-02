package engine

import (
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

// ==================== buildDownloadURL ====================

func TestBuildDownloadURLAllArchs(t *testing.T) {
	m := &InstallManager{}
	archs := []string{"amd64", "arm64", "armv7"}
	for _, arch := range archs {
		src := &config.InstallSource{Repo: "user/repo", Pattern: "app_{ARCH}"}
		url := m.buildDownloadURL(src, "v1.0", arch)
		if !strings.Contains(url, arch) {
			t.Errorf("URL for arch %q should contain arch: %q", arch, url)
		}
	}
}

func TestBuildDownloadURLVersionSubstitution(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Repo: "user/repo", Pattern: "app_{VERSION}_{ARCH}.tar.gz"}
	url := m.buildDownloadURL(src, "v2.5.0", "amd64")
	if !strings.Contains(url, "v2.5.0") || !strings.Contains(url, "amd64") {
		t.Errorf("URL should substitute version+arch: %q", url)
	}
}

func TestBuildDownloadURLGitLab(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Repo: "gitlab:org/project", Pattern: "bin_{VERSION}_{ARCH}"}
	url := m.buildDownloadURL(src, "v3.0", "arm64")
	if !strings.Contains(url, "gitlab.com/org/project") {
		t.Errorf("URL should contain gitlab base: %q", url)
	}
}

// 直链源：url 优先，忽略 repo/pattern，仅替换占位
func TestBuildDownloadURLDirectURL(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{
		URL:     "https://mirror.example.com/bin/tool-{VERSION}-{ARCH}.zst",
		Repo:    "should/be-ignored",
		Pattern: "ignored",
	}
	url := m.buildDownloadURL(src, "v9.9", "arm64")
	if url != "https://mirror.example.com/bin/tool-v9.9-arm64.zst" {
		t.Errorf("direct URL should substitute placeholders and ignore repo: %q", url)
	}
	if strings.Contains(url, "github.com") || strings.Contains(url, "be-ignored") {
		t.Errorf("direct URL must not touch release path/repo: %q", url)
	}
}

// ==================== Validate ====================

func TestInstallSourceValidate(t *testing.T) {
	tests := []struct {
		name    string
		src     config.InstallSource
		wantErr bool
	}{
		{"github latest ok", config.InstallSource{Alias: "a", Repo: "u/r", DefaultVersion: "latest"}, false},
		{"github pinned ok", config.InstallSource{Alias: "a", Repo: "u/r", DefaultVersion: "v1"}, false},
		{"url pinned ok", config.InstallSource{Alias: "a", URL: "https://x/y", DefaultVersion: "v1"}, false},
		{"neither url nor repo", config.InstallSource{Alias: "a", DefaultVersion: "v1"}, true},
		{"url and repo both set", config.InstallSource{Alias: "a", URL: "https://x", Repo: "u/r", DefaultVersion: "v1"}, true},
		{"url latest rejected", config.InstallSource{Alias: "a", URL: "https://x", DefaultVersion: "latest"}, true},
		{"url empty version rejected", config.InstallSource{Alias: "a", URL: "https://x"}, true},
		{"gitlab latest rejected", config.InstallSource{Alias: "a", Repo: "gitlab:o/p", DefaultVersion: "latest"}, true},
		{"gitlab pinned ok", config.InstallSource{Alias: "a", Repo: "gitlab:o/p", DefaultVersion: "v1"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.src.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() err=%v, wantErr=%v", err, tt.wantErr)
			}
		})
	}
}

// ==================== buildInstallScript ====================

func TestBuildInstallScriptSingleFileBinary(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "mybin"}
	script := m.buildInstallScript(src, "https://example.com/mybin", "v1.0", "amd64", "")

	if strings.Contains(script, "tar -xf") {
		t.Error("raw binary install should not use tar")
	}
	if !strings.Contains(script, "install -m 0755") {
		t.Error("should install with mode 0755")
	}
	if !strings.Contains(script, "/usr/local/bin/mybin") {
		t.Error("should install to /usr/local/bin")
	}
	if !strings.Contains(script, ".spool-mybin.version") {
		t.Error("should write version marker")
	}
}

func TestBuildInstallScriptTarGz(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "myapp"}
	script := m.buildInstallScript(src, "https://example.com/myapp.tar.gz", "v1.0", "amd64", "")

	if !strings.Contains(script, "tar -xf -") {
		t.Error("tar.gz install should extract via tar pipe")
	}
}

func TestBuildInstallScriptWithServiceName(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "mydaemon", ServiceName: "mydaemon"}
	script := m.buildInstallScript(src, "https://example.com/mydaemon", "v1.0", "amd64", "")

	if !strings.Contains(script, "[Unit]") {
		t.Error("should create systemd unit")
	}
	if !strings.Contains(script, "ExecStart=/usr/local/bin/mydaemon") {
		t.Error("should set ExecStart")
	}
	// 安装与启动分离：只写 unit + daemon-reload，绝不 enable/start
	if strings.Contains(script, "systemctl enable") || strings.Contains(script, "systemctl start") {
		t.Error("install must not enable/start service (install ≠ start)")
	}
}

func TestBuildInstallScriptExecArgs(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "tuwunel", ServiceName: "tuwunel", ExecArgs: "--config /etc/x.toml"}
	script := m.buildInstallScript(src, "https://example.com/tuwunel.zst", "v1.0", "amd64", "")

	if !strings.Contains(script, "ExecStart=/usr/local/bin/tuwunel --config /etc/x.toml") {
		t.Error("should append exec_args to ExecStart")
	}
	// unit 已存在时 warn 提示
	if !strings.Contains(script, "已存在") {
		t.Error("should warn when unit exists and exec_args set")
	}
}

func TestBuildInstallScriptWithoutServiceName(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "myapp"}
	script := m.buildInstallScript(src, "https://example.com/myapp", "v1.0", "amd64", "")

	if strings.Contains(script, "[Unit]") {
		t.Error("should not create systemd unit without ServiceName")
	}
}

func TestBuildInstallScriptSHA256(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "sec"}
	sha := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	script := m.buildInstallScript(src, "https://example.com/sec", "v1.0", "amd64", sha)

	if !strings.Contains(script, "sha256sum payload") {
		t.Error("should compute sha256 of payload")
	}
	if !strings.Contains(script, sha) {
		t.Error("should compare against expected sha256")
	}
	if !strings.Contains(script, "command -v sha256sum") {
		t.Error("should preflight sha256sum when checksum configured")
	}
}

func TestBuildInstallScriptNoSHA256(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "app"}
	script := m.buildInstallScript(src, "https://example.com/app", "v1.0", "amd64", "")

	if strings.Contains(script, "sha256sum payload") {
		t.Error("should not verify sha256 when not configured")
	}
}

func TestBuildInstallScriptPreflightCurl(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "app"}
	script := m.buildInstallScript(src, "https://example.com/app", "v1.0", "amd64", "")

	if !strings.Contains(script, "command -v curl") {
		t.Error("should always preflight curl")
	}
}

func TestBuildInstallScriptCleanup(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "app"}
	script := m.buildInstallScript(src, "https://example.com/app", "v1.0", "amd64", "")

	if !strings.Contains(script, `rm -rf "$TMPDIR"`) {
		t.Error("should clean up temp directory (quoted)")
	}
}

func TestInstallManagerStruct(t *testing.T) {
	m := &InstallManager{baseDir: "/opt", sshKey: "/key"}
	if m.baseDir != "/opt" || m.sshKey != "/key" {
		t.Errorf("struct fields not set: %+v", m)
	}
}

func TestNewInstallManagerMissingConfig(t *testing.T) {
	_, err := NewInstallManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}
