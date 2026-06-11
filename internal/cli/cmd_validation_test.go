package cli

import (
	"testing"
)

func TestSyncNoDirection(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync"})
	err := cmd.Execute()
	if err == nil {
		t.Error("sync without direction should error")
	}
}

func TestSyncNoHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync", "pull"})
	err := cmd.Execute()
	if err == nil {
		t.Error("sync pull without host should error")
	}
}

func TestSyncInvalidDirection(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync", "invalid", "host"})
	err := cmd.Execute()
	if err == nil {
		t.Error("sync with invalid direction should error")
	}
}

func TestServiceNoArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"service"})
	err := cmd.Execute()
	if err == nil {
		t.Error("service without args should error")
	}
}

func TestServiceNoAction(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"service", "host"})
	err := cmd.Execute()
	if err == nil {
		t.Error("service with only host should error")
	}
}

func TestBundleNoArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"bundle"})
	err := cmd.Execute()
	if err == nil {
		t.Error("bundle without args should error")
	}
}

func TestBundleMissingHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"bundle", "name", "up"})
	err := cmd.Execute()
	if err == nil {
		t.Error("bundle without host should error")
	}
}

func TestBundleMissingAction(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"bundle", "name"})
	err := cmd.Execute()
	if err == nil {
		t.Error("bundle without action should error")
	}
}

func TestBackupNoArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"backup"})
	err := cmd.Execute()
	if err == nil {
		t.Error("backup without host should error")
	}
}

func TestExecNoArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"exec"})
	err := cmd.Execute()
	if err == nil {
		t.Error("exec without args should error")
	}
}

func TestExecNoCommand(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"exec", "host"})
	err := cmd.Execute()
	if err == nil {
		t.Error("exec without command should error")
	}
}

func TestDNSAddNoDomain(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"dns", "add"})
	err := cmd.Execute()
	if err == nil {
		t.Error("dns add without domain should error")
	}
}

func TestDNSRemoveNoDomain(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"dns", "remove"})
	err := cmd.Execute()
	if err == nil {
		t.Error("dns remove without domain should error")
	}
}

func TestDNSDeployNoDomain(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"dns", "deploy"})
	err := cmd.Execute()
	if err == nil {
		t.Error("dns deploy without domain should error")
	}
}

func TestDNSUnknownSubcommand(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"dns", "unknown"})
	err := cmd.Execute()
	if err == nil {
		t.Error("dns with unknown subcommand should error (tries to create manager)")
	}
}

func TestSiteAddMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"site", "add", "domain", "backend"})
	err := cmd.Execute()
	if err == nil {
		t.Error("site add without name should error")
	}
}

func TestSiteRemoveNoDomain(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"site", "remove"})
	err := cmd.Execute()
	if err == nil {
		t.Error("site remove without domain should error")
	}
}

func TestSiteDeployMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"site", "deploy", "domain", "backend"})
	err := cmd.Execute()
	if err == nil {
		t.Error("site deploy without name should error")
	}
}

func TestPullNoArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"pull"})
	err := cmd.Execute()
	if err == nil {
		t.Error("pull without host should error")
	}
}

func TestPushNoArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"push"})
	err := cmd.Execute()
	if err == nil {
		t.Error("push without host should error")
	}
}

func TestDecommissionNoHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"decommission"})
	err := cmd.Execute()
	if err == nil {
		t.Error("decommission without host should error")
	}
}

func TestRestartNoHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"restart"})
	err := cmd.Execute()
	if err == nil {
		t.Error("restart without host should error")
	}
}

func TestRestartNoService(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"restart", "host"})
	err := cmd.Execute()
	if err == nil {
		t.Error("restart without service should error")
	}
}

func TestLogsNoHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"logs"})
	err := cmd.Execute()
	if err == nil {
		t.Error("logs without host should error")
	}
}

func TestLogsNoService(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"logs", "host"})
	err := cmd.Execute()
	if err == nil {
		t.Error("logs without service should error")
	}
}

func TestStatusNoHost(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"status"})
	err := cmd.Execute()
	if err == nil {
		t.Error("status without host should error")
	}
}

func TestDNSSubcommandsNeedConfig(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"dns", "list"})
	err := cmd.Execute()
	if err == nil {
		t.Error("dns list without valid config should error")
	}
}

func TestSiteSubcommandsNeedConfig(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"site", "list"})
	err := cmd.Execute()
	if err == nil {
		t.Error("site list without valid config should error")
	}
}

func TestBundleServiceMissingArgs(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"bundle", "name", "service", "host"})
	err := cmd.Execute()
	if err == nil {
		t.Error("bundle service without service name and action should error")
	}
}

func TestServiceStartNoService(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"service", "host", "start"})
	err := cmd.Execute()
	if err == nil {
		t.Error("service start without service name should error")
	}
}

func TestServiceStopNoService(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"service", "host", "stop"})
	err := cmd.Execute()
	if err == nil {
		t.Error("service stop without service name should error")
	}
}

func TestServiceRestartNoService(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"service", "host", "restart"})
	err := cmd.Execute()
	if err == nil {
		t.Error("service restart without service name should error")
	}
}

func TestServiceLogsNoService(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"service", "host", "logs"})
	err := cmd.Execute()
	if err == nil {
		t.Error("service logs without service name should error")
	}
}
