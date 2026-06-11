package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewApp(t *testing.T) {
	app := NewApp("/opt/SilkSpool")
	if app == nil {
		t.Fatal("NewApp returned nil")
	}
	if app.BaseDir != "/opt/SilkSpool" {
		t.Errorf("BaseDir = %q, want %q", app.BaseDir, "/opt/SilkSpool")
	}
}

func TestAppLoadConfig(t *testing.T) {
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

	app := NewApp(dir)
	if err := app.LoadConfig(); err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if app.Config == nil {
		t.Fatal("Config should not be nil after LoadConfig")
	}
	if app.Config.Global.SSHKeyPath == "" {
		t.Error("SSHKeyPath should not be empty")
	}
}

func TestAppLoadConfigCached(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_silkspool"
hosts: {}
`
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	app := NewApp(dir)
	if err := app.LoadConfig(); err != nil {
		t.Fatalf("first LoadConfig failed: %v", err)
	}
	firstConfig := app.Config

	if err := app.LoadConfig(); err != nil {
		t.Fatalf("second LoadConfig failed: %v", err)
	}
	if app.Config != firstConfig {
		t.Error("Config should be cached and return same instance")
	}
}

func TestAppLoadConfigNotFound(t *testing.T) {
	app := NewApp(t.TempDir())
	err := app.LoadConfig()
	if err == nil {
		t.Error("expected error for missing config, got nil")
	}
}

func TestAppSSHKeyPath(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_silkspool"
hosts: {}
`
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	app := NewApp(dir)
	keyPath, err := app.SSHKeyPath()
	if err != nil {
		t.Fatalf("SSHKeyPath failed: %v", err)
	}

	expected := filepath.Join(dir, "keys", "id_silkspool")
	if keyPath != expected {
		t.Errorf("SSHKeyPath = %q, want %q", keyPath, expected)
	}
}

func TestAppSSHKeyPathAbsolute(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "/home/user/.ssh/id_rsa"
hosts: {}
`
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(yamlContent), 0644); err != nil {
		t.Fatal(err)
	}

	app := NewApp(dir)
	keyPath, err := app.SSHKeyPath()
	if err != nil {
		t.Fatalf("SSHKeyPath failed: %v", err)
	}

	if keyPath != "/home/user/.ssh/id_rsa" {
		t.Errorf("SSHKeyPath = %q, want %q", keyPath, "/home/user/.ssh/id_rsa")
	}
}

func TestNewRootCmd(t *testing.T) {
	cmd := NewRootCmd()
	if cmd == nil {
		t.Fatal("NewRootCmd returned nil")
	}
	if cmd.Use != "spool" {
		t.Errorf("Use = %q, want %q", cmd.Use, "spool")
	}
	if cmd.Short == "" {
		t.Error("Short should not be empty")
	}
	if cmd.SilenceUsage != true {
		t.Error("SilenceUsage should be true")
	}
}

func TestNewRootCmdHasVersionSubcommand(t *testing.T) {
	cmd := NewRootCmd()
	versionCmd, _, err := cmd.Find([]string{"version"})
	if err != nil {
		t.Fatalf("failed to find version command: %v", err)
	}
	if versionCmd.Use != "version" {
		t.Errorf("version command Use = %q, want %q", versionCmd.Use, "version")
	}
}

func TestNewRootCmdHasSubcommands(t *testing.T) {
	cmd := NewRootCmd()
	expectedCommands := []string{
		"version",
		"init",
		"sync",
		"dns",
		"site",
		"bundle",
		"stack",
		"service",
		"n8n",
		"nas",
		"backup",
		"exec",
		"key",
		"decommission",
	}

	for _, name := range expectedCommands {
		found := false
		for _, subCmd := range cmd.Commands() {
			if subCmd.Name() == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected command %q not found", name)
		}
	}
}

func TestResolveBaseDirWithConfigFlag(t *testing.T) {
	originalConfigFlag := configFlag
	defer func() { configFlag = originalConfigFlag }()

	t.Run("absolute config path", func(t *testing.T) {
		configFlag = "/opt/SilkSpool/silkspool.yaml"
		result := resolveBaseDir()
		if result != "/opt/SilkSpool" {
			t.Errorf("resolveBaseDir() = %q, want %q", result, "/opt/SilkSpool")
		}
	})

	t.Run("relative config path", func(t *testing.T) {
		cwd, _ := os.Getwd()
		configFlag = "config/silkspool.yaml"
		result := resolveBaseDir()
		expected := filepath.Dir(filepath.Join(cwd, "config/silkspool.yaml"))
		if result != expected {
			t.Errorf("resolveBaseDir() = %q, want %q", result, expected)
		}
	})
}

func TestResolveBaseDirWithoutConfigFlag(t *testing.T) {
	originalConfigFlag := configFlag
	defer func() { configFlag = originalConfigFlag }()

	configFlag = ""
	result := resolveBaseDir()
	if result == "" {
		t.Error("resolveBaseDir should not return empty string")
	}
}

func TestIsValidSpoolDir(t *testing.T) {
	dir := t.TempDir()

	t.Run("directory with bundles", func(t *testing.T) {
		bundlesDir := filepath.Join(dir, "bundles")
		if err := os.Mkdir(bundlesDir, 0755); err != nil {
			t.Fatal(err)
		}
		if !isValidSpoolDir(dir) {
			t.Error("directory with bundles should be valid")
		}
	})

	t.Run("directory with silkspool.yaml", func(t *testing.T) {
		dir2 := t.TempDir()
		yamlPath := filepath.Join(dir2, "silkspool.yaml")
		if err := os.WriteFile(yamlPath, []byte("global: {}"), 0644); err != nil {
			t.Fatal(err)
		}
		if !isValidSpoolDir(dir2) {
			t.Error("directory with silkspool.yaml should be valid")
		}
	})

	t.Run("invalid directory", func(t *testing.T) {
		dir3 := t.TempDir()
		if isValidSpoolDir(dir3) {
			t.Error("empty directory should not be valid")
		}
	})
}

func TestVersionVariables(t *testing.T) {
	if Version == "" {
		t.Error("Version should not be empty")
	}
}
