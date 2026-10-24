package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/singll/silkspool/internal/config"
)

// ImageRef 是可解析的容器镜像引用。
type ImageRef struct {
	Raw        string `json:"raw"`
	Registry   string `json:"registry"`
	Repository string `json:"repository"`
	Tag        string `json:"tag,omitempty"`
	Digest     string `json:"digest,omitempty"`
}

// RegistryClient 查询镜像仓库的 tag 列表；测试可注入 fake。
type RegistryClient interface {
	ListTags(ctx context.Context, repository string) ([]string, error)
}

// RegistryClientFactory 由 CLI 调用；测试可替换。
var RegistryClientFactory = func() RegistryClient {
	return NewHTTPRegistryClient()
}

// ImageUpdate 描述一个固定 digest 镜像的可更新状态。
type ImageUpdate struct {
	Image           string `json:"image"`
	Repository      string `json:"repository"`
	CurrentTag      string `json:"current_tag,omitempty"`
	CurrentDigest   string `json:"current_digest,omitempty"`
	LatestTag       string `json:"latest_tag,omitempty"`
	UpdateAvailable bool   `json:"update_available"`
	Source          string `json:"source,omitempty"`
}

// UpdateReport 是 check-updates 的输出。
type UpdateReport struct {
	Bundle    string        `json:"bundle"`
	Images    []ImageUpdate `json:"images"`
	Warnings  []string      `json:"warnings"`
	Suggested string        `json:"suggested,omitempty"`
}

// ParseImageRef 解析 repo[:tag][@digest]。
func ParseImageRef(raw string) (ImageRef, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ImageRef{}, false
	}
	ref := ImageRef{Raw: value}
	if idx := strings.LastIndex(value, "@"); idx >= 0 {
		ref.Digest = value[idx+1:]
		value = value[:idx]
	}
	lastSlash := strings.LastIndex(value, "/")
	lastColon := strings.LastIndex(value, ":")
	if lastColon > lastSlash {
		ref.Tag = value[lastColon+1:]
		value = value[:lastColon]
	}
	first := value
	if idx := strings.Index(value, "/"); idx >= 0 {
		first = value[:idx]
	}
	if strings.Contains(first, ".") || strings.Contains(first, ":") || first == "localhost" {
		ref.Registry = first
		ref.Repository = strings.TrimPrefix(value[len(first):], "/")
	} else {
		ref.Registry = "docker.io"
		ref.Repository = value
		if !strings.Contains(ref.Repository, "/") {
			ref.Repository = "library/" + ref.Repository
		}
	}
	if ref.Repository == "" {
		return ImageRef{}, false
	}
	return ref, true
}

// CheckUpdates 列出 bundle（含 components/dependencies 引用）中固定 digest 镜像的更新。
func CheckUpdates(ctx context.Context, baseDir string, cfg *config.Config, bundleName string, client RegistryClient) (*UpdateReport, error) {
	if client == nil {
		client = NewHTTPRegistryClient()
	}
	repo := NewBundleRepository(baseDir, cfg)
	loaded, err := repo.Load(ctx, bundleName, nil)
	if err != nil {
		return nil, err
	}

	report := &UpdateReport{Bundle: bundleName, Images: []ImageUpdate{}, Warnings: []string{}}
	seenImages := map[string]bool{}
	visited := map[string]bool{}
	collectManifestImages(ctx, repo, loaded, "bundle", report, seenImages, visited)

	for i := range report.Images {
		update := &report.Images[i]
		ref, ok := ParseImageRef(update.Image)
		if !ok {
			report.Warnings = append(report.Warnings, fmt.Sprintf("cannot parse image %q", update.Image))
			continue
		}
		update.Repository = displayRepository(ref)
		update.CurrentTag = ref.Tag
		update.CurrentDigest = ref.Digest
		if ref.Tag == "" {
			report.Warnings = append(report.Warnings, fmt.Sprintf("%s has no tag; cannot compare versions", update.Image))
			continue
		}
		tags, err := client.ListTags(ctx, registryRepository(ref))
		if err != nil {
			report.Warnings = append(report.Warnings, fmt.Sprintf("%s: list tags failed: %v", update.Repository, err))
			continue
		}
		latest, ok := latestComparableTag(ref.Tag, tags)
		if !ok {
			report.Warnings = append(report.Warnings, fmt.Sprintf("%s: no comparable tag found for %q", update.Repository, ref.Tag))
			continue
		}
		update.LatestTag = latest
		update.UpdateAvailable = compareVersionTags(latest, ref.Tag) > 0
	}
	sort.Slice(report.Images, func(i, j int) bool { return report.Images[i].Image < report.Images[j].Image })
	if len(report.Images) > 0 {
		report.Suggested = "pin the updated tag digest in the manifest (Renovate/Dependabot or manual), then run spool plan and apply"
	}
	return report, nil
}

