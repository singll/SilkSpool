package utils

import (
	"bytes"
	"strings"
	"testing"
)

func TestNewLogger(t *testing.T) {
	logger := NewLogger()
	if logger == nil {
		t.Fatal("NewLogger returned nil")
	}
	if logger.writer == nil {
		t.Error("logger.writer should not be nil")
	}
}

func TestLoggerSetOutput(t *testing.T) {
	logger := NewLogger()
	var buf bytes.Buffer
	logger.SetOutput(&buf)

	logger.Info("test message")

	if buf.Len() == 0 {
		t.Error("expected output, got empty buffer")
	}
}

func TestLoggerInfo(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger()
	logger.SetOutput(&buf)

	logger.Info("test %s", "message")

	output := buf.String()
	if !strings.Contains(output, "test message") {
		t.Errorf("output should contain 'test message', got: %s", output)
	}
}

func TestLoggerWarn(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger()
	logger.SetOutput(&buf)

	logger.Warn("warning %s", "message")

	output := buf.String()
	if !strings.Contains(output, "warning message") {
		t.Errorf("output should contain 'warning message', got: %s", output)
	}
}

func TestLoggerError(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger()
	logger.SetOutput(&buf)

	logger.Error("error %s", "message")

	output := buf.String()
	if !strings.Contains(output, "error message") {
		t.Errorf("output should contain 'error message', got: %s", output)
	}
}

func TestLoggerSuccess(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger()
	logger.SetOutput(&buf)

	logger.Success("success %s", "message")

	output := buf.String()
	if !strings.Contains(output, "success message") {
		t.Errorf("output should contain 'success message', got: %s", output)
	}
}

func TestLoggerStep(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger()
	logger.SetOutput(&buf)

	logger.Step("step %s", "message")

	output := buf.String()
	if !strings.Contains(output, "step message") {
		t.Errorf("output should contain 'step message', got: %s", output)
	}
}

func TestGetTimestamp(t *testing.T) {
	ts := getTimestamp()

	if ts == "" {
		t.Error("getTimestamp returned empty string")
	}

	if !strings.Contains(ts, " ") {
		t.Error("timestamp should contain space for alignment")
	}

	if len(ts) < 19 {
		t.Errorf("timestamp too short: %q (expected at least 19 chars for YYYY-MM-DD HH:MM:SS)", ts)
	}
}

func TestLogLevelConstants(t *testing.T) {
	levels := []LogLevel{
		LogLevelInfo,
		LogLevelWarn,
		LogLevelError,
		LogLevelSuccess,
		LogLevelStep,
	}

	for i, level := range levels {
		if int(level) != i {
			t.Errorf("LogLevel %d has unexpected value %d", i, level)
		}
	}
}

func TestDefaultLogger(t *testing.T) {
	if DefaultLogger == nil {
		t.Error("DefaultLogger should not be nil")
	}
}

func TestGlobalFunctions(t *testing.T) {
	var buf bytes.Buffer
	original := DefaultLogger.writer
	DefaultLogger.SetOutput(&buf)
	defer DefaultLogger.SetOutput(original)

	Info("info test")
	if !strings.Contains(buf.String(), "info test") {
		t.Error("Info function failed")
	}
	buf.Reset()

	Warn("warn test")
	if !strings.Contains(buf.String(), "warn test") {
		t.Error("Warn function failed")
	}
	buf.Reset()

	Error("error test")
	if !strings.Contains(buf.String(), "error test") {
		t.Error("Error function failed")
	}
	buf.Reset()

	Success("success test")
	if !strings.Contains(buf.String(), "success test") {
		t.Error("Success function failed")
	}
	buf.Reset()

	Step("step test")
	if !strings.Contains(buf.String(), "step test") {
		t.Error("Step function failed")
	}
}
