package engine

import (
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestDeepMerge(t *testing.T) {
	tests := []struct {
		name    string
		base    map[string]interface{}
		overlay map[string]interface{}
		want    map[string]interface{}
	}{
		{
			name:    "nil base",
			base:    nil,
			overlay: map[string]interface{}{"a": "1"},
			want:    map[string]interface{}{"a": "1"},
		},
		{
			name:    "nil overlay",
			base:    map[string]interface{}{"a": "1"},
			overlay: nil,
			want:    map[string]interface{}{"a": "1"},
		},
		{
			name:    "both nil",
			base:    nil,
			overlay: nil,
			want:    nil,
		},
		{
			name:    "simple key override",
			base:    map[string]interface{}{"a": "old", "b": "keep"},
			overlay: map[string]interface{}{"a": "new"},
			want:    map[string]interface{}{"a": "new", "b": "keep"},
		},
		{
			name: "nested map merge",
			base: map[string]interface{}{
				"services": map[string]interface{}{
					"web": map[string]interface{}{"image": "old", "port": 80},
				},
			},
			overlay: map[string]interface{}{
				"services": map[string]interface{}{
					"web": map[string]interface{}{"image": "new"},
				},
			},
			want: map[string]interface{}{
				"services": map[string]interface{}{
					"web": map[string]interface{}{"image": "new", "port": 80},
				},
			},
		},
		{
			name: "list override (not append)",
			base: map[string]interface{}{
				"volumes": []interface{}{"a", "b"},
			},
			overlay: map[string]interface{}{
				"volumes": []interface{}{"c"},
			},
			want: map[string]interface{}{
				"volumes": []interface{}{"c"},
			},
		},
		{
			name: "add new key",
			base: map[string]interface{}{"a": "1"},
			overlay: map[string]interface{}{"b": "2"},
			want: map[string]interface{}{"a": "1", "b": "2"},
		},
		{
			name: "deep nested merge",
			base: map[string]interface{}{
				"a": map[string]interface{}{
					"b": map[string]interface{}{
						"c": "old",
						"d": "keep",
					},
				},
			},
			overlay: map[string]interface{}{
				"a": map[string]interface{}{
					"b": map[string]interface{}{
						"c": "new",
					},
				},
			},
			want: map[string]interface{}{
				"a": map[string]interface{}{
					"b": map[string]interface{}{
						"c": "new",
						"d": "keep",
					},
				},
			},
		},
		{
			name: "map overrides scalar",
			base: map[string]interface{}{"a": "scalar"},
			overlay: map[string]interface{}{"a": map[string]interface{}{"nested": true}},
			want: map[string]interface{}{"a": map[string]interface{}{"nested": true}},
		},
		{
			name: "scalar overrides map",
			base: map[string]interface{}{"a": map[string]interface{}{"nested": true}},
			overlay: map[string]interface{}{"a": "scalar"},
			want: map[string]interface{}{"a": "scalar"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deepMerge(tt.base, tt.overlay)
			if !mapsEqual(got, tt.want) {
				t.Errorf("deepMerge() = %v, want %v", got, tt.want)
			}
		})
	}
}

func mapsEqual(a, b map[string]interface{}) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	if len(a) != len(b) {
		return false
	}
	for k, va := range a {
		vb, ok := b[k]
		if !ok {
			return false
		}
		if !valEqual(va, vb) {
			return false
		}
	}
	return true
}

func valEqual(a, b interface{}) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	switch av := a.(type) {
	case map[string]interface{}:
		bv, ok := b.(map[string]interface{})
		if !ok {
			return false
		}
		return mapsEqual(av, bv)
	case []interface{}:
		bv, ok := b.([]interface{})
		if !ok {
			return false
		}
		if len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !valEqual(av[i], bv[i]) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}

func TestMergeYAMLFiles(t *testing.T) {
	dir := t.TempDir()

	baseYAML := `
services:
  web:
    image: nginx
    ports:
      - "80:80"
`
	overlayYAML := `
services:
  web:
    image: nginx:alpine
  db:
    image: postgres
`
	baseFile := dir + "/base.yaml"
	overlayFile := dir + "/overlay.yaml"
	writeFile(t, baseFile, baseYAML)
	writeFile(t, overlayFile, overlayYAML)

	d := &ComposeDriver{baseDir: dir}
	merged, err := d.mergeYAMLFiles([]string{baseFile, overlayFile})
	if err != nil {
		t.Fatalf("mergeYAMLFiles error: %v", err)
	}

	result := string(merged)
	if result == "" {
		t.Error("merged output should not be empty")
	}
}

func TestMergeYAMLFilesSingleFile(t *testing.T) {
	dir := t.TempDir()

	yaml := `services:
  web:
    image: nginx
`
	f := dir + "/single.yaml"
	writeFile(t, f, yaml)

	d := &ComposeDriver{baseDir: dir}
	merged, err := d.mergeYAMLFiles([]string{f})
	if err != nil {
		t.Fatalf("mergeYAMLFiles error: %v", err)
	}
	if len(merged) == 0 {
		t.Error("merged output should not be empty")
	}
}

func TestMergeYAMLFilesMissingFile(t *testing.T) {
	d := &ComposeDriver{}
	_, err := d.mergeYAMLFiles([]string{"/nonexistent/file.yaml"})
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestMergeYAMLFilesInvalidYAML(t *testing.T) {
	dir := t.TempDir()
	f := dir + "/bad.yaml"
	writeFile(t, f, `{{invalid yaml`)

	d := &ComposeDriver{baseDir: dir}
	_, err := d.mergeYAMLFiles([]string{f})
	if err == nil {
		t.Error("expected error for invalid YAML")
	}
}

func TestNewComposeDriver(t *testing.T) {
	d := NewComposeDriver("/base", "/key", "mybundle")
	if d.baseDir != "/base" {
		t.Errorf("baseDir = %q, want %q", d.baseDir, "/base")
	}
	if d.sshKey != "/key" {
		t.Errorf("sshKey = %q, want %q", d.sshKey, "/key")
	}
	if d.bundleName != "mybundle" {
		t.Errorf("bundleName = %q, want %q", d.bundleName, "mybundle")
	}
}

func TestNewComposeDriverWithDefaults(t *testing.T) {
	defaults := config.DefaultsConfig{LogLines: 100}
	d := NewComposeDriverWithDefaults("/base", "/key", "mybundle", defaults)
	if d.defaults.LogLines != 100 {
		t.Errorf("defaults.LogLines = %d, want 100", d.defaults.LogLines)
	}
}
