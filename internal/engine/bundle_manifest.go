package engine

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// BundleManifest 定义 bundle 的元数据
type BundleManifest struct {
	APIVersion string            `yaml:"apiVersion"`
	Kind       string            `yaml:"kind"`
	Name       string            `yaml:"name"`
	Type       string            `yaml:"type"`  // compose | stack | script
	Class      string            `yaml:"class"` // product | composition | capability | infrastructure | tool
	Version    string            `yaml:"version"`
	Owner      string            `yaml:"owner"`
	Labels     map[string]string `yaml:"labels"`
	DeployPath string            `yaml:"deploy_path"` // 远程部署目录；空则使用 global.defaults.deploy_path/<bundle>
	// ConfigRoot 决定 defaults 的本地根目录：
	//   host   -> hosts/<host>/<path>（旧行为，默认）
	//   bundle -> hosts/<host>/<bundle>/<path>（推荐，多个 bundle 可共存）
	ConfigRoot string           `yaml:"config_root"`
	Features   BundleFeatures   `yaml:"features"`
	Defaults   []BundleDefault  `yaml:"defaults"`
	SyncRules  []BundleSyncRule `yaml:"sync_rules"`
	Templates  []string         `yaml:"templates"`
	Services   []string         `yaml:"services"`
}

// BundleSyncRule 定义 bundle 自带的同步规则。
// Local 相对于 bundle 的配置根目录；Remote 支持 ${deploy_path} / ${host} 占位。
type BundleSyncRule struct {
	Local  string `yaml:"local"`
	Remote string `yaml:"remote"`
}

// ConfigRootOrDefault 返回配置根目录语义（host | bundle）。
func (m *BundleManifest) ConfigRootOrDefault() string {
	if m.ConfigRoot == "" {
		return "host"
	}
	return m.ConfigRoot
}

// BundleFeatures 定义 bundle 的启用特性
type BundleFeatures struct {
	DockerLogRotation bool      `yaml:"docker_log_rotation"`
	GitClone          *GitClone `yaml:"git_clone"`
	DockerPrune       bool      `yaml:"docker_prune"`
	CreateNetwork     string    `yaml:"create_network"`
}

// GitClone 定义 git 克隆配置
type GitClone struct {
	Repo string `yaml:"repo"`
	Path string `yaml:"path"`
}

// BundleDefault 定义默认配置文件
type BundleDefault struct {
	Path    string `yaml:"path"`
	Content string `yaml:"content"`
}

// LoadManifest 从 bundles/<name>/manifest.yaml 加载
type ManifestLoader struct {
	baseDir string
}

// NewManifestLoader 创建加载器
func NewManifestLoader(baseDir string) *ManifestLoader {
	return &ManifestLoader{baseDir: baseDir}
}

// Load 加载指定 bundle 的 manifest
func (ml *ManifestLoader) Load(bundleName string) (*BundleManifest, error) {
	manifestPath := filepath.Join(ml.baseDir, "bundles", bundleName, "manifest.yaml")

	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read manifest for %s: %w", bundleName, err)
	}

	var manifest BundleManifest
	if err := yaml.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("failed to parse manifest for %s: %w", bundleName, err)
	}

	if manifest.Name == "" {
		manifest.Name = bundleName
	}
	if manifest.Type == "" {
		manifest.Type = "compose"
	}

	return &manifest, nil
}
