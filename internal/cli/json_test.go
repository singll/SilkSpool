package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestExitCode(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"nil", nil, ExitOK},
		{"usage", fmt.Errorf("usage: spool demo"), ExitUsage},
		{"config", fmt.Errorf("failed to load config: %w", errors.New("missing")), ExitUsage},
		{"explicit diff", newExitError(ExitDiff, "diff", errors.New("drift")), ExitDiff},
		{"explicit approval", newExitError(ExitApproval, "approval_required", errors.New("needs yes")), ExitApproval},
		{"execution", errors.New("ssh connect failed"), ExitFailed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ExitCode(tt.err); got != tt.want {
				t.Errorf("ExitCode() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestReportErrorJSON(t *testing.T) {
	old := jsonFlag
	defer func() { jsonFlag = old }()
	jsonFlag = true

	var buf bytes.Buffer
	err := newExitError(ExitApproval, "approval_required", errors.New("pass --yes"))
	ReportError(&buf, err)

	var env JSONEnvelope
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal error envelope: %v\n%s", err, buf.String())
	}
	if env.OK {
		t.Error("error envelope should not be ok")
	}
	if env.Error == nil || env.Error.Code != "approval_required" || env.Error.Message != "pass --yes" {
		t.Errorf("unexpected error payload: %+v", env.Error)
	}
	if len(env.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", env.Warnings)
	}
}

func TestReportErrorHuman(t *testing.T) {
	old := jsonFlag
	defer func() { jsonFlag = old }()
	jsonFlag = false

	var buf bytes.Buffer
	ReportError(&buf, errors.New("boom"))
	if got := buf.String(); got != "Error: boom\n" {
		t.Errorf("unexpected human error output: %q", got)
	}
}

func TestWriteJSONNilWarnings(t *testing.T) {
	var buf bytes.Buffer
	if err := writeJSON(&buf, map[string]string{"host": "keeper"}, nil); err != nil {
		t.Fatal(err)
	}
	var env JSONEnvelope
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if !env.OK {
		t.Error("expected ok envelope")
	}
	if env.Warnings == nil || len(env.Warnings) != 0 {
		t.Errorf("warnings = %v, want empty array", env.Warnings)
	}
}
