package engine

import (
	"os"
	"testing"
	"time"
)

func TestParseSSHAddress(t *testing.T) {
	originalUser := os.Getenv("USER")
	os.Setenv("USER", "testuser")
	defer os.Setenv("USER", originalUser)

	tests := []struct {
		name      string
		address   string
		wantUser  string
		wantHost  string
		wantErr   bool
	}{
		{"user@host", "deploy@myserver", "deploy", "myserver", false},
		{"user@ip", "admin@192.168.1.1", "admin", "192.168.1.1", false},
		{"host only", "myserver", "testuser", "myserver", false},
		{"empty", "", "", "", true},
		{"user@empty", "user@", "user", "", true},
		{"multiple at", "a@b@c", "a@b", "c", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			user, host, err := parseSSHAddress(tt.address)
			if (err != nil) != tt.wantErr {
				t.Errorf("parseSSHAddress(%q) error = %v, wantErr %v", tt.address, err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				if user != tt.wantUser {
					t.Errorf("parseSSHAddress(%q) user = %q, want %q", tt.address, user, tt.wantUser)
				}
				if host != tt.wantHost {
					t.Errorf("parseSSHAddress(%q) host = %q, want %q", tt.address, host, tt.wantHost)
				}
			}
		})
	}
}

func TestPoolKey(t *testing.T) {
	tests := []struct {
		addr, key, want string
	}{
		{"user@host1", "/path/key1", "user@host1|/path/key1"},
		{"user@host2", "/path/key1", "user@host2|/path/key1"},
		{"user@host1", "/path/key2", "user@host1|/path/key2"},
	}

	for _, tt := range tests {
		got := poolKey(tt.addr, tt.key)
		if got != tt.want {
			t.Errorf("poolKey(%q, %q) = %q, want %q", tt.addr, tt.key, got, tt.want)
		}
	}

	if poolKey("a", "b") == poolKey("c", "d") {
		t.Error("poolKey should produce unique keys for different inputs")
	}
}

func TestNewSSHClient(t *testing.T) {
	c, err := NewSSHClient("user@host", "/fake/key")
	if err != nil {
		t.Fatalf("NewSSHClient returned error: %v", err)
	}
	if c.address != "user@host" {
		t.Errorf("address = %q, want %q", c.address, "user@host")
	}
	if c.sshKey != "/fake/key" {
		t.Errorf("sshKey = %q, want %q", c.sshKey, "/fake/key")
	}
	if c.port != "22" {
		t.Errorf("default port = %q, want %q", c.port, "22")
	}
	if c.timeout != 30*time.Second {
		t.Errorf("default timeout = %v, want %v", c.timeout, 30*time.Second)
	}
}

func TestWithSSHPort(t *testing.T) {
	c, _ := NewSSHClient("user@host", "/key", WithSSHPort("2222"))
	if c.port != "2222" {
		t.Errorf("port = %q, want %q", c.port, "2222")
	}
}

func TestWithTimeout(t *testing.T) {
	d := 5 * time.Second
	c, _ := NewSSHClient("user@host", "/key", WithTimeout(d))
	if c.timeout != d {
		t.Errorf("timeout = %v, want %v", c.timeout, d)
	}
}

func TestWithKnownHosts(t *testing.T) {
	c, _ := NewSSHClient("user@host", "/key", WithKnownHosts("/path/known_hosts"))
	if c.knownHosts != "/path/known_hosts" {
		t.Errorf("knownHosts = %q, want %q", c.knownHosts, "/path/known_hosts")
	}
}

func TestMultipleOptions(t *testing.T) {
	c, _ := NewSSHClient("user@host", "/key",
		WithSSHPort("2222"),
		WithTimeout(10*time.Second),
		WithKnownHosts("/path/kh"),
	)
	if c.port != "2222" {
		t.Errorf("port = %q, want %q", c.port, "2222")
	}
	if c.timeout != 10*time.Second {
		t.Errorf("timeout = %v, want %v", c.timeout, 10*time.Second)
	}
	if c.knownHosts != "/path/kh" {
		t.Errorf("knownHosts = %q, want %q", c.knownHosts, "/path/kh")
	}
}

func TestSSHClientIsConnected(t *testing.T) {
	c, _ := NewSSHClient("user@host", "/key")
	if c.IsConnected() {
		t.Error("new client should not be connected")
	}
}

func TestSSHClientAddress(t *testing.T) {
	c, _ := NewSSHClient("user@host", "/key")
	if c.Address() != "user@host" {
		t.Errorf("Address() = %q, want %q", c.Address(), "user@host")
	}
}

func TestSSHClientClose(t *testing.T) {
	c, _ := NewSSHClient("user@host", "/key")
	if err := c.Close(); err != nil {
		t.Errorf("Close() on unconnected client returned error: %v", err)
	}
}

func TestNewSSHClientPool(t *testing.T) {
	pool := NewSSHClientPool()
	if len(pool.clients) != 0 {
		t.Error("new pool should be empty")
	}
}

func TestSSHClientPoolCloseAll(t *testing.T) {
	pool := NewSSHClientPool()
	pool.CloseAll()
	if len(pool.clients) != 0 {
		t.Error("pool should be empty after CloseAll")
	}
}
