package engine

import (
	"os"
	"path/filepath"
	"testing"
)

func TestComposeBundleTemplatesRender(t *testing.T) {
	bundlesDir := filepath.Join("..", "..", "bundles")
	entries, err := os.ReadDir(bundlesDir)
	if err != nil {
		t.Skipf("bundles dir unavailable: %v", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		manifest, err := NewManifestLoader(filepath.Join("..", "..")).Load(name)
		if err != nil {
			continue
		}
		if manifest.Type != "compose" || len(manifest.Templates) == 0 {
			continue
		}

		t.Run(name, func(t *testing.T) {
			var templates [][]byte
			for _, tmpl := range manifest.Templates {
				data, err := os.ReadFile(filepath.Join(bundlesDir, name, "templates", tmpl))
				if err != nil {
					t.Fatalf("read template %s: %v", tmpl, err)
				}
				templates = append(templates, data)
			}

			override, err := renderSpoolOverride(templates, "testhost", name, manifest.Version)
			if err != nil {
				t.Fatalf("render override: %v", err)
			}
			if len(override) == 0 {
				t.Fatal("override is empty")
			}

			base, err := renderComposeBase(manifest.Templates, templates)
			if err != nil {
				t.Fatalf("render base: %v", err)
			}
			if len(base) == 0 {
				t.Fatal("base is empty")
			}
		})
	}
}
