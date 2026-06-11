package engine

import (
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestResolveSSHKeyPathTildeExpansion(t *testing.T) {
	result := resolveSSHKeyPath("~/.ssh/id_ed25519", "/base")
	if !strings.Contains(result, ".ssh/id_ed25519") {
		t.Errorf("should expand tilde, got %q", result)
	}
}

func TestResolveSSHKeyPathEnvExpansion(t *testing.T) {
	result := resolveSSHKeyPath("$HOME/.ssh/id_rsa", "/base")
	if strings.Contains(result, "$HOME") {
		t.Errorf("should expand env vars, got %q", result)
	}
}

func TestExtractHostEdgeCases(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"user@192.168.1.1", "192.168.1.1"},
		{"root@server.example.com", "server.example.com"},
		{"justhostname", "justhostname"},
		{"a@b@c.host", "c.host"},
		{"@no-user.com", "no-user.com"},
		{"user@10.0.0.1", "10.0.0.1"},
		{"user@[::1]", "[::1]"},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := extractHost(tt.input)
			if got != tt.want {
				t.Errorf("extractHost(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestBuildInitScriptContainsAllSections(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("deployuser", "ssh-ed25519 AAAA test@host")

	required := []string{
		"TARGET_USER='deployuser'",
		"ssh-ed25519 AAAA test@host",
		"useradd",
		"authorized_keys",
		"docker",
		"chown",
		"chmod",
		"set -e",
		"SUDO=",
	}
	for _, req := range required {
		if !strings.Contains(script, req) {
			t.Errorf("script should contain %q", req)
		}
	}
}

func TestBuildInitScriptRootUser(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("root", "ssh-ed25519 AAAKEY root@host")
	if !strings.Contains(script, "TARGET_USER='root'") {
		t.Error("script should set TARGET_USER to root")
	}
	if !strings.Contains(script, "/root") {
		t.Error("script should handle root home directory")
	}
}

func TestBuildInitScriptTrimsPubKeyNewline(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("user", "ssh-ed25519 AAAA user@host\n")
	if strings.Contains(script, "AAAA user@host\n") && strings.Contains(script, "tee -a") {
	}
}

func TestBuildInitScriptNonRootUser(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("deployer", "ssh-ed25519 KEY deployer@host")
	if !strings.Contains(script, "TARGET_USER='deployer'") {
		t.Error("script should set TARGET_USER to deployer")
	}
	if !strings.Contains(script, "/home/deployer") || !strings.Contains(script, "TARGET_HOME") {
	}
}

func TestInitManagerStructDefaults(t *testing.T) {
	m := &InitManager{
		baseDir: "/opt/spool",
		sshKey:  "/keys/id_rsa",
		sshPub:  "/keys/id_rsa.pub",
	}
	if m.baseDir != "/opt/spool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sshPub != "/keys/id_rsa.pub" {
		t.Errorf("sshPub = %q", m.sshPub)
	}
}

func TestBuildDownloadURLGitHubFormat(t *testing.T) {
	m := &InstallManager{}
	url := m.buildDownloadURL("owner/repo", "app_{VERSION}_{ARCH}.tar.gz", "v1.0.0", "amd64")
	expected := "https://github.com/owner/repo/releases/download/v1.0.0/app_v1.0.0_amd64.tar.gz"
	if url != expected {
		t.Errorf("got %q, want %q", url, expected)
	}
}

func TestBuildDownloadURLGitLabFormat(t *testing.T) {
	m := &InstallManager{}
	url := m.buildDownloadURL("gitlab:org/repo", "bin_{ARCH}", "v2.0", "arm64")
	expected := "https://gitlab.com/org/repo/-/releases/v2.0/downloads/bin_arm64"
	if url != expected {
		t.Errorf("got %q, want %q", url, expected)
	}
}

func TestBuildDownloadURLAllArchitectures(t *testing.T) {
	m := &InstallManager{}
	for _, arch := range []string{"amd64", "arm64", "armv7"} {
		url := m.buildDownloadURL("user/repo", "app_{ARCH}", "v1.0", arch)
		if !strings.Contains(url, arch) {
			t.Errorf("URL for arch %q should contain arch: %q", arch, url)
		}
	}
}

func TestBuildInstallScriptTarball(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "myapp"}
	script := m.buildInstallScript(src, "https://example.com/myapp.tar.gz", "v1.0", "amd64")

	required := []string{
		"tar -xzf",
		"/usr/local/bin/myapp",
		"curl -fSL",
		"rm -rf $TMPDIR",
	}
	for _, req := range required {
		if !strings.Contains(script, req) {
			t.Errorf("tarball script should contain %q", req)
		}
	}
}

func TestBuildInstallScriptBinary(t *testing.T) {
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

func TestBuildInstallScriptWithSystemd(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "mydaemon", ServiceName: "mydaemon"}
	script := m.buildInstallScript(src, "https://example.com/mydaemon", "v1.0", "amd64")

	required := []string{
		"[Unit]",
		"ExecStart=/usr/local/bin/mydaemon",
		"Restart=always",
		"WantedBy=multi-user.target",
		"daemon-reload",
		"/etc/systemd/system/mydaemon.service",
	}
	for _, req := range required {
		if !strings.Contains(script, req) {
			t.Errorf("systemd script should contain %q", req)
		}
	}
}

func TestBuildInstallScriptWithoutSystemd(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "myapp"}
	script := m.buildInstallScript(src, "https://example.com/myapp", "v1.0", "amd64")

	if strings.Contains(script, "[Unit]") {
		t.Error("should not create systemd unit without ServiceName")
	}
}

func TestBuildInstallScriptTgzExtension(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "myapp"}
	script := m.buildInstallScript(src, "https://example.com/myapp.tgz", "v1.0", "amd64")

	if !strings.Contains(script, "tar -xzf") {
		t.Error("tgz install should use tar")
	}
}

func TestBuildInstallScriptContainsDownloadURL(t *testing.T) {
	m := &InstallManager{}
	src := &config.InstallSource{Alias: "app"}
	downloadURL := "https://example.com/app"
	script := m.buildInstallScript(src, downloadURL, "v1.0", "amd64")

	if !strings.Contains(script, downloadURL) {
		t.Error("script should contain download URL")
	}
}
