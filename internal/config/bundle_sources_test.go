package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigParsesOCIBundleSource(t *testing.T) {
	dir := t.TempDir()
	content := `bundle_sources:
  - name: legacy
    type: dir
    path: ./bundles
  - name: product
    type: git
    repo: https://example.test/repo.git
    path: deploy
    commit: abcdef1
  - name: oci-product
    type: oci
    ref: ghcr.io/singll/product-bundle
    digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    path: deploy
    insecure: true
    username: robot
    password_env: OCI_TOKEN
    cosign:
      identity: https://example.test/ci
      issuer: https://token.example.test
`
	if err := os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.BundleSources) != 3 {
		t.Fatalf("sources = %+v", cfg.BundleSources)
	}
	oci := cfg.BundleSources[2]
	if oci.Type != "oci" || oci.Ref == "" || oci.Digest == "" || !oci.Insecure || oci.PasswordEnv != "OCI_TOKEN" {
		t.Fatalf("oci source = %+v", oci)
	}
	if oci.Cosign == nil || oci.Cosign.Identity == "" || oci.Cosign.Issuer == "" {
		t.Fatalf("cosign = %+v", oci.Cosign)
	}
	if cfg.BundleSources[0].Type != "dir" || cfg.BundleSources[1].Type != "git" {
		t.Fatalf("legacy sources = %+v", cfg.BundleSources[:2])
	}
}
