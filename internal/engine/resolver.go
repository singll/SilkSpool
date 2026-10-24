package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/singll/silkspool/internal/config"
)

const (
	// LockVersion 是 lock 快照格式版本。
	LockVersion = 1

	bundleClassProduct        = "product"
	bundleClassComposition    = "composition"
	bundleClassCapability     = "capability"
	bundleClassInfrastructure = "infrastructure"
	bundleClassTool           = "tool"
)

var exactVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+@:/-]*$`)
var commitPattern = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)
var expressionPattern = regexp.MustCompile(`\$\{([^}]*)\}`)

// LockSnapshot 是可复现的 resolved 快照（本地缓存，不是依赖锁）。
type LockSnapshot struct {
	Version    int              `yaml:"version"`
	Host       string           `yaml:"host"`
	Bundle     string           `yaml:"bundle"`
	InputsHash string           `yaml:"inputs_hash"`
	LockHash   string           `yaml:"lock_hash,omitempty"`
	Resolved   ResolvedSnapshot `yaml:"resolved"`
	Rendered   RenderedSnapshot `yaml:"rendered"`
	CreatedAt  string           `yaml:"created_at,omitempty"`
}

// ResolvedSnapshot 记录本次拓扑下的 components/dependencies 解析结果。
type ResolvedSnapshot struct {
	Components   map[string]ResolvedComponent  `yaml:"components"`
	Dependencies map[string]ResolvedDependency `yaml:"dependencies"`
}

// ResolvedComponent 是本次部署负责的组件。
type ResolvedComponent struct {
	Host      string                    `yaml:"host"`
	Source    *BundleSource             `yaml:"source,omitempty"`
	Version   string                    `yaml:"version,omitempty"`
	Image     string                    `yaml:"image,omitempty"`
	Images    map[string]string         `yaml:"images,omitempty"`
	Outputs   map[string]ResolvedOutput `yaml:"outputs,omitempty"`
	Health    *BundleHealth             `yaml:"health,omitempty"`
	Optional  bool                      `yaml:"optional,omitempty"`
	After     []string                  `yaml:"after,omitempty"`
	ExecIn    string                    `yaml:"exec_in,omitempty"`
	Templates []string                  `yaml:"templates,omitempty"`
	Services  []string                  `yaml:"services,omitempty"`
	Env       map[string]string         `yaml:"wiring,omitempty"`
}

// ResolvedDependency 是只读 outputs 的外部依赖。
type ResolvedDependency struct {
	Host    string                    `yaml:"host"`
	Source  *BundleSource             `yaml:"source,omitempty"`
	Version string                    `yaml:"version,omitempty"`
	Outputs map[string]ResolvedOutput `yaml:"outputs,omitempty"`
}

// ResolvedOutput 是拓扑解析后的 output。
type ResolvedOutput struct {
	Kind      string `yaml:"kind,omitempty"`
	Host      string `yaml:"host,omitempty"`
	Port      int    `yaml:"port,omitempty"`
	Protocol  string `yaml:"protocol,omitempty"`
	Value     string `yaml:"value,omitempty"`
	Service   string `yaml:"service,omitempty"`
	Sensitive bool   `yaml:"sensitive,omitempty"`
}

// RenderedSnapshot 保存 plan 阶段渲染的占位内容，供 --locked 复现。
type RenderedSnapshot struct {
	Compose        string            `yaml:"compose,omitempty"`
	Override       string            `yaml:"override,omitempty"`
	Env            map[string]string `yaml:"env,omitempty"`
	ComposeSHA256  string            `yaml:"compose_sha256"`
	OverrideSHA256 string            `yaml:"override_sha256,omitempty"`
}

// ServiceSpec 描述一个待部署服务。
type ServiceSpec struct {
	Name      string `yaml:"name"`
	Image     string `yaml:"image,omitempty"`
	Component string `yaml:"component,omitempty"`
}

// ComponentLifecycle 保存组件的生命周期契约与执行上下文。
type ComponentLifecycle struct {
	Key     string
	Root    string
	Backup  BundleBackup
	Restore BundleRestore
	Upgrade BundleUpgrade
	Hooks   BundleHooks
	Env     map[string]string
}

// ResolvedPlan 是 resolver 的完整输出。
type ResolvedPlan struct {
	Lock         *LockSnapshot
	Manifest     *BundleManifest
	BundleRoot   string
	DeployPath   string
	Components   []string
	Services     []ServiceSpec
	Compose      []byte
	Override     []byte
	Env          map[string]string
	Uploads      map[string][]byte
	Warnings     []string
	LockPath     string
	Lifecycles   map[string]ComponentLifecycle
	AliasWarning string
}

// ResolveOptions 控制输入、secret 与是否写 lock。
type ResolveOptions struct {
	Inputs    map[string]string
	Secrets   map[string]string
	WriteLock bool
}

// LoadedBundle 表示从本地/缓存/来源加载的 bundle。
type LoadedBundle struct {
	Name     string
	Root     string
	Manifest *BundleManifest
	Source   BundleSource
	AliasOf  string
}

// BundleRepository 负责本地 bundle 与 bundle_sources 解析（dir | git）。
type BundleRepository struct {
	baseDir string
	cfg     *config.Config
}

// NewBundleRepository 创建 bundle 来源解析器。
func NewBundleRepository(baseDir string, cfg *config.Config) *BundleRepository {
	return &BundleRepository{baseDir: baseDir, cfg: cfg}
}

// Load 依次尝试显式 source、本地 bundles/<name>、bundle_sources。
// manifest.alias_of 会透明解析到目标 bundle，并保留弃用标记。
func (r *BundleRepository) Load(ctx context.Context, name string, src *BundleSource) (*LoadedBundle, error) {
	return r.load(ctx, name, src, 0)
}

func (r *BundleRepository) load(ctx context.Context, name string, src *BundleSource, depth int) (*LoadedBundle, error) {
	if depth > 8 {
		return nil, fmt.Errorf("bundle alias chain too deep at %s", name)
	}
	loaded, err := r.loadOne(ctx, name, src)
	if err != nil {
		return nil, err
	}
	if loaded.Manifest.AliasOf == "" {
		return loaded, nil
	}
	target, err := r.load(ctx, loaded.Manifest.AliasOf, nil, depth+1)
	if err != nil {
		return nil, fmt.Errorf("bundle %s alias %s: %w", name, loaded.Manifest.AliasOf, err)
	}
	clone := *target.Manifest
	clone.DeprecatedAlias = name
	return &LoadedBundle{
		Name:     name,
		Root:     target.Root,
		Manifest: &clone,
		Source:   target.Source,
		AliasOf:  name,
	}, nil
}

func (r *BundleRepository) loadOne(ctx context.Context, name string, src *BundleSource) (*LoadedBundle, error) {
	if src != nil {
		return r.loadFromSource(ctx, name, src)
	}

	localRoot := ManifestBundleRoot(r.baseDir, name)
	if _, err := FindManifestFile(localRoot); err == nil {
		manifest, err := LoadManifestFromDir(localRoot, name)
		if err != nil {
			return nil, err
		}
		return &LoadedBundle{Name: name, Root: localRoot, Manifest: manifest, Source: BundleSource{Type: "dir", Path: localRoot}}, nil
	}

	if r.cfg != nil {
		for _, candidate := range r.cfg.BundleSources {
			if candidate.Name != name {
				continue
			}
			source := &BundleSource{
				Type:        candidate.Type,
				Repo:        candidate.Repo,
				Path:        candidate.Path,
				Commit:      candidate.Commit,
				Ref:         candidate.Ref,
				Digest:      candidate.Digest,
				Insecure:    candidate.Insecure,
				Username:    candidate.Username,
				PasswordEnv: candidate.PasswordEnv,
			}
			if candidate.Cosign != nil {
				source.Cosign = &BundleCosign{
					Key:      candidate.Cosign.Key,
					Identity: candidate.Cosign.Identity,
					Issuer:   candidate.Cosign.Issuer,
				}
			}
			return r.loadFromSource(ctx, name, source)
		}
		for _, candidate := range r.cfg.BundleSources {
			if strings.EqualFold(candidate.Type, "dir") {
				root := candidate.Path
				if !filepath.IsAbs(root) {
					root = filepath.Join(r.baseDir, root)
				}
				root = filepath.Join(root, name)
				if _, err := FindManifestFile(root); err == nil {
					manifest, err := LoadManifestFromDir(root, name)
					if err != nil {
						return nil, err
					}
					return &LoadedBundle{Name: name, Root: root, Manifest: manifest, Source: BundleSource{Type: "dir", Path: root}}, nil
				}
			}
		}
	}

	return nil, fmt.Errorf("bundle %s not found locally or in bundle_sources", name)
}

func (r *BundleRepository) loadFromSource(ctx context.Context, name string, src *BundleSource) (*LoadedBundle, error) {
	switch strings.ToLower(strings.TrimSpace(src.Type)) {
	case "dir":
		root := src.Path
		if root == "" {
			root = filepath.Join("bundles", name)
		}
		if !filepath.IsAbs(root) {
			root = filepath.Join(r.baseDir, root)
		}
		if _, err := FindManifestFile(root); err != nil {
			// 允许 dir 指向包含多个 bundle 的父目录。
			candidate := filepath.Join(root, name)
			if _, err2 := FindManifestFile(candidate); err2 == nil {
				root = candidate
			} else {
				return nil, fmt.Errorf("bundle source %s: manifest not found under %s: %w", name, root, err)
			}
		}
		manifest, err := LoadManifestFromDir(root, name)
		if err != nil {
			return nil, err
		}
		return &LoadedBundle{Name: name, Root: root, Manifest: manifest, Source: *src}, nil

	case "git":
		if !commitPattern.MatchString(src.Commit) {
			return nil, fmt.Errorf("bundle source %s: git commit must be a pinned 7-40 hex sha (got %q)", name, src.Commit)
		}
		if strings.TrimSpace(src.Repo) == "" {
			return nil, fmt.Errorf("bundle source %s: git repo is required", name)
		}
		cacheRoot := filepath.Join(r.baseDir, ".spool", "cache", "bundles", name, src.Commit)
		if _, err := FindManifestFile(cacheRoot); err != nil {
			if err := os.MkdirAll(filepath.Dir(cacheRoot), 0755); err != nil {
				return nil, err
			}
			if _, err := os.Stat(cacheRoot); err == nil {
				_ = os.RemoveAll(cacheRoot)
			}
			clone := exec.CommandContext(ctx, "git", "clone", "--quiet", src.Repo, cacheRoot)
			if out, err := clone.CombinedOutput(); err != nil {
				return nil, fmt.Errorf("bundle source %s: git clone failed: %w (%s)", name, err, strings.TrimSpace(string(out)))
			}
			checkout := exec.CommandContext(ctx, "git", "-C", cacheRoot, "checkout", "--quiet", src.Commit)
			if out, err := checkout.CombinedOutput(); err != nil {
				fetch := exec.CommandContext(ctx, "git", "-C", cacheRoot, "fetch", "--quiet", "--depth=1", "origin", src.Commit)
				if fetchOut, fetchErr := fetch.CombinedOutput(); fetchErr != nil {
					return nil, fmt.Errorf("bundle source %s: git checkout %s failed: %w (%s); fetch: %v (%s)",
						name, src.Commit, err, strings.TrimSpace(string(out)), fetchErr, strings.TrimSpace(string(fetchOut)))
				}
				retry := exec.CommandContext(ctx, "git", "-C", cacheRoot, "checkout", "--quiet", src.Commit)
				if retryOut, retryErr := retry.CombinedOutput(); retryErr != nil {
					return nil, fmt.Errorf("bundle source %s: git checkout %s failed: %w (%s)", name, src.Commit, retryErr, strings.TrimSpace(string(retryOut)))
				}
			}
		}
		root := cacheRoot
		if strings.TrimSpace(src.Path) != "" {
			root = filepath.Join(cacheRoot, filepath.FromSlash(src.Path))
		}
		if _, err := FindManifestFile(root); err != nil {
			// 允许 source.path 指向包含 bundle 的目录。
			candidate := filepath.Join(root, name)
			if _, err2 := FindManifestFile(candidate); err2 == nil {
				root = candidate
			} else {
				return nil, fmt.Errorf("bundle source %s: manifest not found in git cache %s", name, root)
			}
		}
		manifest, err := LoadManifestFromDir(root, name)
		if err != nil {
			return nil, err
		}
		return &LoadedBundle{Name: name, Root: root, Manifest: manifest, Source: *src}, nil

	case "oci":
		return r.loadFromOCI(ctx, name, src)

	default:
		return nil, fmt.Errorf("bundle source %s: unsupported type %q (want dir|git|oci)", name, src.Type)
	}
}

// ResolveDeployPath 解析远端部署目录。
func ResolveDeployPath(baseDir string, cfg *config.Config, bundle string, manifest *BundleManifest) string {
	if manifest != nil && manifest.DeployPath != "" {
		return manifest.DeployPath
	}
	base := "/opt/silkspool"
	if cfg != nil {
		base = config.DefaultString(cfg.Global.Defaults.DeployPath, base)
	}
	return filepath.Join(base, bundle)
}

// ValidateBundleClass 校验 class 枚举。
func ValidateBundleClass(class string) error {
	if class == "" {
		return nil
	}
	switch class {
	case bundleClassProduct, bundleClassComposition, bundleClassCapability, bundleClassInfrastructure, bundleClassTool:
		return nil
	default:
		return fmt.Errorf("invalid bundle class %q (want product|composition|capability|infrastructure|tool)", class)
	}
}

// ValidateManifestSchema 做轻量 schema 校验（apiVersion/kind/driver）。
func ValidateManifestSchema(manifest *BundleManifest) error {
	if manifest.APIVersion != "" && manifest.APIVersion != "spool/v1alpha1" {
		return fmt.Errorf("unsupported apiVersion %q (want spool/v1alpha1)", manifest.APIVersion)
	}
	if manifest.Kind != "" && manifest.Kind != "Bundle" {
		return fmt.Errorf("unsupported kind %q (want Bundle)", manifest.Kind)
	}
	switch manifest.Type {
	case "compose", "stack", "script":
		return nil
	default:
		return fmt.Errorf("unsupported delivery driver %q (want compose|stack|script)", manifest.Type)
	}
}

// ValidatePinnedVersion 拒绝 latest/范围；允许精确 tag 与 digest。
func ValidatePinnedVersion(kind, name, version string) error {
	v := strings.TrimSpace(version)
	if v == "" {
		return nil
	}
	lower := strings.ToLower(v)
	if lower == "latest" || lower == "stable" || lower == "main" || lower == "master" {
		return fmt.Errorf("%s %s: version must be an exact tag or digest, got %q", kind, name, version)
	}
	if strings.ContainsAny(v, "^~<>* ") || strings.Contains(v, "||") {
		return fmt.Errorf("%s %s: version ranges are not supported, got %q", kind, name, version)
	}
	if !exactVersionPattern.MatchString(v) {
		return fmt.Errorf("%s %s: invalid pinned version %q", kind, name, version)
	}
	return nil
}

// ValidatePinnedImage 拒绝 latest，允许精确 tag 或 tag@digest。
func ValidatePinnedImage(name, image string) error {
	if strings.TrimSpace(image) == "" {
		return nil
	}
	if strings.HasSuffix(image, ":latest") || strings.HasSuffix(image, "/latest") {
		return fmt.Errorf("component %s: image must be pinned, got %q", name, image)
	}
	return nil
}

// ResolveBundle 解析 bundle 的 components/dependencies/wiring、DAG 与 lock。
func ResolveBundle(ctx context.Context, baseDir string, cfg *config.Config, bundleName, host string, opts ResolveOptions) (*ResolvedPlan, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return nil, fmt.Errorf("host %s not found", host)
	}

	repo := NewBundleRepository(baseDir, cfg)
	loaded, err := repo.Load(ctx, bundleName, nil)
	if err != nil {
		return nil, err
	}
	manifest := loaded.Manifest
	if err := ValidateManifestSchema(manifest); err != nil {
		return nil, err
	}
	if err := ValidateBundleClass(manifest.Class); err != nil {
		return nil, err
	}
	if err := ValidatePinnedVersion("bundle", bundleName, manifest.Version); err != nil {
		return nil, err
	}
	if err := validateUpgradeStrategy(bundleName, manifest.Lifecycle.Upgrade); err != nil {
		return nil, err
	}
	aliasWarning := ""
	if manifest.DeprecatedAlias != "" {
		aliasWarning = fmt.Sprintf("bundle %s is a deprecated alias for %s; update commands to use %s",
			manifest.DeprecatedAlias, manifest.Name, manifest.Name)
	}

	inputs := mergeStringMaps(manifest.Inputs, hostCfg.Inputs, opts.Inputs)
	secrets := opts.Secrets

	components := map[string]*componentData{}
	if manifest.IsComposition() {
		keys := sortedKeys(manifest.Components)
		for _, key := range keys {
			spec := manifest.Components[key]
			data, err := resolveComponent(ctx, repo, cfg, host, hostCfg, key, spec)
			if err != nil {
				return nil, err
			}
			components[key] = data
		}
		seenServices := map[string]string{}
		for _, key := range keys {
			for _, svc := range components[key].services {
				if prev, ok := seenServices[svc]; ok {
					return nil, fmt.Errorf("duplicate service %q in components %s and %s", svc, prev, key)
				}
				seenServices[svc] = key
			}
		}
	} else {
		if manifest.IsScriptManifest() == false && len(manifest.Templates) == 0 {
			return nil, fmt.Errorf("bundle %s has no templates", bundleName)
		}
		data := &componentData{
			key:       bundleName,
			host:      host,
			root:      loaded.Root,
			source:    loaded.Source,
			version:   manifest.Version,
			outputs:   manifest.Outputs,
			health:    manifest.Lifecycle.Health,
			templates: append([]string(nil), manifest.Templates...),
			services:  append([]string(nil), manifest.Services...),
			images:    map[string]string{},
			manifest:  manifest,
		}
		if !manifest.IsScriptManifest() {
			images, services, err := loadTemplatesInfo(loaded.Root, manifest.Templates)
			if err != nil {
				return nil, err
			}
			if len(services) > 0 {
				data.services = services
			}
			data.images = images
		}
		if artifact := manifest.Delivery.Artifact; artifact != nil && artifact.Image != "" {
			image := artifact.Image
			if artifact.Digest != "" && !strings.Contains(image, "@") {
				image = image + "@" + artifact.Digest
			}
			data.image = image
			for _, svc := range data.services {
				data.images[svc] = image
			}
		}
		components[bundleName] = data
	}

	dependencies := map[string]*dependencyData{}
	depKeys := sortedKeys(manifest.Dependencies)
	for _, key := range depKeys {
		spec := manifest.Dependencies[key]
		data, err := resolveDependency(ctx, repo, cfg, host, key, spec)
		if err != nil {
			return nil, err
		}
		dependencies[key] = data
	}

	baseCtx := &resolveContext{
		hostName:     host,
		hostCfg:      hostCfg,
		inputs:       inputs,
		secrets:      secrets,
		components:   map[string]map[string]ResolvedOutput{},
		dependencies: map[string]map[string]ResolvedOutput{},
	}

	// 当前 bundle 自身 outputs。
	currentOutputs, err := resolveOutputDecls(manifest.Outputs, host, hostCfg, host, hostCfg, true, baseCtx)
	if err != nil {
		return nil, fmt.Errorf("bundle %s outputs: %w", bundleName, err)
	}
	baseCtx.current = currentOutputs

	// components outputs：同 host、同 project -> 服务名。
	for _, key := range sortedKeys(components) {
		comp := components[key]
		out, err := resolveOutputDecls(comp.outputs, host, hostCfg, host, hostCfg, true, baseCtx)
		if err != nil {
			return nil, fmt.Errorf("component %s outputs: %w", key, err)
		}
		baseCtx.components[key] = out
	}

	// dependencies outputs：按 provider host 与目标 host 的拓扑解析。
	for _, key := range depKeys {
		dep := dependencies[key]
		providerCfg := cfg.GetHost(dep.host)
		out, err := resolveOutputDecls(dep.outputs, dep.host, providerCfg, host, hostCfg, dep.sharedNetwork && dep.host == host, baseCtx)
		if err != nil {
			return nil, fmt.Errorf("dependency %s outputs: %w", key, err)
		}
		baseCtx.dependencies[key] = out
	}

	// health 表达式在 plan 阶段完成插值。
	manifest.Lifecycle.Health, err = interpolateHealth(manifest.Lifecycle.Health, baseCtx)
	if err != nil {
		return nil, fmt.Errorf("bundle %s health: %w", bundleName, err)
	}
	for _, key := range sortedKeys(components) {
		compCtx := *baseCtx
		compCtx.current = baseCtx.components[key]
		components[key].health, err = interpolateHealth(components[key].health, &compCtx)
		if err != nil {
			return nil, fmt.Errorf("component %s health: %w", key, err)
		}
	}

	// wiring。
	for _, key := range sortedKeys(components) {
		comp := components[key]
		env, err := resolveWiring(key, manifest, comp, components, baseCtx)
		if err != nil {
			return nil, err
		}
		comp.env = env
	}

	// per-component after DAG。
	order, err := topoSortComponents(components)
	if err != nil {
		return nil, err
	}

	plan := &ResolvedPlan{
		Manifest:     manifest,
		BundleRoot:   loaded.Root,
		DeployPath:   ResolveDeployPath(baseDir, cfg, bundleName, manifest),
		Components:   order,
		Uploads:      map[string][]byte{},
		Env:          map[string]string{},
		Lifecycles:   map[string]ComponentLifecycle{},
		AliasWarning: aliasWarning,
	}
	if manifest.IsComposition() {
		for _, key := range order {
			comp := components[key]
			plan.Lifecycles[key] = ComponentLifecycle{
				Key:     key,
				Root:    comp.root,
				Backup:  comp.backup,
				Restore: comp.restore,
				Upgrade: comp.upgrade,
				Hooks:   comp.hooks,
				Env:     cloneStringMap(comp.env),
			}
		}
	}
	if err := validateEffectiveLifecycle(plan); err != nil {
		return nil, err
	}
	if err := renderResolvedPlan(plan, host, manifest, components, baseCtx, dependencies); err != nil {
		return nil, err
	}
	if aliasWarning != "" {
		plan.Warnings = append(plan.Warnings, aliasWarning)
	}

	lock := buildLockSnapshot(host, bundleName, inputs, components, baseCtx.components, dependencies, baseCtx.dependencies, plan)
	plan.Lock = lock

	if opts.WriteLock {
		path, err := WriteLock(baseDir, lock)
		if err != nil {
			return nil, err
		}
		plan.LockPath = path
	} else {
		plan.LockPath = LockPath(baseDir, host, bundleName)
	}

	return plan, nil
}

type componentData struct {
	key           string
	host          string
	root          string
	source        BundleSource
	version       string
	image         string
	images        map[string]string
	outputs       map[string]BundleOutput
	health        *BundleHealth
	optional      bool
	after         []string
	execIn        string
	templates     []string
	services      []string
	generated     bool
	env           map[string]string
	manifest      *BundleManifest
	sharedNetwork bool
	backup        BundleBackup
	restore       BundleRestore
	upgrade       BundleUpgrade
	hooks         BundleHooks
}

type dependencyData struct {
	host          string
	address       string
	root          string
	source        BundleSource
	version       string
	outputs       map[string]BundleOutput
	sharedNetwork bool
}

func resolveComponent(ctx context.Context, repo *BundleRepository, cfg *config.Config, host string, hostCfg *config.HostConfig, key string, spec BundleComponent) (*componentData, error) {
	data := &componentData{
		key:           key,
		host:          host,
		source:        BundleSource{},
		version:       spec.Version,
		image:         spec.Image,
		images:        map[string]string{},
		outputs:       spec.Outputs,
		health:        spec.Health,
		optional:      spec.Optional,
		after:         append([]string(nil), spec.After...),
		execIn:        spec.ExecIn,
		sharedNetwork: spec.SharedNetwork,
		services:      []string{},
		backup:        spec.Backup,
		restore:       spec.Restore,
		upgrade:       spec.Upgrade,
		hooks:         spec.Hooks,
	}
	if err := ValidatePinnedVersion("component", key, spec.Version); err != nil {
		return nil, err
	}
	if err := ValidatePinnedImage(key, spec.Image); err != nil {
		return nil, err
	}

	if strings.TrimSpace(spec.Bundle) != "" {
		loaded, err := repo.Load(ctx, spec.Bundle, spec.Source)
		if err != nil {
			return nil, fmt.Errorf("component %s: %w", key, err)
		}
		if loaded.Manifest.Type != "compose" {
			return nil, fmt.Errorf("component %s: driver %q is unsupported in a composition (want compose)", key, loaded.Manifest.Type)
		}
		data.root = loaded.Root
		data.source = loaded.Source
		data.manifest = loaded.Manifest
		if data.version == "" {
			data.version = loaded.Manifest.Version
			if err := ValidatePinnedVersion("component", key, data.version); err != nil {
				return nil, err
			}
		}
		if len(data.outputs) == 0 {
			data.outputs = loaded.Manifest.Outputs
		}
		if data.health == nil {
			data.health = loaded.Manifest.Lifecycle.Health
		}
		if data.backup.Hook == "" && len(data.backup.Assets) == 0 {
			data.backup = loaded.Manifest.Backup
		}
		if data.restore.Hook == "" {
			data.restore = loaded.Manifest.Lifecycle.Restore
		}
		if data.upgrade == (BundleUpgrade{}) {
			data.upgrade = loaded.Manifest.Lifecycle.Upgrade
		}
		if data.hooks == (BundleHooks{}) {
			data.hooks = loaded.Manifest.Lifecycle.Hooks
		}
		data.templates = append([]string(nil), loaded.Manifest.Templates...)
		if len(data.services) == 0 {
			data.services = append([]string(nil), loaded.Manifest.Services...)
		}
		if spec.Image == "" && loaded.Manifest.Delivery.Artifact != nil {
			data.image = loaded.Manifest.Delivery.Artifact.Image
			if loaded.Manifest.Delivery.Artifact.Digest != "" && !strings.Contains(data.image, "@") {
				data.image = data.image + "@" + loaded.Manifest.Delivery.Artifact.Digest
			}
		}
	}

	if len(data.templates) > 0 {
		if data.root == "" {
			return nil, fmt.Errorf("component %s: templates declared without bundle/source root", key)
		}
		images, services, err := loadTemplatesInfo(data.root, data.templates)
		if err != nil {
			return nil, fmt.Errorf("component %s: %w", key, err)
		}
		if len(services) > 0 {
			data.services = services
		}
		data.images = images
	}
	if len(data.services) == 0 {
		if data.image == "" {
			return nil, fmt.Errorf("component %s: no bundle, image, or services resolved", key)
		}
		data.services = []string{key}
		data.generated = true
	}
	for _, svc := range data.services {
		if data.image != "" {
			data.images[svc] = data.image
		}
	}
	if data.image == "" && len(data.services) > 0 {
		data.image = data.images[data.services[0]]
	}
	return data, nil
}

func resolveDependency(ctx context.Context, repo *BundleRepository, cfg *config.Config, consumerHost, key string, spec BundleDependency) (*dependencyData, error) {
	if strings.TrimSpace(spec.Bundle) == "" {
		return nil, fmt.Errorf("dependency %s: bundle is required", key)
	}
	if err := ValidatePinnedVersion("dependency", key, spec.Version); err != nil {
		return nil, err
	}
	loaded, err := repo.Load(ctx, spec.Bundle, spec.Source)
	if err != nil {
		return nil, fmt.Errorf("dependency %s: %w", key, err)
	}
	version := spec.Version
	if version == "" {
		version = loaded.Manifest.Version
		if err := ValidatePinnedVersion("dependency", key, version); err != nil {
			return nil, err
		}
	}
	providerHost := strings.TrimSpace(spec.Host)
	if providerHost == "" {
		providerHost = consumerHost
	}
	outputs := loaded.Manifest.Outputs
	if len(spec.Outputs) > 0 {
		filtered := map[string]BundleOutput{}
		for _, name := range spec.Outputs {
			out, ok := outputs[name]
			if !ok {
				return nil, fmt.Errorf("dependency %s: provider %s does not declare output %q", key, spec.Bundle, name)
			}
			filtered[name] = out
		}
		outputs = filtered
	}
	address := ""
	if providerCfg := cfg.GetHost(providerHost); providerCfg != nil {
		address = hostAddress(providerCfg)
	} else {
		address = hostAddressFromString(providerHost)
	}
	return &dependencyData{
		host:          providerHost,
		address:       address,
		root:          loaded.Root,
		source:        loaded.Source,
		version:       version,
		outputs:       outputs,
		sharedNetwork: spec.SharedNetwork,
	}, nil
}

func loadTemplatesInfo(root string, templates []string) (map[string]string, []string, error) {
	images := map[string]string{}
	serviceSet := map[string]bool{}
	for _, tmpl := range templates {
		data, err := os.ReadFile(templateFilePath(root, tmpl))
		if err != nil {
			return nil, nil, fmt.Errorf("read template %s failed: %w", tmpl, err)
		}
		parsed, err := parseComposeServices(data)
		if err != nil {
			return nil, nil, fmt.Errorf("parse template %s failed: %w", tmpl, err)
		}
		for name, image := range parsed {
			serviceSet[name] = true
			if image != "" {
				images[name] = image
			}
		}
	}
	services := make([]string, 0, len(serviceSet))
	for name := range serviceSet {
		services = append(services, name)
	}
	sort.Strings(services)
	return images, services, nil
}

func parseComposeServices(data []byte) (map[string]string, error) {
	var doc struct {
		Services map[string]struct {
			Image string `yaml:"image"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	result := make(map[string]string, len(doc.Services))
	for name, svc := range doc.Services {
		result[name] = svc.Image
	}
	return result, nil
}