func collectManifestImages(ctx context.Context, repo *BundleRepository, loaded *LoadedBundle, source string, report *UpdateReport, seenImages, visited map[string]bool) {
	if loaded == nil || loaded.Manifest == nil || visited[loaded.Root] {
		return
	}
	visited[loaded.Root] = true
	manifest := loaded.Manifest

	if artifact := manifest.Delivery.Artifact; artifact != nil && artifact.Image != "" {
		image := artifact.Image
		if artifact.Digest != "" && !strings.Contains(image, "@") {
			image += "@" + artifact.Digest
		}
		addUpdateImage(report, seenImages, image, source+".artifact")
	}
	if !manifest.IsComposition() && !manifest.IsScriptManifest() {
		if images, _, err := loadTemplatesInfo(loaded.Root, manifest.Templates); err == nil {
			for _, image := range images {
				addUpdateImage(report, seenImages, image, source+".templates")
			}
		}
	}
	for _, key := range sortedKeys(manifest.Components) {
		component := manifest.Components[key]
		if component.Image != "" {
			addUpdateImage(report, seenImages, component.Image, source+".components."+key)
		}
		if component.Bundle != "" {
			child, err := repo.Load(ctx, component.Bundle, component.Source)
			if err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("component %s: %v", key, err))
				continue
			}
			collectManifestImages(ctx, repo, child, source+".components."+key, report, seenImages, visited)
		}
	}
	for _, key := range sortedKeys(manifest.Dependencies) {
		dependency := manifest.Dependencies[key]
		if dependency.Bundle == "" {
			continue
		}
		child, err := repo.Load(ctx, dependency.Bundle, dependency.Source)
		if err != nil {
			report.Warnings = append(report.Warnings, fmt.Sprintf("dependency %s: %v", key, err))
			continue
		}
		collectManifestImages(ctx, repo, child, source+".dependencies."+key, report, seenImages, visited)
	}
}

func addUpdateImage(report *UpdateReport, seen map[string]bool, image, source string) {
	image = strings.TrimSpace(image)
	if image == "" || seen[image] {
		return
	}
	seen[image] = true
	ref, ok := ParseImageRef(image)
	if !ok {
		report.Warnings = append(report.Warnings, fmt.Sprintf("cannot parse image %q", image))
		return
	}
	if ref.Digest == "" {
		report.Warnings = append(report.Warnings, fmt.Sprintf("%s is not pinned to a digest", image))
		return
	}
	report.Images = append(report.Images, ImageUpdate{Image: image, Source: source})
}

func displayRepository(ref ImageRef) string {
	if ref.Registry == "docker.io" {
		return strings.TrimPrefix(ref.Repository, "library/")
	}
	return ref.Registry + "/" + ref.Repository
}

func registryRepository(ref ImageRef) string {
	if ref.Registry == "" || ref.Registry == "docker.io" {
		return ref.Repository
	}
	return ref.Registry + "/" + ref.Repository
}

