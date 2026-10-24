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
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	ociManifestMediaType       = "application/vnd.oci.image.manifest.v1+json"
	ociIndexMediaType          = "application/vnd.oci.image.index.v1+json"
	timoniConfigMediaType      = "application/vnd.timoni.config.v1+json"
	spoolBundleConfigMediaType = "application/vnd.spool.bundle.config.v1+json"
)

// ociHTTPClient 用于拉取 bundle artifact；测试可通过 httptest 复用。
var ociHTTPClient = &http.Client{Timeout: 2 * time.Minute}

type ociReference struct {
	Registry   string
	Repository string
	Tag        string
	Digest     string
	Insecure   bool
}

func (r ociReference) Name() string {
	return r.Registry + "/" + r.Repository
}

func (r ociReference) String() string {
	value := r.Name()
	if r.Tag != "" {
		value += ":" + r.Tag
	}
	if r.Digest != "" {
		value += "@" + r.Digest
	}
	return value
}

func (r ociReference) baseURL() string {
	scheme := "https"
	if r.Insecure {
		scheme = "http"
	}
	return scheme + "://" + r.Registry
}

type ociDescriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

type ociManifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType"`
	ArtifactType  string            `json:"artifactType,omitempty"`
	Config        ociDescriptor     `json:"config"`
	Layers        []ociDescriptor   `json:"layers"`
	Annotations   map[string]string `json:"annotations,omitempty"`
}

// parseOCIReference 解析 registry/repo[:tag]@sha256:...；只支持显式 registry。
func parseOCIReference(raw string, insecure bool) (ociReference, error) {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(value, "oci://")
	if value == "" {
		return ociReference{}, fmt.Errorf("oci source: ref is required")
	}
	ref := ociReference{Insecure: insecure}
	if idx := strings.LastIndex(value, "@"); idx >= 0 {
		ref.Digest = strings.TrimSpace(value[idx+1:])
		value = value[:idx]
	}
	if ref.Digest != "" {
		normalized, err := normalizeOCIDigest(ref.Digest)
		if err != nil {
			return ociReference{}, err
		}
		ref.Digest = normalized
	}
	lastSlash := strings.LastIndex(value, "/")
	if lastSlash < 0 {
		return ociReference{}, fmt.Errorf("oci source %q: ref must include a registry and repository", raw)
	}
	lastColon := strings.LastIndex(value, ":")
	if lastColon > lastSlash {
		ref.Tag = value[lastColon+1:]
		value = value[:lastColon]
	}
	firstSlash := strings.Index(value, "/")
	if firstSlash < 0 {
		return ociReference{}, fmt.Errorf("oci source %q: repository is required", raw)
	}
	ref.Registry = value[:firstSlash]
	ref.Repository = strings.Trim(value[firstSlash+1:], "/")
	if ref.Registry == "" || ref.Repository == "" {
		return ociReference{}, fmt.Errorf("oci source %q: invalid registry/repository", raw)
	}
	if !strings.Contains(ref.Registry, ".") && !strings.Contains(ref.Registry, ":") && ref.Registry != "localhost" {
		return ociReference{}, fmt.Errorf("oci source %q: registry must be explicit (got %q)", raw, ref.Registry)
	}
	if ref.Digest == "" {
		return ociReference{}, fmt.Errorf("oci source %q: digest is required; tags alone are not reproducible", raw)
	}
	return ref, nil
}

func normalizeOCIDigest(value string) (string, error) {
	digest := strings.TrimSpace(value)
	if !strings.Contains(digest, ":") {
		if len(digest) == 64 {
			digest = "sha256:" + digest
		} else {
			return "", fmt.Errorf("oci digest %q must be sha256:<64 hex>", value)
		}
	}
	algorithm, encoded, ok := strings.Cut(digest, ":")
	if !ok || algorithm != "sha256" {
		return "", fmt.Errorf("oci digest %q: unsupported algorithm (want sha256)", value)
	}
	if len(encoded) != 64 {
		return "", fmt.Errorf("oci digest %q: sha256 digest must be 64 hex chars", value)
	}
	if _, err := hex.DecodeString(encoded); err != nil {
		return "", fmt.Errorf("oci digest %q: invalid hex: %w", value, err)
	}
	return "sha256:" + strings.ToLower(encoded), nil
}

func digestBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (r *BundleRepository) loadFromOCI(ctx context.Context, name string, src *BundleSource) (*LoadedBundle, error) {
	if src == nil {
		return nil, fmt.Errorf("bundle source %s: oci source is nil", name)
	}
	raw := strings.TrimSpace(src.Ref)
	if raw == "" {
		raw = strings.TrimSpace(src.Repo)
	}
	pinned := ""
	if src.Digest != "" {
		normalized, err := normalizeOCIDigest(src.Digest)
		if err != nil {
			return nil, fmt.Errorf("bundle source %s: %w", name, err)
		}
		pinned = normalized
		if raw == "" {
			raw = pinned
		} else if !strings.Contains(raw, "@") {
			raw += "@" + pinned
		}
	}
	ref, err := parseOCIReference(raw, src.Insecure)
	if err != nil {
		return nil, fmt.Errorf("bundle source %s: %w", name, err)
	}
	if pinned != "" && ref.Digest != pinned {
		return nil, fmt.Errorf("bundle source %s: ref digest %s conflicts with digest field %s", name, ref.Digest, pinned)
	}
	if err := validateCosignConfig(name, src.Cosign); err != nil {
		return nil, err
	}
	if err := validateOCIPath(name, src.Path); err != nil {
		return nil, err
	}

	if src.Cosign != nil {
		if err := verifyCosignArtifact(ctx, r.baseDir, name, ref, src.Cosign); err != nil {
			return nil, err
		}
	}

	cacheDigest := strings.ReplaceAll(ref.Digest, ":", "-")
	cacheRoot := filepath.Join(r.baseDir, ".spool", "cache", "bundles", name, cacheDigest)
	if loaded, err := loadOCIFromCache(name, cacheRoot, src); err == nil {
		return loaded, nil
	}

	if err := pullOCIArtifact(ctx, cacheRoot, ref, src); err != nil {
		return nil, fmt.Errorf("bundle source %s: %w", name, err)
	}
	loaded, err := loadOCIFromCache(name, cacheRoot, src)
	if err != nil {
		return nil, err
	}
	loaded.Source = BundleSource{
		Type:        "oci",
		Ref:         ref.Name(),
		Digest:      ref.Digest,
		Path:        src.Path,
		Insecure:    src.Insecure,
		Username:    src.Username,
		PasswordEnv: src.PasswordEnv,
		Cosign:      src.Cosign,
	}
	return loaded, nil
}

func loadOCIFromCache(name, cacheRoot string, src *BundleSource) (*LoadedBundle, error) {
	root := cacheRoot
	if strings.TrimSpace(src.Path) != "" {
		root = filepath.Join(cacheRoot, filepath.FromSlash(src.Path))
	}
	if _, err := FindManifestFile(root); err != nil {
		if root == cacheRoot {
			return nil, err
		}
		candidate := filepath.Join(root, name)
		if _, err2 := FindManifestFile(candidate); err2 != nil {
			return nil, err
		}
		root = candidate
	}
	manifest, err := LoadManifestFromDir(root, name)
	if err != nil {
		return nil, err
	}
	return &LoadedBundle{Name: name, Root: root, Manifest: manifest}, nil
}