type resolveContext struct {
	hostName     string
	hostCfg      *config.HostConfig
	inputs       map[string]string
	secrets      map[string]string
	current      map[string]ResolvedOutput
	components   map[string]map[string]ResolvedOutput
	dependencies map[string]map[string]ResolvedOutput
}

func (c *resolveContext) forHost(name string, cfg *config.HostConfig) *resolveContext {
	clone := *c
	clone.hostName = name
	clone.hostCfg = cfg
	return &clone
}

// Interpolate 只做字符串插值；sensitive 表示值包含 secret 引用。
func (c *resolveContext) Interpolate(input string) (string, bool, error) {
	if !strings.Contains(input, "${") {
		return input, false, nil
	}
	var out strings.Builder
	sensitive := false
	last := 0
	for _, loc := range expressionPattern.FindAllStringSubmatchIndex(input, -1) {
		out.WriteString(input[last:loc[0]])
		expr := strings.TrimSpace(input[loc[2]:loc[3]])
		value, isSensitive, err := c.interpolateExpr(expr)
		if err != nil {
			return "", false, err
		}
		sensitive = sensitive || isSensitive
		out.WriteString(value)
		last = loc[1]
	}
	out.WriteString(input[last:])
	return out.String(), sensitive, nil
}

func (c *resolveContext) interpolateExpr(expr string) (string, bool, error) {
	switch {
	case strings.HasPrefix(expr, "input."):
		key := strings.TrimPrefix(expr, "input.")
		value, ok := c.inputs[key]
		if !ok {
			return "", false, fmt.Errorf("unresolved input reference ${%s}", expr)
		}
		return value, false, nil

	case strings.HasPrefix(expr, "host."):
		key := strings.TrimPrefix(expr, "host.")
		switch key {
		case "name":
			return c.hostName, false, nil
		case "address":
			if c.hostCfg == nil {
				return "", false, nil
			}
			return hostAddress(c.hostCfg), false, nil
		case "magicdns":
			if c.hostCfg == nil {
				return "", false, nil
			}
			return c.hostCfg.MagicDNS, false, nil
		case "ssh":
			if c.hostCfg == nil {
				return "", false, fmt.Errorf("unresolved host reference ${%s}", expr)
			}
			return c.hostCfg.Address, false, nil
		default:
			return "", false, fmt.Errorf("unknown host field ${%s}", expr)
		}

	case strings.HasPrefix(expr, "outputs."):
		ref := strings.TrimPrefix(expr, "outputs.")
		return lookupResolvedOutput(c.current, "outputs."+ref, c.secrets)

	case strings.HasPrefix(expr, "components."):
		rest := strings.TrimPrefix(expr, "components.")
		parts := strings.SplitN(rest, ".outputs.", 2)
		if len(parts) != 2 {
			return "", false, fmt.Errorf("invalid component reference ${%s}", expr)
		}
		outputs, ok := c.components[parts[0]]
		if !ok {
			return "", false, fmt.Errorf("unknown component reference ${%s}", expr)
		}
		return lookupResolvedOutput(outputs, expr, c.secrets)

	case strings.HasPrefix(expr, "dependencies."):
		rest := strings.TrimPrefix(expr, "dependencies.")
		parts := strings.SplitN(rest, ".outputs.", 2)
		if len(parts) != 2 {
			return "", false, fmt.Errorf("invalid dependency reference ${%s}", expr)
		}
		outputs, ok := c.dependencies[parts[0]]
		if !ok {
			return "", false, fmt.Errorf("unknown dependency reference ${%s}", expr)
		}
		return lookupResolvedOutput(outputs, expr, c.secrets)

	case strings.HasPrefix(expr, "secrets."):
		key := strings.TrimPrefix(expr, "secrets.")
		if key == "" {
			return "", false, fmt.Errorf("empty secret reference ${%s}", expr)
		}
		if c.secrets != nil {
			if value, ok := c.secrets[key]; ok {
				return value, true, nil
			}
		}
		return "secret://" + key, true, nil

	default:
		return "", false, fmt.Errorf("unsupported expression ${%s}", expr)
	}
}

