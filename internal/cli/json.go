package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// 统一退出码；与 doc/DECOUPLING-PLAN.md 7.1 保持一致。
const (
	ExitOK       = 0
	ExitUsage    = 2
	ExitDiff     = 3
	ExitFailed   = 4
	ExitApproval = 5
)

// JSONEnvelope is the stable machine-readable envelope for CLI output.
type JSONEnvelope struct {
	OK       bool        `json:"ok"`
	Data     interface{} `json:"data,omitempty"`
	Error    *JSONError  `json:"error,omitempty"`
	Warnings []string    `json:"warnings"`
	JobID    string      `json:"job_id,omitempty"`
}

// JSONError describes a machine-readable CLI error.
type JSONError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ExitError carries an explicit process exit code through Cobra.
type ExitError struct {
	Code int
	Kind string
	Err  error
	// Silent 表示命令已经输出结果（例如 plan diff），main 不再重复打印错误。
	Silent bool
}

func (e *ExitError) Error() string {
	if e.Err == nil {
		return e.Kind
	}
	return e.Err.Error()
}

func (e *ExitError) Unwrap() error { return e.Err }

// ExitCode maps an error to the documented CLI exit code.
func ExitCode(err error) int {
	if err == nil {
		return ExitOK
	}

	var exitErr *ExitError
	if errors.As(err, &exitErr) {
		return exitErr.Code
	}

	msg := strings.ToLower(err.Error())
	if strings.HasPrefix(msg, "usage:") || strings.Contains(msg, "unknown host") ||
		strings.Contains(msg, "host not found") || strings.Contains(msg, "failed to load config") ||
		strings.Contains(msg, "unknown command") || strings.Contains(msg, "unknown flag") ||
		strings.Contains(msg, "flag needs an argument") || strings.Contains(msg, "invalid argument") {
		return ExitUsage
	}
	return ExitFailed
}

// ErrorCode returns a stable machine-readable error code.
func ErrorCode(err error) string {
	var exitErr *ExitError
	if errors.As(err, &exitErr) && exitErr.Kind != "" {
		return exitErr.Kind
	}

	switch ExitCode(err) {
	case ExitUsage:
		return "usage"
	case ExitDiff:
		return "diff"
	case ExitApproval:
		return "approval_required"
	default:
		if strings.Contains(strings.ToLower(err.Error()), "unsupported") {
			return "unsupported"
		}
		return "execution_failed"
	}
}

func newExitError(code int, kind string, err error) error {
	if err == nil {
		return nil
	}
	return &ExitError{Code: code, Kind: kind, Err: err}
}

func writeJSON(w io.Writer, data interface{}, warnings []string) error {
	if warnings == nil {
		warnings = []string{}
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(JSONEnvelope{
		OK:       true,
		Data:     data,
		Warnings: warnings,
	})
}

func writeJSONError(w io.Writer, code string, err error) error {
	message := ""
	if err != nil {
		message = err.Error()
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(JSONEnvelope{
		OK: false,
		Error: &JSONError{
			Code:    code,
			Message: message,
		},
		Warnings: []string{},
	})
}

// JSONMode reports whether --json is active.
func JSONMode() bool { return jsonFlag }

// ReportError writes the final CLI error, using the JSON envelope when --json is active.
func ReportError(w io.Writer, err error) {
	if err == nil {
		return
	}
	var exitErr *ExitError
	if errors.As(err, &exitErr) && exitErr.Silent {
		return
	}
	if jsonFlag {
		_ = writeJSONError(w, ErrorCode(err), err)
		return
	}
	fmt.Fprintf(w, "Error: %v\n", err)
}
