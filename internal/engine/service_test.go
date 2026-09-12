package engine

import (
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestBuildStatusCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType string
		name    string
		want    string
	}{
		{"docker", "mycontainer", "docker ps --filter name=^mycontainer$ --format '{{.Status}}'"},
		{"systemd", "nginx", "systemctl is-active nginx"},
		{"initd", "ssh", "/etc/init.d/ssh status 2>/dev/null || echo 'unknown'"},
		{"openwrt", "firewall", "/etc/init.d/firewall status 2>/dev/null || echo 'unknown'"},
		{"unknown", "svc", ""},
	}

	for _, tt := range tests {
		got := m.buildStatusCommand(tt.svcType, tt.name)
		if got != tt.want {
			t.Errorf("buildStatusCommand(%q, %q) = %q, want %q", tt.svcType, tt.name, got, tt.want)
		}
	}
}

func TestBuildStartCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, name, want string
		useSudo             bool
	}{
		{"docker", "c1", "docker start c1", false},
		{"docker", "c2", "docker start c2", true},
		{"systemd", "n1", "sudo systemctl start n1", true},
		{"systemd", "n2", "systemctl start n2", false},
		{"initd", "s1", "sudo /etc/init.d/s1 start", true},
		{"initd", "s2", "/etc/init.d/s2 start", false},
		{"openwrt", "f1", "sudo /etc/init.d/f1 start", true},
		{"openwrt", "f2", "/etc/init.d/f2 start", false},
		{"unknown", "x", "", false},
	}

	for _, tt := range tests {
		got := m.buildStartCommand(tt.svcType, tt.name, tt.useSudo)
		if got != tt.want {
			t.Errorf("buildStartCommand(%q, %q, %v) = %q, want %q", tt.svcType, tt.name, tt.useSudo, got, tt.want)
		}
	}
}

func TestBuildStopCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, name, want string
		useSudo             bool
	}{
		{"docker", "c1", "docker stop c1", false},
		{"systemd", "n1", "sudo systemctl stop n1", true},
		{"systemd", "n2", "systemctl stop n2", false},
		{"initd", "s1", "sudo /etc/init.d/s1 stop", true},
		{"initd", "s2", "/etc/init.d/s2 stop", false},
		{"openwrt", "f1", "sudo /etc/init.d/f1 stop", true},
		{"openwrt", "f2", "/etc/init.d/f2 stop", false},
		{"unknown", "x", "", false},
	}

	for _, tt := range tests {
		got := m.buildStopCommand(tt.svcType, tt.name, tt.useSudo)
		if got != tt.want {
			t.Errorf("buildStopCommand(%q, %q, %v) = %q, want %q", tt.svcType, tt.name, tt.useSudo, got, tt.want)
		}
	}
}

func TestBuildRestartCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, name, want string
		useSudo             bool
	}{
		{"docker", "c1", "docker restart c1", false},
		{"systemd", "n1", "sudo systemctl restart n1", true},
		{"systemd", "n2", "systemctl restart n2", false},
		{"initd", "s1", "sudo /etc/init.d/s1 restart", true},
		{"initd", "s2", "/etc/init.d/s2 restart", false},
		{"openwrt", "f1", "sudo /etc/init.d/f1 restart", true},
		{"openwrt", "f2", "/etc/init.d/f2 restart", false},
		{"unknown", "x", "", false},
	}

	for _, tt := range tests {
		got := m.buildRestartCommand(tt.svcType, tt.name, tt.useSudo)
		if got != tt.want {
			t.Errorf("buildRestartCommand(%q, %q, %v) = %q, want %q", tt.svcType, tt.name, tt.useSudo, got, tt.want)
		}
	}
}

func TestBuildLogsCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, name string
		lines         int
		want          string
		useSudo       bool
	}{
		{"docker", "c1", 50, "docker logs --tail 50 c1 2>&1", false},
		{"systemd", "n1", 100, "sudo journalctl -u n1 -n 100 --no-pager", true},
		{"systemd", "n2", 100, "journalctl -u n2 -n 100 --no-pager", false},
		{"initd", "s1", 20, "logread -e s1 | tail -n 20", false},
		{"openwrt", "f1", 10, "logread -e f1 | tail -n 10", false},
		{"unknown", "x", 10, "", false},
	}

	for _, tt := range tests {
		got := m.buildLogsCommand(tt.svcType, tt.name, tt.lines, tt.useSudo)
		if got != tt.want {
			t.Errorf("buildLogsCommand(%q, %q, %d, %v) = %q, want %q", tt.svcType, tt.name, tt.lines, tt.useSudo, got, tt.want)
		}
	}
}

func TestParseStatus(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, output, want string
	}{
		{"docker", "Up 2 hours", "running"},
		{"docker", "running", "running"},
		{"docker", "Exited 1 min ago", "stopped"},
		{"docker", "", "stopped"},
		{"systemd", "active", "active"},
		{"systemd", "inactive", "inactive"},
		{"systemd", "failed", "inactive"},
		{"initd", "running", "running"},
		{"initd", "active", "running"},
		{"initd", "stopped", "stopped"},
		{"openwrt", "running", "running"},
		{"openwrt", "inactive", "running"},
		{"unknown", "anything", "anything"},
	}

	for _, tt := range tests {
		got := m.parseStatus(tt.svcType, tt.output)
		if got != tt.want {
			t.Errorf("parseStatus(%q, %q) = %q, want %q", tt.svcType, tt.output, got, tt.want)
		}
	}
}

func TestServiceInfoHealthy(t *testing.T) {
	tests := []struct {
		status  string
		healthy bool
	}{
		{"running", true},
		{"Up", true},
		{"active", true},
		{"stopped", false},
		{"inactive", false},
	}

	for _, tt := range tests {
		si := ServiceInfo{Status: tt.status, Healthy: tt.status == "running" || tt.status == "Up" || tt.status == "active"}
		if si.Healthy != tt.healthy {
			t.Errorf("Status %q: Healthy = %v, want %v", tt.status, si.Healthy, tt.healthy)
		}
	}
}

func TestGetServiceLookup(t *testing.T) {
	cfg := &config.HostConfig{
		Services: []config.ServiceEntry{
			{Alias: "web", Type: "docker", Name: "sp-web"},
			{Alias: "db", Type: "docker", Name: "sp-db"},
		},
	}

	if svc := cfg.GetService("web"); svc == nil || svc.Name != "sp-web" {
		t.Error("GetService(web) should find sp-web")
	}
	if svc := cfg.GetService("db"); svc == nil || svc.Name != "sp-db" {
		t.Error("GetService(db) should find sp-db")
	}
	if svc := cfg.GetService("cache"); svc != nil {
		t.Error("GetService(cache) should return nil")
	}
}
