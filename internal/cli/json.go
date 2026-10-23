package cli

import (
	"encoding/json"
	"io"
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