func lookupResolvedOutput(outputs map[string]ResolvedOutput, expr string, secrets map[string]string) (string, bool, error) {
	ref := expr
	if idx := strings.LastIndex(expr, ".outputs."); idx >= 0 {
		ref = expr[idx+len(".outputs."):]
	} else if strings.HasPrefix(expr, "outputs.") {
		ref = strings.TrimPrefix(expr, "outputs.")
	}
	parts := strings.Split(ref, ".")
	if len(parts) == 0 || parts[0] == "" {
		return "", false, fmt.Errorf("invalid output reference ${%s}", expr)
	}
	name := parts[0]
	field := ""
	if len(parts) > 1 {
		field = parts[1]
	}
	output, ok := outputs[name]
	if !ok {
		return "", false, fmt.Errorf("unknown output reference ${%s}", expr)
	}
	if output.Sensitive {
		if secrets != nil {
			if value, ok := secrets[name]; ok {
				return value, true, nil
			}
		}
		return "secret://" + name, true, nil
	}
	switch field {
	case "":
		if output.Kind == "endpoint" {
			return net.JoinHostPort(output.Host, strconv.Itoa(output.Port)), false, nil
		}
		if strings.HasPrefix(output.Value, "secret://") {
			return output.Value, true, nil
		}
		return output.Value, false, nil
	case "host":
		if output.Kind != "endpoint" {
			return "", false, fmt.Errorf("output ${%s} is not an endpoint", expr)
		}
		return output.Host, false, nil
	case "port":
		if output.Kind != "endpoint" {
			return "", false, fmt.Errorf("output ${%s} is not an endpoint", expr)
		}
		return strconv.Itoa(output.Port), false, nil
	case "protocol":
		if output.Kind != "endpoint" {
			return "", false, fmt.Errorf("output ${%s} is not an endpoint", expr)
		}
		return output.Protocol, false, nil
	case "value":
		if output.Kind == "endpoint" {
			return net.JoinHostPort(output.Host, strconv.Itoa(output.Port)), false, nil
		}
		return output.Value, false, nil
	default:
		return "", false, fmt.Errorf("unknown output field ${%s}", expr)
	}
}