func pullOCIArtifact(ctx context.Context, cacheRoot string, ref ociReference, src *BundleSource) error {
	password := ""
	if src.Username != "" {
		env := src.PasswordEnv
		if env == "" {
			env = "SPOOL_OCI_PASSWORD"
		}
		password = os.Getenv(env)
		if password == "" {
			return fmt.Errorf("registry password env %s is empty", env)
		}
	}

	_, manifest, err := fetchOCIManifest(ctx, ref, src.Username, password)
	if err != nil {
		return err
	}
	if manifest.Config.MediaType != "" && !supportedOCIConfigMediaType(manifest.Config.MediaType) {
		return fmt.Errorf("unsupported OCI config media type %q", manifest.Config.MediaType)
	}

	var layers []ociDescriptor
	for _, layer := range manifest.Layers {
		if strings.Contains(layer.MediaType, "tar") {
			layers = append(layers, layer)
		}
	}
	if len(layers) == 0 {
		return fmt.Errorf("OCI artifact has no bundle tar layer")
	}

	if err := os.MkdirAll(filepath.Dir(cacheRoot), 0755); err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp(filepath.Dir(cacheRoot), ".oci-pull-")
	if err != nil {
		return err
	}
	keepTmp := false
	defer func() {
		if !keepTmp {
			_ = os.RemoveAll(tmpDir)
		}
	}()

	for _, layer := range layers {
		data, err := fetchOCIBlob(ctx, ref, layer, src.Username, password)
		if err != nil {
			return err
		}
		if err := extractOCILayer(data, layer.MediaType, tmpDir); err != nil {
			return err
		}
	}

	metadata := map[string]string{
		"ref":         ref.String(),
		"digest":      ref.Digest,
		"source_type": "oci",
	}
	if data, err := json.MarshalIndent(metadata, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(tmpDir, ".oci-source.json"), append(data, '\n'), 0644)
	}

	if err := os.RemoveAll(cacheRoot); err != nil {
		return err
	}
	if err := os.Rename(tmpDir, cacheRoot); err != nil {
		return err
	}
	keepTmp = true
	return nil
}

func supportedOCIConfigMediaType(mediaType string) bool {
	switch mediaType {
	case timoniConfigMediaType, spoolBundleConfigMediaType,
		"application/vnd.oci.empty.v1+json",
		"application/vnd.oci.image.config.v1+json":
		return true
	default:
		return strings.Contains(mediaType, "config")
	}
}

func fetchOCIManifest(ctx context.Context, ref ociReference, username, password string) ([]byte, ociManifest, error) {
	url := ref.baseURL() + "/v2/" + ref.Repository + "/manifests/" + ref.Digest
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, ociManifest{}, err
	}
	request.Header.Set("Accept", ociManifestMediaType+", application/vnd.docker.distribution.manifest.v2+json")
	if username != "" {
		request.SetBasicAuth(username, password)
	}
	response, err := ociHTTPClient.Do(request)
	if err != nil {
		return nil, ociManifest{}, fmt.Errorf("fetch OCI manifest: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, ociManifest{}, fmt.Errorf("read OCI manifest: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return nil, ociManifest{}, fmt.Errorf("fetch OCI manifest %s: HTTP %d: %s", ref, response.StatusCode, strings.TrimSpace(string(body)))
	}
	if got := digestBytes(body); got != ref.Digest {
		return nil, ociManifest{}, fmt.Errorf("OCI manifest digest mismatch: requested %s, got %s", ref.Digest, got)
	}
	var manifest ociManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nil, ociManifest{}, fmt.Errorf("parse OCI manifest: %w", err)
	}
	if manifest.MediaType == ociIndexMediaType {
		return nil, ociManifest{}, fmt.Errorf("OCI artifact %s is an index; pin a single manifest digest", ref)
	}
	return body, manifest, nil
}

