package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const sampleYAML = `# 顶层注释
global:
  ssh_key_path: "./keys/id_silkspool"

# -------------------- 主机清单 --------------------
hosts:
  # =========================================================================
  # Keeper 知识管理服务器
  # =========================================================================
  keeper:
    address: "silkspool@192.168.7.230"
    bundles: ["keeper"]

  # =========================================================================
  # Bili-Node B站相关服务节点
  # =========================================================================
  bili-node:
    address: "silkspool@192.168.7.108"
    bundles: ["bili"]

  # =========================================================================
  # TXHK 远程 VPS
  # =========================================================================
  txhk:
    address: "silkspool@43.129.195.4"
    bundles: ["server"]
`

func TestRemoveHostFromYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0644); err != nil {
		t.Fatal(err)
	}

	if err := RemoveHostFromYAML(path, "bili-node"); err != nil {
		t.Fatalf("RemoveHostFromYAML failed: %v", err)
	}

	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)

	if strings.Contains(s, "bili-node:") {
		t.Errorf("removed host still present:\n%s", s)
	}
	if strings.Contains(s, "Bili-Node") {
		t.Errorf("removed host banner comment still present:\n%s", s)
	}

	for _, want := range []string{
		"keeper:", "Keeper 知识管理服务器",
		"txhk:", "TXHK 远程 VPS",
		`"silkspool@192.168.7.230"`,
		`["keeper"]`,
		"# 顶层注释",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("expected %q to be preserved, but it is missing:\n%s", want, s)
		}
	}

	bak, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("backup not written: %v", err)
	}
	if !strings.Contains(string(bak), "bili-node:") {
		t.Errorf("backup should contain original content")
	}
}

func TestRemoveHostFromYAMLNotFound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0644); err != nil {
		t.Fatal(err)
	}
	if err := RemoveHostFromYAML(path, "does-not-exist"); err == nil {
		t.Error("expected error for missing host, got nil")
	}
}

func TestConfigFilePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := ConfigFilePath(dir)
	if err != nil {
		t.Fatalf("ConfigFilePath failed: %v", err)
	}
	if got != path {
		t.Errorf("ConfigFilePath = %q, want %q", got, path)
	}
}

func TestResolveSSHKeyPath(t *testing.T) {
	tests := []struct {
		name     string
		baseDir  string
		keyPath  string
		expected string
	}{
		{
			name:     "empty path",
			baseDir:  "/opt/SilkSpool",
			keyPath:  "",
			expected: "",
		},
		{
			name:     "absolute path",
			baseDir:  "/opt/SilkSpool",
			keyPath:  "/home/user/.ssh/id_rsa",
			expected: "/home/user/.ssh/id_rsa",
		},
		{
			name:     "relative path with dot",
			baseDir:  "/opt/SilkSpool",
			keyPath:  "./keys/id_silkspool",
			expected: "/opt/SilkSpool/keys/id_silkspool",
		},
		{
			name:     "relative path without dot",
			baseDir:  "/opt/SilkSpool",
			keyPath:  "keys/id_silkspool",
			expected: "/opt/SilkSpool/keys/id_silkspool",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ResolveSSHKeyPath(tt.baseDir, tt.keyPath)
			if got != tt.expected {
				t.Errorf("ResolveSSHKeyPath(%q, %q) = %q, want %q", tt.baseDir, tt.keyPath, got, tt.expected)
			}
		})
	}
}

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_silkspool"
  default_domain: "example.com"
  dns_gateway_ip: "10.0.0.1"
  dns_headscale_server: "100.100.100.100"
  dns_gateway_host: "router"
  dns_headscale_host: "vps"
hosts:
  testhost:
    address: "user@10.0.0.2"
    ssh_port: "2222"
    bundles: ["test"]
`
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if cfg.Global.DefaultDomain != "example.com" {
		t.Errorf("DefaultDomain = %q, want %q", cfg.Global.DefaultDomain, "example.com")
	}
	if cfg.Global.DNSGatewayIP != "10.0.0.1" {
		t.Errorf("DNSGatewayIP = %q, want %q", cfg.Global.DNSGatewayIP, "10.0.0.1")
	}

	host := cfg.GetHost("testhost")
	if host == nil {
		t.Fatal("testhost not found")
	}
	if host.SSHPort != "2222" {
		t.Errorf("SSHPort = %q, want %q", host.SSHPort, "2222")
	}
	if host.Address != "user@10.0.0.2" {
		t.Errorf("Address = %q, want %q", host.Address, "user@10.0.0.2")
	}
}

func TestLoadConfigNoEnvDefaults(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_silkspool"
hosts:
  testhost:
    address: "user@10.0.0.2"
`
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if cfg.Global.DefaultDomain != "" {
		t.Errorf("DefaultDomain should be empty when not configured, got %q", cfg.Global.DefaultDomain)
	}
	if cfg.Global.DNSGatewayIP != "" {
		t.Errorf("DNSGatewayIP should be empty when not configured, got %q", cfg.Global.DNSGatewayIP)
	}
	if cfg.Global.DNSGatewayHost != "" {
		t.Errorf("DNSGatewayHost should be empty when not configured, got %q", cfg.Global.DNSGatewayHost)
	}
}