func resolveOutputDecls(decls map[string]BundleOutput, providerHost string, providerCfg *config.HostConfig, consumerHost string, consumerCfg *config.HostConfig, sameProject bool, baseCtx *resolveContext) (map[string]ResolvedOutput, error) {
	out := map[string]ResolvedOutput{}
	if len(decls) == 0 {
		return out, nil
	}
	ctx := baseCtx.forHost(providerHost, providerCfg)
	for _, name := range sortedKeys(decls) {
		decl := decls[name]
		if decl.IsEndpoint() {
			resolved, err := resolveEndpointOutput(name, decl, providerHost, providerCfg, consumerHost, consumerCfg, sameProject, ctx)
			if err != nil {
				return nil, err
			}
			out[name] = resolved
			continue
		}
		value, sensitive, err := ctx.Interpolate(decl.Value)
		if err != nil {
			return nil, fmt.Errorf("output %s: %w", name, err)
		}
		if decl.Sensitive || sensitive {
			if baseCtx.secrets != nil {
				if secretValue, ok := baseCtx.secrets[name]; ok {
					value = secretValue
				} else if !strings.HasPrefix(value, "secret://") {
					value = "secret://" + name
				}
			} else if !strings.HasPrefix(value, "secret://") {
				value = "secret://" + name
			}
		}
		out[name] = ResolvedOutput{Value: value, Sensitive: decl.Sensitive || sensitive}
	}
	return out, nil
}

