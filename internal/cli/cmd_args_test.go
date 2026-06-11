package cli

import (
	"testing"
)

func TestRunSyncMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for sync without args")
	}
}

func TestRunDNSMissingSubcommand(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"dns"})
	err := cmd.Execute()
	if err != nil {
		t.Errorf("dns without subcommand should not error (shows help), got %v", err)
	}
}

func TestRunServiceMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"service"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for service without args")
	}
}

func TestRunBackupMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"backup"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for backup without args")
	}
}

func TestRunBundleMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"bundle"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for bundle without args")
	}
}

func TestRunExecMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"exec"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for exec without args")
	}
}

func TestRunDecommissionMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"decommission"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for decommission without args")
	}
}

func TestRunStatusMissingHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"status"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for status without host")
	}
}

func TestRunRestartMissingHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"restart"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for restart without host")
	}
}

func TestRunLogsMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"logs"})
	err := cmd.Execute()
	if err == nil {
		t.Error("expected error for logs without args")
	}
}

func TestDNSHelpDoesNotError(t *testing.T) {
	dnsHelp()
}

func TestSiteHelpDoesNotError(t *testing.T) {
	siteHelp()
}

func TestAppLoadConfigMissing(t *testing.T) {
	app := NewApp(t.TempDir())
	err := app.LoadConfig()
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestRootCommandHasAllSubcommands(t *testing.T) {
	cmd := NewRootCmd()
	expected := []string{
		"version", "init", "sync", "dns", "site", "bundle",
		"stack", "service", "n8n", "nas", "backup", "exec",
		"key", "decommission", "pull", "push",
	}

	cmdMap := map[string]bool{}
	for _, sub := range cmd.Commands() {
		cmdMap[sub.Name()] = true
	}

	for _, name := range expected {
		if !cmdMap[name] {
			t.Errorf("expected command %q not found", name)
		}
	}
}

func TestSyncCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	syncCmd, _, err := cmd.Find([]string{"sync"})
	if err != nil {
		t.Fatalf("find sync: %v", err)
	}
	if syncCmd.Use != "sync <pull|push> [host]" {
		t.Errorf("sync Use = %q", syncCmd.Use)
	}
}

func TestDNSCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	dnsCmd, _, err := cmd.Find([]string{"dns"})
	if err != nil {
		t.Fatalf("find dns: %v", err)
	}
	if dnsCmd.Use != "dns <command>" {
		t.Errorf("dns Use = %q", dnsCmd.Use)
	}
}

func TestBundleCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	bundleCmd, _, err := cmd.Find([]string{"bundle"})
	if err != nil {
		t.Fatalf("find bundle: %v", err)
	}
	if bundleCmd.Use != "bundle <name> <action> <host>" {
		t.Errorf("bundle Use = %q", bundleCmd.Use)
	}
}

func TestServiceCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	svcCmd, _, err := cmd.Find([]string{"service"})
	if err != nil {
		t.Fatalf("find service: %v", err)
	}
	if svcCmd.Use != "service <host> <action> [service]" {
		t.Errorf("service Use = %q", svcCmd.Use)
	}
}

func TestExecCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	execCmd, _, err := cmd.Find([]string{"exec"})
	if err != nil {
		t.Fatalf("find exec: %v", err)
	}
	if execCmd.Use != "exec <host> <command...>" {
		t.Errorf("exec Use = %q", execCmd.Use)
	}
}

func TestBackupCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	backupCmd, _, err := cmd.Find([]string{"backup"})
	if err != nil {
		t.Fatalf("find backup: %v", err)
	}
	if backupCmd.Use != "backup <host>" {
		t.Errorf("backup Use = %q", backupCmd.Use)
	}
}

func TestSiteCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	siteCmd, _, err := cmd.Find([]string{"site"})
	if err != nil {
		t.Fatalf("find site: %v", err)
	}
	if siteCmd.Use != "site <command>" {
		t.Errorf("site Use = %q", siteCmd.Use)
	}
}

func TestKeyCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	keyCmd, _, err := cmd.Find([]string{"key"})
	if err != nil {
		t.Fatalf("find key: %v", err)
	}
	if keyCmd.Use != "key <command>" {
		t.Errorf("key Use = %q", keyCmd.Use)
	}
}

func TestDecommissionCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	decomCmd, _, err := cmd.Find([]string{"decommission"})
	if err != nil {
		t.Fatalf("find decommission: %v", err)
	}
	if decomCmd.Use != "decommission <host>" {
		t.Errorf("decommission Use = %q", decomCmd.Use)
	}
}

func TestPullCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	pullCmd, _, err := cmd.Find([]string{"pull"})
	if err != nil {
		t.Fatalf("find pull: %v", err)
	}
	if pullCmd.Use != "pull [host]" {
		t.Errorf("pull Use = %q", pullCmd.Use)
	}
}

func TestPushCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	pushCmd, _, err := cmd.Find([]string{"push"})
	if err != nil {
		t.Fatalf("find push: %v", err)
	}
	if pushCmd.Use != "push [host]" {
		t.Errorf("push Use = %q", pushCmd.Use)
	}
}

func TestBundleCommandHasYesFlag(t *testing.T) {
	cmd := NewRootCmd()
	bundleCmd, _, err := cmd.Find([]string{"bundle"})
	if err != nil {
		t.Fatalf("find bundle: %v", err)
	}
	flag := bundleCmd.Flags().Lookup("yes")
	if flag == nil {
		t.Error("bundle command should have --yes flag")
	}
}

func TestKeyCommandHasFlags(t *testing.T) {
	cmd := NewRootCmd()
	keyCmd, _, err := cmd.Find([]string{"key"})
	if err != nil {
		t.Fatalf("find key: %v", err)
	}
	for _, name := range []string{"new", "keep-old-remote", "dry-run", "all", "yes"} {
		flag := keyCmd.Flags().Lookup(name)
		if flag == nil {
			t.Errorf("key command should have --%s flag", name)
		}
	}
}

func TestDecommissionCommandHasFlags(t *testing.T) {
	cmd := NewRootCmd()
	decomCmd, _, err := cmd.Find([]string{"decommission"})
	if err != nil {
		t.Fatalf("find decommission: %v", err)
	}
	for _, name := range []string{"purge-config", "yes"} {
		flag := decomCmd.Flags().Lookup(name)
		if flag == nil {
			t.Errorf("decommission command should have --%s flag", name)
		}
	}
}

func TestVersionOutput(t *testing.T) {
	if Version == "" {
		t.Error("Version should not be empty")
	}
}

func TestBuildTimeAndCommit(t *testing.T) {
	if BuildTime == "" {
		t.Error("BuildTime should have a default value")
	}
	if GitCommit == "" {
		t.Error("GitCommit should have a default value")
	}
}
