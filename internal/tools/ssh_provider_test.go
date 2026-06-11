package tools

import (
	"testing"
)

type mockSSHProvider struct {
	executeFunc func(address, sshKey, cmd string) (string, error)
}

func (m *mockSSHProvider) Execute(address, sshKey, cmd string) (string, error) {
	if m.executeFunc != nil {
		return m.executeFunc(address, sshKey, cmd)
	}
	return "", nil
}

func TestSSHProviderInterface(t *testing.T) {
	var _ SSHProvider = &mockSSHProvider{}
}

func TestMockSSHProviderExecute(t *testing.T) {
	provider := &mockSSHProvider{
		executeFunc: func(address, sshKey, cmd string) (string, error) {
			if address == "user@host" && sshKey == "/path/to/key" {
				return "output", nil
			}
			return "", nil
		},
	}

	output, err := provider.Execute("user@host", "/path/to/key", "echo test")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if output != "output" {
		t.Errorf("output = %q, want %q", output, "output")
	}
}