func resolveEndpointOutput(name string, decl BundleOutput, providerHost string, providerCfg *config.HostConfig, consumerHost string, consumerCfg *config.HostConfig, sameProject bool, ctx *resolveContext) (ResolvedOutput, error) {
	service := decl.Service
	if service == "" {
		service = decl.Host
	}
	port := decl.Port
	published := decl.PublishedPort
	if port == 0 && published > 0 {
		port = published
	}

	resolved := ResolvedOutput{
		Kind:     "endpoint",
		Protocol: decl.Protocol,
		Port:     port,
		Service:  service,
	}
	if decl.Sensitive {
		resolved.Sensitive = true
	}

	switch {
	case providerHost == consumerHost && sameProject:
		if service == "" {
			return ResolvedOutput{}, fmt.Errorf("output %s: same-project endpoint requires service", name)
		}
		resolved.Host = service
		resolved.Port = port

	case providerHost == consumerHost:
		if consumerCfg == nil {
			return ResolvedOutput{}, fmt.Errorf("output %s: consumer host %s not configured", name, consumerHost)
		}
		resolved.Host = hostAddress(consumerCfg)
		if resolved.Host == "" {
			return ResolvedOutput{}, fmt.Errorf("output %s: consumer host %s has no address", name, consumerHost)
		}
		if published > 0 {
			resolved.Port = published
		}

	default:
		remote := decl.Remote
		if strings.TrimSpace(remote) != "" {
			value, _, err := ctx.Interpolate(remote)
			if err != nil {
				return ResolvedOutput{}, fmt.Errorf("output %s remote: %w", name, err)
			}
			remote = value
		}
		if strings.TrimSpace(remote) == "" && providerCfg != nil {
			remote = providerCfg.MagicDNS
		}
		if strings.TrimSpace(remote) == "" && providerCfg != nil {
			remote = hostAddress(providerCfg)
		}
		if strings.TrimSpace(remote) == "" && providerCfg != nil {
			return ResolvedOutput{}, fmt.Errorf("output %s: cross-host endpoint for %s needs MagicDNS or address", name, providerHost)
		}
		if strings.TrimSpace(remote) == "" {
			remote = providerHost
			if i := strings.LastIndex(remote, "@"); i >= 0 {
				remote = remote[i+1:]
			}
		}
		if strings.TrimSpace(remote) == "" {
			return ResolvedOutput{}, fmt.Errorf("output %s: cross-host endpoint for %s needs MagicDNS or address", name, providerHost)
		}
		resolved.Host = remote
		if published > 0 {
			resolved.Port = published
		}
	}

	return resolved, nil
}

