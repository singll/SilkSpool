package cli

import (
	"bytes"
	"testing"
)

func TestRootCommandUse(t *testing.T) {
	cmd := NewRootCmd()
	if cmd.Use != "spool" {
		t.Errorf("root command Use = %q, want %q", cmd.Use, "spool")
	}
}

func TestRootCommandShort(t *testing.T) {
	cmd := NewRootCmd()
	if cmd.Short == "" {
		t.Error("root command Short should not be empty")
	}
}

func TestRootCommandLong(t *testing.T) {
	cmd := NewRootCmd()
	if cmd.Long == "" {
		t.Error("root command Long should not be empty")
	}
}

func TestRootCommandSilenceUsage(t *testing.T) {
	cmd := NewRootCmd()
	if !cmd.SilenceUsage {
		t.Error("root command SilenceUsage should be true")
	}
}

func TestVersionCommand(t *testing.T) {
	cmd := NewRootCmd()

	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"version"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("version command failed: %v", err)
	}

	if Version == "" {
		t.Error("Version should not be empty")
	}
}

func TestRootCommandHasPersistentFlags(t *testing.T) {
	cmd := NewRootCmd()
	verboseFlag := cmd.PersistentFlags().Lookup("verbose")
	if verboseFlag == nil {
		t.Error("root command should have verbose flag")
	}

	configFlag := cmd.PersistentFlags().Lookup("config")
	if configFlag == nil {
		t.Error("root command should have config flag")
	}
}

func TestRootCommandHelp(t *testing.T) {
	cmd := NewRootCmd()

	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetArgs([]string{"--help"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("help command failed: %v", err)
	}

	output := buf.String()
	if output == "" {
		t.Error("help should produce output")
	}
}
