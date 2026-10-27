package engine

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// BundleManifest 定义 bundle 的元数据。
//
// 同时兼容两种写法：
//   - 旧扁平 manifest：name/type/templates/services/features/defaults...
//   - 轻契约 manifest：apiVersion/kind/metadata/spec.{delivery,outputs,lifecycle,...}
//
// 加载后统一归一化到 BundleManifest 的扁平字段，供旧代码继续使用。
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

	// AliasOf 让旧 bundle 名作为新 bundle 的兼容别名；加载时透明解析到目标 manifest。
	AliasOf string `yaml:"alias_of,omitempty"`
	// DeprecatedAlias 由加载器在跟随 alias_of 时填充，仅用于输出弃用提示。
	DeprecatedAlias string `yaml:"-"`

	Metadata *BundleMetadata `yaml:"metadata,omitempty"`
	Spec     *BundleSpec     `yaml:"spec,omitempty"`

	// 下列字段既支持 spec.*，也支持直接写在顶层（兼容）。
	Compatibility BundleCompatibility          `yaml:"compatibility,omitempty"`
	Delivery      BundleDelivery               `yaml:"delivery,omitempty"`
	Outputs       map[string]BundleOutput      `yaml:"outputs,omitempty"`
	Lifecycle     BundleLifecycle              `yaml:"lifecycle,omitempty"`
	Backup        BundleBackup                 `yaml:"backup,omitempty"`
	Components    map[string]BundleComponent   `yaml:"components,omitempty"`
	Dependencies  map[string]BundleDependency  `yaml:"dependencies,omitempty"`
	Wiring        map[string]map[string]string `yaml:"wiring,omitempty"`
	Inputs        map[string]string            `yaml:"inputs,omitempty"`
}

// BundleMetadata 对应轻契约的 metadata 段。
type BundleMetadata struct {
	Name    string            `yaml:"name"`
	Class   string            `yaml:"class"`
	Version string            `yaml:"version"`
	Owner   string            `yaml:"owner"`
	Labels  map[string]string `yaml:"labels"`
}

// BundleSpec 对应轻契约的 spec 段。
type BundleSpec struct {
	Compatibility BundleCompatibility          `yaml:"compatibility,omitempty"`
	Delivery      BundleDelivery               `yaml:"delivery,omitempty"`
	Outputs       map[string]BundleOutput      `yaml:"outputs,omitempty"`
	Lifecycle     BundleLifecycle              `yaml:"lifecycle,omitempty"`
	Backup        BundleBackup                 `yaml:"backup,omitempty"`
	Components    map[string]BundleComponent   `yaml:"components,omitempty"`
	Dependencies  map[string]BundleDependency  `yaml:"dependencies,omitempty"`
	Wiring        map[string]map[string]string `yaml:"wiring,omitempty"`
	Inputs        map[string]string            `yaml:"inputs,omitempty"`
}

// BundleCompatibility 声明 spool 版本约束（P1 仅记录，不做 solver）。
type BundleCompatibility struct {
	Spool string `yaml:"spool,omitempty"`
}

// BundleDelivery 描述交付方式和文件。
type BundleDelivery struct {
	Driver    string          `yaml:"driver,omitempty"` // compose | stack | script
	Templates []string        `yaml:"templates,omitempty"`
	Artifact  *BundleArtifact `yaml:"artifact,omitempty"`
}

// BundleArtifact 描述 product 的镜像 artifact。
type BundleArtifact struct {
	Type  string `yaml:"type,omitempty"`
	Image string `yaml:"image,omitempty"`
	// Digest 使用字符串而不是结构体，支持 sha256:... 与完整 image@sha256:...
	Digest string `yaml:"digest,omitempty"`
}

// BundleOutput 表示一个 output 声明。标量 output 与 endpoint output 共用该类型。
type BundleOutput struct {
	Value string // 标量输出值

	Kind          string `yaml:"kind,omitempty"`
	Service       string `yaml:"service,omitempty"`
	Host          string `yaml:"host,omitempty"`
	Port          int    `yaml:"port,omitempty"`
	PublishedPort int    `yaml:"published_port,omitempty"`
	Remote        string `yaml:"remote,omitempty"`
	Protocol      string `yaml:"protocol,omitempty"`
	Sensitive     bool   `yaml:"sensitive,omitempty"`
}