func interpolateHealth(health *BundleHealth, ctx *resolveContext) (*BundleHealth, error) {
	if health == nil {
		return nil, nil
	}
	clone := *health
	for _, field := range []*string{&clone.HTTP, &clone.TCP, &clone.ExecIn} {
		value, _, err := ctx.Interpolate(*field)
		if err != nil {
			return nil, err
		}
		*field = value
	}
	if len(clone.Command) > 0 {
		command := make(CommandList, len(clone.Command))
		for i, part := range clone.Command {
			value, _, err := ctx.Interpolate(part)
			if err != nil {
				return nil, err
			}
			command[i] = value
		}
		clone.Command = command
	}
	return &clone, nil
}

func resolveWiring(componentKey string, manifest *BundleManifest, comp *componentData, components map[string]*componentData, ctx *resolveContext) (map[string]string, error) {
	env := map[string]string{}
	if len(manifest.Wiring) == 0 {
		return env, nil
	}
	for _, wiringKey := range sortedKeys(manifest.Wiring) {
		values := manifest.Wiring[wiringKey]
		target := ""
		switch {
		case wiringKey == componentKey:
			target = componentKey
		case len(components) == 1 && containsString(comp.services, wiringKey):
			target = componentKey
		default:
			if _, ok := components[wiringKey]; !ok {
				return nil, fmt.Errorf("wiring references unknown component %q", wiringKey)
			}
			continue
		}
		if target != componentKey {
			continue
		}
		for _, key := range sortedKeys(values) {
			value, _, err := ctx.Interpolate(values[key])
			if err != nil {
				return nil, fmt.Errorf("wiring %s.%s: %w", wiringKey, key, err)
			}
			env[key] = value
		}
	}
	return env, nil
}