func fetchOCIBlob(ctx context.Context, ref ociReference, descriptor ociDescriptor, username, password string) ([]byte, error) {
	url := ref.baseURL() + "/v2/" + ref.Repository + "/blobs/" + descriptor.Digest
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if username != "" {
		request.SetBasicAuth(username, password)
	}
	response, err := ociHTTPClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch OCI blob %s: %w", descriptor.Digest, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 512<<20))
	if err != nil {
		return nil, fmt.Errorf("read OCI blob %s: %w", descriptor.Digest, err)
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch OCI blob %s: HTTP %d: %s", descriptor.Digest, response.StatusCode, strings.TrimSpace(string(body)))
	}
	if descriptor.Size > 0 && int64(len(body)) != descriptor.Size {
		return nil, fmt.Errorf("OCI blob %s size mismatch: descriptor=%d actual=%d", descriptor.Digest, descriptor.Size, len(body))
	}
	if got := digestBytes(body); got != descriptor.Digest {
		return nil, fmt.Errorf("OCI blob digest mismatch: descriptor=%s actual=%s", descriptor.Digest, got)
	}
	return body, nil
}

func extractOCILayer(data []byte, mediaType, dst string) error {
	var reader io.Reader = bytes.NewReader(data)
	if strings.Contains(mediaType, "gzip") || (len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b) {
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return fmt.Errorf("open OCI gzip layer: %w", err)
		}
		defer gz.Close()
		reader = gz
	}
	tarReader := tar.NewReader(reader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read OCI tar layer: %w", err)
		}
		name, err := safeBundlePath(header.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		target := filepath.Join(dst, name)
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			mode := os.FileMode(0644)
			if header.Mode&0111 != 0 {
				mode = 0755
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
			if err != nil {
				return err
			}
			if _, err := io.Copy(file, tarReader); err != nil {
				file.Close()
				return err
			}
			if err := file.Close(); err != nil {
				return err
			}
		default:
			return fmt.Errorf("OCI bundle layer contains unsupported entry %q (type %d)", header.Name, header.Typeflag)
		}
	}
}

func safeBundlePath(name string) (string, error) {
	native := filepath.FromSlash(name)
	if filepath.IsAbs(native) {
		return "", fmt.Errorf("OCI bundle layer contains unsafe absolute path %q", name)
	}
	clean := filepath.Clean(native)
	if clean == "." || clean == "" {
		return "", nil
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("OCI bundle layer contains unsafe path %q", name)
	}
	return clean, nil
}

func validateOCIPath(name, path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	native := filepath.FromSlash(path)
	clean := filepath.Clean(native)
	if filepath.IsAbs(native) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("bundle source %s: oci path %q must stay inside the artifact", name, path)
	}
	return nil
}

func validateCosignConfig(name string, config *BundleCosign) error {
	if config == nil {
		return nil
	}
	if config.Key != "" {
		if config.Identity != "" || config.Issuer != "" {
			return fmt.Errorf("bundle source %s: cosign.key cannot be combined with identity/issuer", name)
		}
		return nil
	}
	if config.Identity == "" || config.Issuer == "" {
		return fmt.Errorf("bundle source %s: cosign verification requires either key or both identity and issuer", name)
	}
	return nil
}

func verifyCosignArtifact(ctx context.Context, baseDir, name string, ref ociReference, config *BundleCosign) error {
	if config == nil {
		return nil
	}
	bin := os.Getenv("SPOOL_COSIGN_BIN")
	if bin == "" {
		bin = "cosign"
	}
	resolved, err := exec.LookPath(bin)
	if err != nil {
		return fmt.Errorf("bundle source %s: cosign verification required but cosign binary not found: %w", name, err)
	}
	args := []string{"verify"}
	if config.Key != "" {
		key := config.Key
		if !filepath.IsAbs(key) {
			key = filepath.Join(baseDir, key)
		}
		args = append(args, "--key", key)
	} else {
		args = append(args, "--certificate-identity", config.Identity, "--certificate-oidc-issuer", config.Issuer)
	}
	args = append(args, ref.String())
	cmd := exec.CommandContext(ctx, resolved, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("bundle source %s: cosign verification failed for %s: %w (%s)",
			name, ref.String(), err, strings.TrimSpace(string(output)))
	}
	return nil
}
