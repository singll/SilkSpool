package engine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

type fakeOCIRegistry struct {
	server         *httptest.Server
	manifestDigest string
	requests       atomic.Int32
}

func buildBundleLayer(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var raw bytes.Buffer
	gz := gzip.NewWriter(&raw)
	tw := tar.NewWriter(gz)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	for _, name := range names {
		content := files[name]
		header := &tar.Header{Name: name, Mode: 0644, Size: int64(len(content)), Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return raw.Bytes()
}

func newFakeOCIRegistry(t *testing.T, files map[string]string, mutateManifest func(*ociManifest, []byte)) *fakeOCIRegistry {
	t.Helper()
	layer := buildBundleLayer(t, files)
	layerDigest := digestBytes(layer)
	config := []byte(`{"bundle":"demo"}`)
	configDigest := digestBytes(config)
	manifest := ociManifest{
		SchemaVersion: 2,
		MediaType:     ociManifestMediaType,
		ArtifactType:  timoniConfigMediaType,
		Config:        ociDescriptor{MediaType: timoniConfigMediaType, Digest: configDigest, Size: int64(len(config))},
		Layers: []ociDescriptor{{
			MediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
			Digest:    layerDigest,
			Size:      int64(len(layer)),
		}},
	}
	if mutateManifest != nil {
		mutateManifest(&manifest, layer)
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest := digestBytes(manifestData)
	registry := &fakeOCIRegistry{manifestDigest: manifestDigest}
	registry.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		registry.requests.Add(1)
		manifestPath := "/v2/demo/bundle/manifests/" + manifestDigest
		switch {
		case r.URL.Path == manifestPath:
			w.Header().Set("Content-Type", ociManifestMediaType)
			_, _ = w.Write(manifestData)
		case strings.HasPrefix(r.URL.Path, "/v2/demo/bundle/blobs/"):
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(layer)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(registry.server.Close)
	return registry
}

func (r *fakeOCIRegistry) source(t *testing.T) config.BundleSourceConfig {
	t.Helper()
	host := strings.TrimPrefix(r.server.URL, "http://")
	return config.BundleSourceConfig{
		Name:     "demo",
		Type:     "oci",
		Ref:      host + "/demo/bundle",
		Digest:   r.manifestDigest,
		Insecure: true,
	}
}

func demoOCIFiles() map[string]string {
	return map[string]string{
		"manifest.yaml": `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: demo
  class: product
  version: 1.0.0
name: demo
type: compose
templates: [compose.yaml]
`,
		"compose.yaml": `services:
  app:
    image: busybox:1.36.1
`,
	}
}

func loadOCIDemo(t *testing.T, dir string, source config.BundleSourceConfig) (*LoadedBundle, error) {
	t.Helper()
	cfg := &config.Config{BundleSources: []config.BundleSourceConfig{source}}
	repo := NewBundleRepository(dir, cfg)
	return repo.Load(context.Background(), "demo", nil)
}

func TestOCISourcePullsPinnedArtifactAndCaches(t *testing.T) {
	dir := t.TempDir()
	registry := newFakeOCIRegistry(t, demoOCIFiles(), nil)
	loaded, err := loadOCIDemo(t, dir, registry.source(t))
	if err != nil {
		t.Fatalf("load OCI bundle: %v", err)
	}
	if loaded.Manifest.Name != "demo" || loaded.Manifest.Version != "1.0.0" {
		t.Fatalf("manifest = %+v", loaded.Manifest)
	}
	if loaded.Source.Type != "oci" || loaded.Source.Digest != registry.manifestDigest {
		t.Fatalf("source = %+v", loaded.Source)
	}
	firstRequests := registry.requests.Load()
	if firstRequests == 0 {
		t.Fatal("expected registry requests on first pull")
	}
	if _, err := loadOCIDemo(t, dir, registry.source(t)); err != nil {
		t.Fatalf("load cached OCI bundle: %v", err)
	}
	if got := registry.requests.Load(); got != firstRequests {
		t.Fatalf("cache hit should not hit registry, requests %d -> %d", firstRequests, got)
	}
	cache := filepath.Join(dir, ".spool", "cache", "bundles", "demo", strings.ReplaceAll(registry.manifestDigest, ":", "-"))
	if _, err := os.Stat(filepath.Join(cache, "manifest.yaml")); err != nil {
		t.Fatalf("cache manifest missing: %v", err)
	}
}

func TestOCISourceRequiresPinnedDigest(t *testing.T) {
	dir := t.TempDir()
	source := config.BundleSourceConfig{Name: "demo", Type: "oci", Ref: "ghcr.io/singll/demo:1.0.0", Insecure: true}
	if _, err := loadOCIDemo(t, dir, source); err == nil || !strings.Contains(err.Error(), "digest is required") {
		t.Fatalf("expected digest error, got %v", err)
	}
}

func TestOCISourceRejectsLayerDigestMismatch(t *testing.T) {
	dir := t.TempDir()
	registry := newFakeOCIRegistry(t, demoOCIFiles(), func(manifest *ociManifest, _ []byte) {
		manifest.Layers[0].Digest = "sha256:" + strings.Repeat("0", 64)
	})
	_, err := loadOCIDemo(t, dir, registry.source(t))
	if err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("expected digest mismatch, got %v", err)
	}
}

func TestOCISourceCosignGate(t *testing.T) {
	dir := t.TempDir()
	registry := newFakeOCIRegistry(t, demoOCIFiles(), nil)
	source := registry.source(t)
	source.Cosign = &config.BundleCosignConfig{Key: "cosign.pub"}

	success := filepath.Join(dir, "cosign-ok")
	if err := os.WriteFile(success, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPOOL_COSIGN_BIN", success)
	if _, err := loadOCIDemo(t, dir, source); err != nil {
		t.Fatalf("cosign success should load: %v", err)
	}

	failure := filepath.Join(dir, "cosign-fail")
	if err := os.WriteFile(failure, []byte("#!/bin/sh\necho 'no signatures found' >&2\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPOOL_COSIGN_BIN", failure)
	if _, err := loadOCIDemo(t, dir, source); err == nil || !strings.Contains(err.Error(), "cosign verification failed") {
		t.Fatalf("expected cosign failure, got %v", err)
	}

	t.Setenv("SPOOL_COSIGN_BIN", filepath.Join(dir, "missing-cosign"))
	if _, err := loadOCIDemo(t, dir, source); err == nil || !strings.Contains(err.Error(), "cosign binary not found") {
		t.Fatalf("expected missing cosign error, got %v", err)
	}
}

func TestOCISourceWithoutCosignDoesNotInvokeCosign(t *testing.T) {
	dir := t.TempDir()
	registry := newFakeOCIRegistry(t, demoOCIFiles(), nil)
	source := registry.source(t)
	marker := filepath.Join(dir, "cosign-called")
	script := filepath.Join(dir, "cosign-marker")
	content := fmt.Sprintf("#!/bin/sh\ntouch %s\nexit 0\n", marker)
	if err := os.WriteFile(script, []byte(content), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPOOL_COSIGN_BIN", script)
	if _, err := loadOCIDemo(t, dir, source); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("cosign must not run when no cosign gate is configured")
	}
}

func TestOCISourceRejectsUnsafeLayerPath(t *testing.T) {
	dir := t.TempDir()
	registry := newFakeOCIRegistry(t, map[string]string{"../escape.yaml": "x"}, nil)
	_, err := loadOCIDemo(t, dir, registry.source(t))
	if err == nil || !strings.Contains(err.Error(), "unsafe path") {
		t.Fatalf("expected unsafe path error, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "..", "escape.yaml")); statErr == nil {
		t.Fatal("unsafe layer entry escaped the cache directory")
	}
}

func TestOCISourceCosignConfigValidation(t *testing.T) {
	dir := t.TempDir()
	registry := newFakeOCIRegistry(t, demoOCIFiles(), nil)
	source := registry.source(t)
	source.Cosign = &config.BundleCosignConfig{}
	if _, err := loadOCIDemo(t, dir, source); err == nil || !strings.Contains(err.Error(), "requires either key") {
		t.Fatalf("expected cosign config error, got %v", err)
	}
}

func TestOCIReferenceNormalizesDigest(t *testing.T) {
	raw := strings.Repeat("a", 64)
	ref, err := parseOCIReference("ghcr.io/singll/demo@"+raw, false)
	if err != nil {
		t.Fatal(err)
	}
	if ref.Digest != "sha256:"+raw {
		t.Fatalf("digest = %q", ref.Digest)
	}
	sum := sha256.Sum256([]byte("x"))
	bad := hex.EncodeToString(sum[:]) + "0"
	if _, err := parseOCIReference("ghcr.io/singll/demo@sha256:"+bad, false); err == nil {
		t.Fatal("expected invalid digest")
	}
}