func topoSortComponents(components map[string]*componentData) ([]string, error) {
	state := map[string]int{} // 0 unvisited, 1 visiting, 2 done
	order := []string{}
	var visit func(string, []string) error
	visit = func(key string, stack []string) error {
		switch state[key] {
		case 2:
			return nil
		case 1:
			return fmt.Errorf("component after cycle detected: %s", strings.Join(append(stack, key), " -> "))
		}
		state[key] = 1
		comp := components[key]
		for _, dep := range comp.after {
			if _, ok := components[dep]; !ok {
				return fmt.Errorf("component %s: after references unknown component %q", key, dep)
			}
			if err := visit(dep, append(stack, key)); err != nil {
				return err
			}
		}
		state[key] = 2
		order = append(order, key)
		return nil
	}
	for _, key := range sortedKeys(components) {
		if err := visit(key, nil); err != nil {
			return nil, err
		}
	}
	return order, nil
}

func renderResolvedPlan(plan *ResolvedPlan, host string, manifest *BundleManifest, components map[string]*componentData, ctx *resolveContext, dependencies map[string]*dependencyData) error {
	serviceMap := map[string]ServiceSpec{}
	uploads := map[string][]byte{}
	var base []byte
	var err error

	if manifest.IsComposition() {
		type includeEntry struct {
			Path string `yaml:"path"`
		}
		type includeDoc struct {
			Name    string         `yaml:"name,omitempty"`
			Include []includeEntry `yaml:"include"`
		}
		doc := includeDoc{Name: manifest.Name, Include: []includeEntry{}}
		for _, key := range plan.Components {
			comp := components[key]
			if comp.generated {
				remotePath := filepath.ToSlash(filepath.Join(".spool", "components", key, "compose.yaml"))
				content := []byte(fmt.Sprintf("services:\n  %s:\n    image: %s\n", key, comp.image))
				uploads[remotePath] = content
				doc.Include = append(doc.Include, includeEntry{Path: remotePath})
				serviceMap[key] = ServiceSpec{Name: key, Image: comp.image, Component: key}
				continue
			}
			for _, tmpl := range comp.templates {
				data, err := os.ReadFile(templateFilePath(comp.root, tmpl))
				if err != nil {
					return fmt.Errorf("read component %s template %s failed: %w", key, tmpl, err)
				}
				remotePath := filepath.ToSlash(filepath.Join(".spool", "components", key, filepath.Base(tmpl)))
				uploads[remotePath] = data
				doc.Include = append(doc.Include, includeEntry{Path: remotePath})
				parsed, err := parseComposeServices(data)
				if err != nil {
					return fmt.Errorf("parse component %s template %s failed: %w", key, tmpl, err)
				}
				for name, image := range parsed {
					serviceMap[name] = ServiceSpec{Name: name, Image: image, Component: key}
				}
			}
			if len(comp.templates) == 0 && len(comp.services) > 0 {
				block := map[string]interface{}{"services": map[string]interface{}{}}
				services := block["services"].(map[string]interface{})
				for _, svc := range comp.services {
					entry := map[string]interface{}{}
					if image := comp.images[svc]; image != "" {
						entry["image"] = image
					}
					services[svc] = entry
					serviceMap[svc] = ServiceSpec{Name: svc, Image: comp.images[svc], Component: key}
				}
				data, err := yaml.Marshal(block)
				if err != nil {
					return err
				}
				remotePath := filepath.ToSlash(filepath.Join(".spool", "components", key, "generated.yaml"))
				uploads[remotePath] = data
				doc.Include = append(doc.Include, includeEntry{Path: remotePath})
			}
		}
		base, err = yaml.Marshal(doc)
		if err != nil {
			return err
		}
	} else {
		templates := manifest.Templates
		data := make([][]byte, 0, len(templates))
		if !manifest.IsScriptManifest() {
			for _, tmpl := range templates {
				content, err := os.ReadFile(templateFilePath(plan.BundleRoot, tmpl))
				if err != nil {
					return fmt.Errorf("read template %s failed: %w", tmpl, err)
				}
				data = append(data, content)
				uploads[filepath.ToSlash(filepath.Base(tmpl))] = content
				parsed, err := parseComposeServices(content)
				if err != nil {
					return fmt.Errorf("parse template %s failed: %w", tmpl, err)
				}
				for name, image := range parsed {
					serviceMap[name] = ServiceSpec{Name: name, Image: image, Component: name}
				}
			}
			base, err = renderComposeBase(templates, data)
			if err != nil {
				return err
			}
		} else {
			base = []byte{}
		}
	}

	// 服务按名字排序，确保 diff / lock 稳定。
	names := make([]string, 0, len(serviceMap))
	for name := range serviceMap {
		names = append(names, name)
	}
	sort.Strings(names)
	plan.Services = make([]ServiceSpec, 0, len(names))
	for _, name := range names {
		plan.Services = append(plan.Services, serviceMap[name])
	}

	envByService := map[string]map[string]string{}
	images := map[string]string{}
	for _, key := range plan.Components {
		comp := components[key]
		for _, svc := range comp.services {
			if comp.env != nil {
				envByService[svc] = comp.env
			}
			if image := comp.images[svc]; image != "" {
				images[svc] = image
			}
		}
	}
	for name, image := range images {
		if spec, ok := serviceMap[name]; ok && image != "" {
			spec.Image = image
			serviceMap[name] = spec
		}
	}
	for i := range plan.Services {
		if image := images[plan.Services[i].Name]; image != "" {
			plan.Services[i].Image = image
		}
	}
	// 单 bundle 的 wiring 可能直接以服务名为 key。
	if !manifest.IsComposition() {
		for key, values := range manifest.Wiring {
			if _, ok := serviceMap[key]; ok {
				resolved := map[string]string{}
				for envKey, raw := range values {
					value, _, err := ctx.Interpolate(raw)
					if err != nil {
						return fmt.Errorf("wiring %s.%s: %w", key, envKey, err)
					}
					resolved[envKey] = value
				}
				envByService[key] = resolved
			}
		}
	}

	extraHosts := map[string][]string{}
	for _, depKey := range sortedKeys(dependencies) {
		seen := map[string]bool{}
		var entries []string
		for _, output := range ctx.dependencies[depKey] {
			if output.Kind != "endpoint" || net.ParseIP(output.Host) == nil {
				continue
			}
			alias := output.Service
			if alias == "" {
				alias = depKey
			}
			entry := alias + ":" + output.Host
			if seen[entry] {
				continue
			}
			seen[entry] = true
			entries = append(entries, entry)
		}
		if len(entries) == 0 {
			continue
		}
		sort.Strings(entries)
		for _, svc := range names {
			extraHosts[svc] = append(extraHosts[svc], entries...)
		}
	}
	for svc := range extraHosts {
		sort.Strings(extraHosts[svc])
	}

	override, err := renderSpoolOverrideWithOptions(overrideOptions{
		Host:       host,
		Bundle:     manifest.Name,
		Version:    manifest.Version,
		Services:   serviceMap,
		Env:        envByService,
		ExtraHosts: extraHosts,
		Images:     images,
	})
	if err != nil {
		return err
	}

	plan.Compose = base
	plan.Override = override
	plan.Uploads = uploads
	plan.Env = map[string]string{}
	plan.Warnings = append(plan.Warnings, componentWarnings(plan.Components, components)...)
	return nil
}