func TestLoadEnvFile(t *testing.T) {
	dir := t.TempDir()
	hostDir := filepath.Join(dir, "hosts", "testhost")
	if err := os.MkdirAll(hostDir, 0755); err != nil {
		t.Fatal(err)
	}

	envContent := `# Comment
export API_KEY="secret123"
PLAIN_VAR=hello
EMPTY_VAR=""
`
	envPath := filepath.Join(hostDir, ".env")
	if err := os.WriteFile(envPath, []byte(envContent), 0644); err != nil {
		t.Fatal(err)
	}

	env, err := LoadEnvFile(dir, "testhost")
	if err != nil {
		t.Fatalf("LoadEnvFile failed: %v", err)
	}

	if env["API_KEY"] != "secret123" {
		t.Errorf("API_KEY = %q, want %q", env["API_KEY"], "secret123")
	}
	if env["PLAIN_VAR"] != "hello" {
		t.Errorf("PLAIN_VAR = %q, want %q", env["PLAIN_VAR"], "hello")
	}
	if env["EMPTY_VAR"] != "" {
		t.Errorf("EMPTY_VAR = %q, want empty", env["EMPTY_VAR"])
	}
}

func TestLoadEnvFileNotFound(t *testing.T) {
	dir := t.TempDir()
	env, err := LoadEnvFile(dir, "nonexistent")
	if err != nil {
		t.Fatalf("LoadEnvFile should not error on missing file, got: %v", err)
	}
	if env != nil {
		t.Errorf("expected nil env for missing file, got %v", env)
	}
}

func TestConfigGetHost(t *testing.T) {
	cfg := &Config{
		Hosts: map[string]HostConfig{
			"keeper": {Address: "user@1.2.3.4"},
		},
	}

	if h := cfg.GetHost("keeper"); h == nil || h.Address != "user@1.2.3.4" {
		t.Errorf("GetHost(keeper) failed")
	}
	if h := cfg.GetHost("missing"); h != nil {
		t.Errorf("GetHost(missing) should return nil, got %v", h)
	}
}

func TestConfigGetInstallSource(t *testing.T) {
	cfg := &Config{
		InstallSources: []InstallSource{
			{Alias: "caddy", Repo: "caddyserver/caddy"},
			{Alias: "ntfy", Repo: "binwiederhier/ntfy"},
		},
	}

	if src := cfg.GetInstallSource("caddy"); src == nil || src.Repo != "caddyserver/caddy" {
		t.Errorf("GetInstallSource(caddy) failed")
	}
	if src := cfg.GetInstallSource("missing"); src != nil {
		t.Errorf("GetInstallSource(missing) should return nil")
	}
}

func TestHostConfigGetService(t *testing.T) {
	h := &HostConfig{
		Services: []ServiceEntry{
			{Alias: "n8n", Type: "docker", Name: "sp-n8n"},
			{Alias: "caddy", Type: "systemd", Name: "caddy"},
		},
	}

	if svc := h.GetService("n8n"); svc == nil || svc.Name != "sp-n8n" {
		t.Errorf("GetService(n8n) failed")
	}
	if svc := h.GetService("missing"); svc != nil {
		t.Errorf("GetService(missing) should return nil")
	}
}

func TestExpandPath(t *testing.T) {
	t.Run("empty path", func(t *testing.T) {
		result := expandPath("")
		if result != "" {
			t.Errorf("expandPath('') = %q, want empty", result)
		}
	})

	t.Run("absolute path unchanged", func(t *testing.T) {
		result := expandPath("/opt/SilkSpool/keys/id_rsa")
		if result != "/opt/SilkSpool/keys/id_rsa" {
			t.Errorf("expandPath() = %q, want %q", result, "/opt/SilkSpool/keys/id_rsa")
		}
	})

	t.Run("tilde expansion", func(t *testing.T) {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skip("cannot determine home dir")
		}
		result := expandPath("~/keys/id_rsa")
		expected := home + "/keys/id_rsa"
		if result != expected {
			t.Errorf("expandPath('~/keys/id_rsa') = %q, want %q", result, expected)
		}
	})

	t.Run("tilde only", func(t *testing.T) {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skip("cannot determine home dir")
		}
		result := expandPath("~")
		if result != home {
			t.Errorf("expandPath('~') = %q, want %q", result, home)
		}
	})

	t.Run("env var expansion", func(t *testing.T) {
		os.Setenv("SPOOL_TEST_DIR", "/test/path")
		defer os.Unsetenv("SPOOL_TEST_DIR")

		result := expandPath("$SPOOL_TEST_DIR/keys")
		if result != "/test/path/keys" {
			t.Errorf("expandPath('$SPOOL_TEST_DIR/keys') = %q, want %q", result, "/test/path/keys")
		}
	})

	t.Run("relative path unchanged", func(t *testing.T) {
		result := expandPath("./keys/id_rsa")
		if result != "./keys/id_rsa" {
			t.Errorf("expandPath('./keys/id_rsa') = %q, want %q", result, "./keys/id_rsa")
		}
	})
}