func latestComparableTag(current string, tags []string) (string, bool) {
	latest := ""
	for _, tag := range tags {
		if !comparableVersion(current, tag) {
			continue
		}
		if latest == "" || compareVersionTags(tag, latest) > 0 {
			latest = tag
		}
	}
	return latest, latest != ""
}

func comparableVersion(a, b string) bool {
	return len(versionNumbers(a)) > 0 && len(versionNumbers(b)) > 0
}

var versionNumberPattern = regexp.MustCompile(`\d+`)

func versionNumbers(tag string) []int {
	parts := versionNumberPattern.FindAllString(tag, -1)
	numbers := make([]int, 0, len(parts))
	for _, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil {
			return nil
		}
		numbers = append(numbers, value)
	}
	return numbers
}

func compareVersionTags(a, b string) int {
	left := versionNumbers(a)
	right := versionNumbers(b)
	max := len(left)
	if len(right) > max {
		max = len(right)
	}
	for i := 0; i < max; i++ {
		l, r := 0, 0
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		if l > r {
			return 1
		}
		if l < r {
			return -1
		}
	}
	return 0
}

// HTTPRegistryClient 使用 Registry v2 API 匿名读取 tag 列表。
type HTTPRegistryClient struct {
	Client *http.Client
}

// NewHTTPRegistryClient 创建默认仓库客户端。
func NewHTTPRegistryClient() *HTTPRegistryClient {
	return &HTTPRegistryClient{Client: &http.Client{Timeout: 15 * time.Second}}
}

// ListTags 查询指定 repository 的 tag 列表。
func (c *HTTPRegistryClient) ListTags(ctx context.Context, repository string) ([]string, error) {
	registry := "docker.io"
	if idx := strings.Index(repository, "/"); idx > 0 && (strings.Contains(repository[:idx], ".") || strings.Contains(repository[:idx], ":")) {
		registry = repository[:idx]
		repository = strings.TrimPrefix(repository[idx:], "/")
	}
	base := "https://registry-1.docker.io"
	if registry != "docker.io" {
		base = "https://" + registry
	}
	endpoint := fmt.Sprintf("%s/v2/%s/tags/list", base, repository)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		challenge := resp.Header.Get("WWW-Authenticate")
		_ = resp.Body.Close()
		token, err := c.fetchToken(ctx, challenge)
		if err != nil {
			return nil, err
		}
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err = c.client().Do(req)
		if err != nil {
			return nil, err
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("registry returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var doc struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, err
	}
	sort.Strings(doc.Tags)
	return doc.Tags, nil
}

func (c *HTTPRegistryClient) client() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: 15 * time.Second}
}

var bearerChallengePattern = regexp.MustCompile(`([a-zA-Z]+)="([^"]*)"`)

func (c *HTTPRegistryClient) fetchToken(ctx context.Context, challenge string) (string, error) {
	if !strings.HasPrefix(strings.ToLower(challenge), "bearer") {
		return "", fmt.Errorf("unsupported registry auth challenge %q", challenge)
	}
	params := map[string]string{}
	for _, match := range bearerChallengePattern.FindAllStringSubmatch(challenge, -1) {
		params[strings.ToLower(match[1])] = match[2]
	}
	realm := params["realm"]
	if realm == "" {
		return "", fmt.Errorf("registry auth challenge missing realm")
	}
	query := url.Values{}
	if service := params["service"]; service != "" {
		query.Set("service", service)
	}
	if scope := params["scope"]; scope != "" {
		query.Set("scope", scope)
	}
	tokenURL := realm
	if encoded := query.Encode(); encoded != "" {
		tokenURL += "?" + encoded
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry token endpoint returned %s", resp.Status)
	}
	var doc struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return "", err
	}
	if doc.Token != "" {
		return doc.Token, nil
	}
	if doc.AccessToken != "" {
		return doc.AccessToken, nil
	}
	return "", fmt.Errorf("registry token endpoint returned no token")
}