func componentWarnings(order []string, components map[string]*componentData) []string {
	var warnings []string
	for _, key := range order {
		if components[key].optional {
			warnings = append(warnings, fmt.Sprintf("component %s is optional: health failures only warn", key))
		}
	}
	return warnings
}

func buildLockSnapshot(host, bundle string, inputs map[string]string, components map[string]*componentData, resolvedComponents map[string]map[string]ResolvedOutput, dependencies map[string]*dependencyData, resolvedDeps map[string]map[string]ResolvedOutput, plan *ResolvedPlan) *LockSnapshot {
	lock := &LockSnapshot{
		Version:    LockVersion,
		Host:       host,
		Bundle:     bundle,
		InputsHash: hashInputs(inputs),
		Resolved: ResolvedSnapshot{
			Components:   map[string]ResolvedComponent{},
			Dependencies: map[string]ResolvedDependency{},
		},
		Rendered: RenderedSnapshot{
			Compose:        string(plan.Compose),
			Override:       string(plan.Override),
			Env:            cloneStringMap(plan.Env),
			ComposeSHA256:  hashRendered(plan.Compose, plan.Uploads, plan.Override),
			OverrideSHA256: hashBytes(plan.Override),
		},
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	for key, comp := range components {
		componentOutputs := resolvedComponents[key]
		if componentOutputs == nil {
			componentOutputs = map[string]ResolvedOutput{}
		}
		lock.Resolved.Components[key] = ResolvedComponent{
			Host:      host,
			Source:    sourcePtr(comp.source),
			Outputs:   componentOutputs,
			Version:   comp.version,
			Image:     comp.image,
			Images:    cloneStringMap(comp.images),
			Health:    comp.health,
			Optional:  comp.optional,
			After:     append([]string(nil), comp.after...),
			ExecIn:    comp.execIn,
			Templates: append([]string(nil), comp.templates...),
			Services:  append([]string(nil), comp.services...),
			Env:       cloneStringMap(comp.env),
		}
	}
	for key, dep := range dependencies {
		resolved := resolvedDeps[key]
		if resolved == nil {
			resolved = map[string]ResolvedOutput{}
		}
		lock.Resolved.Dependencies[key] = ResolvedDependency{
			Host:    dep.host,
			Source:  sourcePtr(dep.source),
			Version: dep.version,
			Outputs: resolved,
		}
	}
	lock.LockHash = computeLockHash(lock)
	return lock
}

func computeLockHash(lock *LockSnapshot) string {
	type hashDoc struct {
		Version    int              `yaml:"version"`
		Host       string           `yaml:"host"`
		Bundle     string           `yaml:"bundle"`
		InputsHash string           `yaml:"inputs_hash"`
		Resolved   ResolvedSnapshot `yaml:"resolved"`
	}
	data, _ := yaml.Marshal(hashDoc{
		Version:    lock.Version,
		Host:       lock.Host,
		Bundle:     lock.Bundle,
		InputsHash: lock.InputsHash,
		Resolved:   lock.Resolved,
	})
	return "sha256:" + hashBytes(data)
}

func hashInputs(inputs map[string]string) string {
	keys := sortedKeys(inputs)
	var b strings.Builder
	for _, key := range keys {
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(inputs[key])
		b.WriteString("\n")
	}
	return "sha256:" + hashBytes([]byte(b.String()))
}

func hashRendered(compose []byte, uploads map[string][]byte, override []byte) string {
	h := sha256.New()
	h.Write(compose)
	keys := make([]string, 0, len(uploads))
	for key := range uploads {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		h.Write([]byte(key))
		h.Write([]byte{0})
		h.Write(uploads[key])
		h.Write([]byte{0})
	}
	h.Write(override)
	return "sha256:" + hex.EncodeToString(h.Sum(nil))
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func sourcePtr(src BundleSource) *BundleSource {
	if src.Type == "" {
		return nil
	}
	copy := src
	return &copy
}

// LockPath 返回本地 lock 路径。
func LockPath(baseDir, host, bundle string) string {
	return filepath.Join(baseDir, ".spool", "lock", host, bundle+".yaml")
}

// WriteLock 写入 lock 快照。
func WriteLock(baseDir string, lock *LockSnapshot) (string, error) {
	path := LockPath(baseDir, lock.Host, lock.Bundle)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}
	data, err := yaml.Marshal(lock)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return "", err
	}
	return path, nil
}

// LoadLock 读取本地 lock 快照。
func LoadLock(baseDir, host, bundle string) (*LockSnapshot, error) {
	data, err := os.ReadFile(LockPath(baseDir, host, bundle))
	if err != nil {
		return nil, err
	}
	var lock LockSnapshot
	if err := yaml.Unmarshal(data, &lock); err != nil {
		return nil, err
	}
	return &lock, nil
}

// LocksEqual 比较 plan 与已有 lock 是否一致。
func LocksEqual(a, b *LockSnapshot) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Version == b.Version &&
		a.Host == b.Host &&
		a.Bundle == b.Bundle &&
		a.InputsHash == b.InputsHash &&
		a.LockHash == b.LockHash &&
		a.Rendered.ComposeSHA256 == b.Rendered.ComposeSHA256
}

func hostAddressFromString(address string) string {
	if i := strings.LastIndex(address, "@"); i >= 0 {
		return address[i+1:]
	}
	return address
}

func hostAddress(cfg *config.HostConfig) string {
	if cfg == nil {
		return ""
	}
	return hostAddressFromString(cfg.Address)
}

func mergeStringMaps(maps ...map[string]string) map[string]string {
	result := map[string]string{}
	for _, m := range maps {
		for key, value := range m {
			result[key] = value
		}
	}
	return result
}

func cloneStringMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// SortedComponentKeys 返回稳定的 component key 列表。
func SortedComponentKeys(m map[string]BundleComponent) []string {
	return sortedKeys(m)
}

// SortedDependencyKeys 返回稳定的 dependency key 列表。
func SortedDependencyKeys(m map[string]BundleDependency) []string {
	return sortedKeys(m)
}