// UnmarshalYAML 支持 output 既可以是标量，也可以是 endpoint 映射。
func (o *BundleOutput) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		o.Value = node.Value
		return nil
	}
	type rawOutput struct {
		Value         string `yaml:"value"`
		Kind          string `yaml:"kind"`
		Service       string `yaml:"service"`
		Host          string `yaml:"host"`
		Port          int    `yaml:"port"`
		PublishedPort int    `yaml:"published_port"`
		Remote        string `yaml:"remote"`
		Protocol      string `yaml:"protocol"`
		Sensitive     bool   `yaml:"sensitive"`
	}
	var raw rawOutput
	if err := node.Decode(&raw); err != nil {
		return err
	}
	*o = BundleOutput{
		Value:         raw.Value,
		Kind:          raw.Kind,
		Service:       raw.Service,
		Host:          raw.Host,
		Port:          raw.Port,
		PublishedPort: raw.PublishedPort,
		Remote:        raw.Remote,
		Protocol:      raw.Protocol,
		Sensitive:     raw.Sensitive,
	}
	return nil
}

// IsEndpoint 判断是否为 endpoint 输出。
func (o BundleOutput) IsEndpoint() bool {
	return o.Kind == "endpoint" || o.Service != "" || o.Port != 0
}

// BundleLifecycle 描述健康检查、升级、hook 与恢复。
type BundleLifecycle struct {
	Health  *BundleHealth `yaml:"health,omitempty"`
	Upgrade BundleUpgrade `yaml:"upgrade,omitempty"`
	Hooks   BundleHooks   `yaml:"hooks,omitempty"`
	Restore BundleRestore `yaml:"restore,omitempty"`
}

// BundleUpgrade 描述升级策略。
type BundleUpgrade struct {
	Strategy     string `yaml:"strategy,omitempty"` // recreate | rolling | backup-then-recreate
	Irreversible bool   `yaml:"irreversible,omitempty"`
	Migrate      string `yaml:"migrate,omitempty"`
}

// BundleHooks 描述升级前后 hook。
type BundleHooks struct {
	PreUpgrade  string `yaml:"pre_upgrade,omitempty"`
	PostUpgrade string `yaml:"post_upgrade,omitempty"`
}

// BundleRestore 描述显式 restore hook。
type BundleRestore struct {
	Hook string `yaml:"hook,omitempty"`
}

// BundleBackup 描述产品方一致性备份入口与无一致性语义的资产。
type BundleBackup struct {
	Hook   string              `yaml:"hook,omitempty"`
	Assets []BundleBackupAsset `yaml:"assets,omitempty"`
}

// BundleBackupAsset 描述卷/目录级备份资产。
type BundleBackupAsset struct {
	Type   string `yaml:"type"`
	Source string `yaml:"source"`
}

// BundleHealth 描述组件/栈健康检查。
type BundleHealth struct {
	HTTP    string      `yaml:"http,omitempty"`
	TCP     string      `yaml:"tcp,omitempty"`
	Command CommandList `yaml:"command,omitempty"`
	From    string      `yaml:"from,omitempty"` // container | host
	ExecIn  string      `yaml:"exec_in,omitempty"`
	Timeout string      `yaml:"timeout,omitempty"`
}

// CommandList 支持命令既可写标量也可写数组。
type CommandList []string

// UnmarshalYAML 实现标量/数组兼容。
func (c *CommandList) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		*c = CommandList{node.Value}
		return nil
	}
	var list []string
	if err := node.Decode(&list); err != nil {
		return err
	}
	*c = list
	return nil
}

// BundleSource 声明组件/依赖的来源（dir | git | oci）。
type BundleSource struct {
	Type        string        `yaml:"type"`                   // dir | git | oci
	Repo        string        `yaml:"repo,omitempty"`         // git
	Path        string        `yaml:"path,omitempty"`         // dir: 本地目录；git/oci: 包内子目录
	Commit      string        `yaml:"commit,omitempty"`       // git 固定 commit
	Ref         string        `yaml:"ref,omitempty"`          // oci: registry/repo[:tag]
	Digest      string        `yaml:"digest,omitempty"`       // oci: 固定 manifest digest
	Insecure    bool          `yaml:"insecure,omitempty"`     // oci: 允许 http registry（仅测试/内网）
	Username    string        `yaml:"username,omitempty"`     // oci: basic auth 用户名
	PasswordEnv string        `yaml:"password_env,omitempty"` // oci: 读取密码的环境变量名
	Cosign      *BundleCosign `yaml:"cosign,omitempty"`       // oci: 可选验签门禁
}