func TestParseDuration(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		defaultVal time.Duration
		expected   time.Duration
	}{
		{"empty string uses default", "", 30 * time.Second, 30 * time.Second},
		{"valid duration", "10s", 30 * time.Second, 10 * time.Second},
		{"valid minutes", "5m", 30 * time.Second, 5 * time.Minute},
		{"invalid duration uses default", "invalid", 30 * time.Second, 30 * time.Second},
		{"zero duration", "0s", 30 * time.Second, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ParseDuration(tt.input, tt.defaultVal)
			if result != tt.expected {
				t.Errorf("ParseDuration(%q, %v) = %v, want %v", tt.input, tt.defaultVal, result, tt.expected)
			}
		})
	}
}

func TestDefaultInt(t *testing.T) {
	tests := []struct {
		name     string
		val      int
		defVal   int
		expected int
	}{
		{"zero uses default", 0, 50, 50},
		{"non-zero uses value", 100, 50, 100},
		{"negative uses value", -1, 50, -1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := DefaultInt(tt.val, tt.defVal)
			if result != tt.expected {
				t.Errorf("DefaultInt(%d, %d) = %d, want %d", tt.val, tt.defVal, result, tt.expected)
			}
		})
	}
}

func TestDefaultString(t *testing.T) {
	tests := []struct {
		name     string
		val      string
		defVal   string
		expected string
	}{
		{"empty uses default", "", "fallback", "fallback"},
		{"non-empty uses value", "actual", "fallback", "actual"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := DefaultString(tt.val, tt.defVal)
			if result != tt.expected {
				t.Errorf("DefaultString(%q, %q) = %q, want %q", tt.val, tt.defVal, result, tt.expected)
			}
		})
	}
}

func TestTimeoutConfigUnmarshal(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_silkspool"
  timeouts:
    ssh_connect: "10s"
    http_client: "15s"
    agent_http: "3s"
    agent_retry: "2s"
hosts: {}
`
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if cfg.Global.Timeouts.SSHConnect != "10s" {
		t.Errorf("SSHConnect = %q, want %q", cfg.Global.Timeouts.SSHConnect, "10s")
	}
	if cfg.Global.Timeouts.HTTPClient != "15s" {
		t.Errorf("HTTPClient = %q, want %q", cfg.Global.Timeouts.HTTPClient, "15s")
	}
	if cfg.Global.Timeouts.AgentHTTP != "3s" {
		t.Errorf("AgentHTTP = %q, want %q", cfg.Global.Timeouts.AgentHTTP, "3s")
	}
	if cfg.Global.Timeouts.AgentRetry != "2s" {
		t.Errorf("AgentRetry = %q, want %q", cfg.Global.Timeouts.AgentRetry, "2s")
	}
}

func TestDefaultsConfigUnmarshal(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_silkspool"
  defaults:
    log_lines: 100
    docker_log_max: "100m"
    docker_log_num: 5
    deploy_path: "/opt/custom"
    compose_version: "v2.30.0"
hosts: {}
`
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if cfg.Global.Defaults.LogLines != 100 {
		t.Errorf("LogLines = %d, want 100", cfg.Global.Defaults.LogLines)
	}
	if cfg.Global.Defaults.DockerLogMax != "100m" {
		t.Errorf("DockerLogMax = %q, want %q", cfg.Global.Defaults.DockerLogMax, "100m")
	}
	if cfg.Global.Defaults.DockerLogNum != 5 {
		t.Errorf("DockerLogNum = %d, want 5", cfg.Global.Defaults.DockerLogNum)
	}
	if cfg.Global.Defaults.DeployPath != "/opt/custom" {
		t.Errorf("DeployPath = %q, want %q", cfg.Global.Defaults.DeployPath, "/opt/custom")
	}
	if cfg.Global.Defaults.ComposeVer != "v2.30.0" {
		t.Errorf("ComposeVer = %q, want %q", cfg.Global.Defaults.ComposeVer, "v2.30.0")
	}
}

func TestConfigLoaderResolveSSHKey(t *testing.T) {
	tests := []struct {
		name     string
		baseDir  string
		keyPath  string
		absCheck bool
	}{
		{"empty path", "/opt/SilkSpool", "", false},
		{"absolute path", "/opt/SilkSpool", "/home/user/.ssh/id_rsa", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			loader := NewConfigLoader(tt.baseDir)
			result := loader.ResolveSSHKey(tt.keyPath)
			if tt.keyPath == "" && result != "" {
				t.Errorf("ResolveSSHKey('') should return empty, got %q", result)
			}
			if tt.absCheck && result != tt.keyPath {
				t.Errorf("ResolveSSHKey(%q) = %q, want %q", tt.keyPath, result, tt.keyPath)
			}
		})
	}
}
