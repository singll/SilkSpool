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
	}{
		{"docker", "c1", "docker start c1"},
		{"systemd", "n1", "sudo systemctl start n1"},
		{"initd", "s1", "sudo /etc/init.d/s1 start"},
		{"openwrt", "f1", "sudo /etc/init.d/f1 start"},
		{"unknown", "x", ""},
	}

	for _, tt := range tests {
		got := m.buildStartCommand(tt.svcType, tt.name)
		if got != tt.want {
			t.Errorf("buildStartCommand(%q, %q) = %q, want %q", tt.svcType, tt.name, got, tt.want)
		}
	}
}

func TestBuildStopCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, name, want string
	}{
		{"docker", "c1", "docker stop c1"},
		{"systemd", "n1", "sudo systemctl stop n1"},
		{"initd", "s1", "sudo /etc/init.d/s1 stop"},
		{"openwrt", "f1", "sudo /etc/init.d/f1 stop"},
		{"unknown", "x", ""},
	}

	for _, tt := range tests {
		got := m.buildStopCommand(tt.svcType, tt.name)
		if got != tt.want {
			t.Errorf("buildStopCommand(%q, %q) = %q, want %q", tt.svcType, tt.name, got, tt.want)
		}
	}
}

func TestBuildRestartCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, name, want string
	}{
		{"docker", "c1", "docker restart c1"},
		{"systemd", "n1", "sudo systemctl restart n1"},
		{"initd", "s1", "sudo /etc/init.d/s1 restart"},
		{"openwrt", "f1", "sudo /etc/init.d/f1 restart"},
		{"unknown", "x", ""},
	}

	for _, tt := range tests {
		got := m.buildRestartCommand(tt.svcType, tt.name)
		if got != tt.want {
			t.Errorf("buildRestartCommand(%q, %q) = %q, want %q", tt.svcType, tt.name, got, tt.want)
		}
	}
}

func TestBuildLogsCommand(t *testing.T) {
	m := &ServiceManager{}
	tests := []struct {
		svcType, name string
		lines         int
		want          string
	}{
		{"docker", "c1", 50, "docker logs --tail 50 c1 2>&1"},
		{"systemd", "n1", 100, "sudo journalctl -u n1 -n 100 --no-pager"},
		{"initd", "s1", 20, "logread -e s1 | tail -n 20"},
		{"openwrt", "f1", 10, "logread -e f1 | tail -n 10"},
		{"unknown", "x", 10, ""},
	}

	for _, tt := range tests {
		got := m.buildLogsCommand(tt.svcType, tt.name, tt.lines)
		if got != tt.want {
			t.Errorf("buildLogsCommand(%q, %q, %d) = %q, want %q", tt.svcType, tt.name, tt.lines, got, tt.want)
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