// BundleCosign 配置 OCI artifact 的 cosign 验签门禁。
type BundleCosign struct {
	Key      string `yaml:"key,omitempty"`
	Identity string `yaml:"identity,omitempty"`
	Issuer   string `yaml:"issuer,omitempty"`
}

// BundleComponent 是本 composition 负责部署、且位于目标 host 的组件。
type BundleComponent struct {
	Bundle        string                  `yaml:"bundle,omitempty"`
	Version       string                  `yaml:"version,omitempty"`
	Image         string                  `yaml:"image,omitempty"`
	Config        string                  `yaml:"config,omitempty"`
	Source        *BundleSource           `yaml:"source,omitempty"`
	Health        *BundleHealth           `yaml:"health,omitempty"`
	Optional      bool                    `yaml:"optional,omitempty"`
	After         []string                `yaml:"after,omitempty"`
	ExecIn        string                  `yaml:"exec_in,omitempty"`
	Outputs       map[string]BundleOutput `yaml:"outputs,omitempty"`
	SharedNetwork bool                    `yaml:"shared_network,omitempty"`
	// 组件级生命周期；未声明时从被引用的 product bundle 继承。
	Backup  BundleBackup  `yaml:"backup,omitempty"`
	Restore BundleRestore `yaml:"restore,omitempty"`
	Upgrade BundleUpgrade `yaml:"upgrade,omitempty"`
	Hooks   BundleHooks   `yaml:"hooks,omitempty"`
}

// BundleDependency 是已在别处部署、只读 outputs 的依赖。
type BundleDependency struct {
	Bundle        string        `yaml:"bundle"`
	Version       string        `yaml:"version,omitempty"`
	Host          string        `yaml:"host,omitempty"`
	Outputs       []string      `yaml:"outputs,omitempty"`
	Source        *BundleSource `yaml:"source,omitempty"`
	SharedNetwork bool          `yaml:"shared_network,omitempty"`
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
	Systemd           bool      `yaml:"systemd"`
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

// IsComposition 判断是否声明了 components。
func (m *BundleManifest) IsComposition() bool {
	return len(m.Components) > 0
}

// Normalize 将 metadata/spec 与旧扁平字段合并，并补齐默认值。
func (m *BundleManifest) Normalize(bundleName string) {
	if m.Name == "" {
		m.Name = bundleName
	}
	if m.Metadata != nil {
		if m.Name == "" && m.Metadata.Name != "" {
			m.Name = m.Metadata.Name
		}
		if m.Class == "" {
			m.Class = m.Metadata.Class
		}
		if m.Version == "" {
			m.Version = m.Metadata.Version
		}
		if m.Owner == "" {
			m.Owner = m.Metadata.Owner
		}
		if len(m.Labels) == 0 {
			m.Labels = m.Metadata.Labels
		}
	}
	if m.Spec != nil {
		if m.Compatibility.Spool == "" {
			m.Compatibility = m.Spec.Compatibility
		}
		if m.Delivery.Driver == "" {
			m.Delivery = m.Spec.Delivery
		}
		if len(m.Outputs) == 0 {
			m.Outputs = m.Spec.Outputs
		}
		if m.Lifecycle.Health == nil && m.Lifecycle.Upgrade == (BundleUpgrade{}) &&
			m.Lifecycle.Hooks == (BundleHooks{}) && m.Lifecycle.Restore == (BundleRestore{}) {
			m.Lifecycle = m.Spec.Lifecycle
		}
		if m.Backup.Hook == "" && len(m.Backup.Assets) == 0 {
			m.Backup = m.Spec.Backup
		}
		if len(m.Components) == 0 {
			m.Components = m.Spec.Components
		}
		if len(m.Dependencies) == 0 {
			m.Dependencies = m.Spec.Dependencies
		}
		if len(m.Wiring) == 0 {
			m.Wiring = m.Spec.Wiring
		}
		if len(m.Inputs) == 0 {
			m.Inputs = m.Spec.Inputs
		}
	}
	if m.Type == "" && m.Delivery.Driver != "" {
		m.Type = m.Delivery.Driver
	}
	if len(m.Templates) == 0 && len(m.Delivery.Templates) > 0 {
		m.Templates = m.Delivery.Templates
	}
	if m.Type == "" {
		m.Type = "compose"
	}
	if m.Labels == nil {
		m.Labels = map[string]string{}
	}
}

// LoadManifestFile 从指定文件加载并归一化 manifest。
func LoadManifestFile(path, bundleName string) (*BundleManifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read manifest for %s: %w", bundleName, err)
	}

	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("failed to parse manifest for %s: %w", bundleName, err)
	}
	stripExtensionKeys(&root)
	normalized, err := yaml.Marshal(&root)
	if err != nil {
		return nil, fmt.Errorf("failed to normalize manifest for %s: %w", bundleName, err)
	}
	var manifest BundleManifest
	decoder := yaml.NewDecoder(bytes.NewReader(normalized))
	// 严格解码：拼写错误的 lifecycle/backup 字段不能被静默忽略。
	decoder.KnownFields(true)
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("failed to parse manifest for %s: %w", bundleName, err)
	}
	manifest.Normalize(bundleName)
	return &manifest, nil
}

// stripExtensionKeys 移除所有以 x- 开头的扩展键（Kamal 风格），其余未知字段由严格解码拒绝。
func stripExtensionKeys(node *yaml.Node) {
	if node == nil {
		return
	}
	if node.Kind == yaml.DocumentNode {
		if len(node.Content) == 0 {
			return
		}
		node = node.Content[0]
	}
	if node.Kind != yaml.MappingNode {
		return
	}
	// 只移除顶层 x- 扩展键；labels 等自由映射中的键不应被改写。
	filtered := make([]*yaml.Node, 0, len(node.Content))
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := node.Content[i]
		if strings.HasPrefix(strings.ToLower(key.Value), "x-") {
			continue
		}
		filtered = append(filtered, key, node.Content[i+1])
	}
	node.Content = filtered
}

// FindManifestFile 返回 bundle 根目录下的 manifest 文件。
// 兼容标准 manifest.yaml 与产品仓库的 bundle.yaml。
func FindManifestFile(root string) (string, error) {
	for _, name := range []string{"manifest.yaml", "bundle.yaml"} {
		path := filepath.Join(root, name)
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("manifest.yaml or bundle.yaml not found under %s", root)
}

// LoadManifestFromDir 从 bundle 根目录加载 manifest。
func LoadManifestFromDir(root, bundleName string) (*BundleManifest, error) {
	path, err := FindManifestFile(root)
	if err != nil {
		return nil, fmt.Errorf("failed to load manifest for %s: %w", bundleName, err)
	}
	return LoadManifestFile(path, bundleName)
}

// LoadManifest 从 bundles/<name>/manifest.yaml 加载
type ManifestLoader struct {
	baseDir string
}

// NewManifestLoader 创建加载器
func NewManifestLoader(baseDir string) *ManifestLoader {
	return &ManifestLoader{baseDir: baseDir}
}

// Load 加载指定 bundle 的 manifest；alias_of 会透明解析到目标 bundle。
func (ml *ManifestLoader) Load(bundleName string) (*BundleManifest, error) {
	return ml.load(bundleName, map[string]bool{}, 0)
}

func (ml *ManifestLoader) load(bundleName string, seen map[string]bool, depth int) (*BundleManifest, error) {
	if depth > 8 {
		return nil, fmt.Errorf("bundle alias chain too deep at %s", bundleName)
	}
	if seen[bundleName] {
		return nil, fmt.Errorf("bundle alias cycle detected at %s", bundleName)
	}
	seen[bundleName] = true

	manifest, err := LoadManifestFromDir(filepath.Join(ml.baseDir, "bundles", bundleName), bundleName)
	if err != nil {
		return nil, err
	}
	if manifest.AliasOf == "" {
		return manifest, nil
	}

	target, err := ml.load(manifest.AliasOf, seen, depth+1)
	if err != nil {
		return nil, fmt.Errorf("bundle %s alias %s: %w", bundleName, manifest.AliasOf, err)
	}
	clone := *target
	clone.DeprecatedAlias = bundleName
	return &clone, nil
}

// ManifestBundleRoot 返回本地 bundle 根目录。
func ManifestBundleRoot(baseDir, bundleName string) string {
	return filepath.Join(baseDir, "bundles", bundleName)
}

// IsScriptManifest 判断是否为 script 驱动。
func (m *BundleManifest) IsScriptManifest() bool {
	return strings.EqualFold(m.Type, "script")
}

// templateFilePath 解析模板路径：优先 bundle 根目录（product 的 deploy/compose.yaml），
// 回退到传统的 templates/<name>。
func templateFilePath(root, name string) string {
	direct := filepath.Join(root, filepath.FromSlash(name))
	if _, err := os.Stat(direct); err == nil {
		return direct
	}
	return filepath.Join(root, "templates", filepath.FromSlash(name))
}
