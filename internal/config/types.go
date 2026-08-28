package config

import (
	"fmt"
	"strings"
)

// ==================== 全局配置 ====================

type GlobalConfig struct {
	SSHKeyPath         string         `yaml:"ssh_key_path"          mapstructure:"ssh_key_path"`        // SSH 私钥路径
	AgeKeyPath         string         `yaml:"age_key_path"          mapstructure:"age_key_path"`        // SOPS age 密钥路径
	DefaultDomain      string         `yaml:"default_domain"        mapstructure:"default_domain"`      // 默认域名后缀
	BackupDir          string         `yaml:"backup_dir"           mapstructure:"backup_dir"`           // 备份目录
	DNSGatewayIP       string         `yaml:"dns_gateway_ip"        mapstructure:"dns_gateway_ip"`      // DNS 网关 IP
	DNSHeadscaleServer string         `yaml:"dns_headscale_server" mapstructure:"dns_headscale_server"` // Headscale DNS
	DNSGatewayHost     string         `yaml:"dns_gateway_host"      mapstructure:"dns_gateway_host"`    // DNS 网关主机别名 (dnsmasq/openclash/caddy/homepage)
	DNSHeadscaleHost   string         `yaml:"dns_headscale_host"    mapstructure:"dns_headscale_host"`  // Headscale 主机别名
	Timeouts           TimeoutConfig  `yaml:"timeouts"             mapstructure:"timeouts"`             // 超时配置
	Defaults           DefaultsConfig `yaml:"defaults"            mapstructure:"defaults"`              // 默认值配置
}

// ==================== 主机配置 ====================

// HostConfig 定义单个主机的完整配置
type HostConfig struct {
	Address       string         `yaml:"address"        mapstructure:"address"`          // 用户名@IP
	SSHPort       string         `yaml:"ssh_port"       mapstructure:"ssh_port"`         // SSH 端口 (默认 22)
	AppPrefix     string         `yaml:"app_prefix"     mapstructure:"app_prefix"`       // 容器名前缀
	Bundles       []string       `yaml:"bundles"        mapstructure:"bundles"`          // 关联的 bundle
	SyncRules     []SyncRule     `yaml:"sync_rules"     mapstructure:"sync_rules"`       // 同步规则
	Services      []ServiceEntry `yaml:"services"       mapstructure:"services"`         // 服务注册
	PostPushHooks []PostPushHook `yaml:"post_push_hooks" mapstructure:"post_push_hooks"` // 推送后钩子
	Backups       []BackupRule   `yaml:"backups"        mapstructure:"backups"`          // 备份规则
	Stack         []string       `yaml:"stack"          mapstructure:"stack"`            // 二进制安装列表
}

// SyncRule 定义单个同步规则
type SyncRule struct {
	Local  string `yaml:"local"  mapstructure:"local"`  // 本地相对路径 (相对于 hosts/<host>/)
	Remote string `yaml:"remote" mapstructure:"remote"` // 远程绝对路径
}

// ServiceEntry 定义单个服务条目
type ServiceEntry struct {
	Alias string `yaml:"alias" mapstructure:"alias"` // 服务别名 (用于命令参数)
	Type  string `yaml:"type"  mapstructure:"type"`  // docker | systemd | initd | openwrt
	Name  string `yaml:"name"  mapstructure:"name"`  // 实际服务名/容器名
}

// PostPushHook 定义推送后执行的钩子
type PostPushHook struct {
	Pattern string `yaml:"pattern" mapstructure:"pattern"` // 文件路径匹配 (用于判断是否触发)
	Command string `yaml:"command" mapstructure:"command"` // 远程执行的命令
}

// BackupRule 定义单个备份规则
type BackupRule struct {
	Type   string `yaml:"type"   mapstructure:"type"`   // volume | dir | db-mysql
	Source string `yaml:"source" mapstructure:"source"` // 卷名或目录路径
	Name   string `yaml:"name"   mapstructure:"name"`   // 备份文件名
}

// TimeoutConfig 定义超时配置
type TimeoutConfig struct {
	SSHConnect string `yaml:"ssh_connect"     mapstructure:"ssh_connect"` // SSH 连接超时 (默认 30s)
	HTTPClient string `yaml:"http_client"     mapstructure:"http_client"` // HTTP 客户端超时 (默认 30s)
	AgentHTTP  string `yaml:"agent_http"      mapstructure:"agent_http"`  // RDP Agent HTTP 超时 (默认 5s)
	AgentRetry string `yaml:"agent_retry"     mapstructure:"agent_retry"` // RDP Agent 重试间隔 (默认 3s)
}

// DefaultsConfig 定义默认值配置
type DefaultsConfig struct {
	LogLines     int    `yaml:"log_lines"       mapstructure:"log_lines"`       // 默认日志行数 (默认 50)
	DockerLogMax string `yaml:"docker_log_max"  mapstructure:"docker_log_max"`  // Docker 日志轮转大小 (默认 50m)
	DockerLogNum int    `yaml:"docker_log_num"  mapstructure:"docker_log_num"`  // Docker 日志轮转文件数 (默认 3)
	DeployPath   string `yaml:"deploy_path"     mapstructure:"deploy_path"`     // Bundle 默认部署路径 (默认 /opt/silkspool)
	ComposeVer   string `yaml:"compose_version" mapstructure:"compose_version"` // Docker Compose 回退版本 (默认 v2.24.5)
}

// ==================== 安装源 ====================

// InstallSource 定义软件安装源
type InstallSource struct {
	Alias          string            `yaml:"alias"           mapstructure:"alias"`           // 软件别名
	Repo           string            `yaml:"repo"            mapstructure:"repo"`            // 仓库标识 (支持 gitlab: 前缀)；与 url 互斥
	URL            string            `yaml:"url"             mapstructure:"url"`             // 直链下载地址 (支持 {ARCH}/{VERSION} 占位)；非空即进入直链模式，忽略 repo/pattern/API
	Pattern        string            `yaml:"pattern"         mapstructure:"pattern"`         // 文件名正则 (仅 repo 模式)
	ServiceName    string            `yaml:"service_name"    mapstructure:"service_name"`    // Systemd 服务名
	DefaultVersion string            `yaml:"default_version" mapstructure:"default_version"` // 默认版本；直链/GitLab 源必填且不能为 latest
	Format         string            `yaml:"format"          mapstructure:"format"`          // 打包格式覆盖 (tar.gz|tar.xz|tar.zst|zip|zst|gz|raw)，空则按文件名后缀探测
	BinaryPath     string            `yaml:"binary_path"     mapstructure:"binary_path"`     // 压缩包内二进制相对路径 (仅 tar/zip 有意义)，空则按 alias/最大 ELF 探测
	ExecArgs       string            `yaml:"exec_args"       mapstructure:"exec_args"`       // systemd ExecStart 附加参数 (无 service 模板时拼装最小 unit)
	SHA256         map[string]string `yaml:"sha256"          mapstructure:"sha256"`          // 按架构 (amd64/arm64...) 的 sha256 校验和；非空则安装前远程比对，空则不校验
}

// IsDirectURL 是否为直链源 (url 非空即优先，忽略 repo)。
func (s *InstallSource) IsDirectURL() bool {
	return strings.TrimSpace(s.URL) != ""
}

// IsGitLab 是否为 GitLab 仓库源。
func (s *InstallSource) IsGitLab() bool {
	return strings.HasPrefix(s.Repo, "gitlab:")
}

// Validate 校验安装源配置的自洽性；在安装前调用。
func (s *InstallSource) Validate() error {
	direct := s.IsDirectURL()
	hasRepo := strings.TrimSpace(s.Repo) != ""

	// url ⊕ repo：不可都空
	if !direct && !hasRepo {
		return fmt.Errorf("安装源 %s: 必须配置 url 或 repo 之一", s.Alias)
	}
	// url 与 repo 互斥（url 优先，若两者都填视为配置错误，避免歧义）
	if direct && hasRepo {
		return fmt.Errorf("安装源 %s: url 与 repo 互斥，不能同时配置（如需直链请只留 url）", s.Alias)
	}

	// 直链源 / GitLab 源无法解析 latest，必须显式 pin
	ver := strings.TrimSpace(s.DefaultVersion)
	if direct && (ver == "" || ver == "latest") {
		return fmt.Errorf("安装源 %s: 直链源无法解析 latest，请在 default_version 显式填写具体版本（如 v1.2.3）", s.Alias)
	}
	if !direct && s.IsGitLab() && (ver == "" || ver == "latest") {
		return fmt.Errorf("安装源 %s: GitLab 源暂不支持 latest 自动解析，请在 default_version 显式填写具体 tag（如 v1.2.3）", s.Alias)
	}

	return nil
}

// ==================== n8n / TrueNAS ====================

// N8NConfig 定义 n8n 集成配置
type N8NConfig struct {
	Host        string `yaml:"host"         mapstructure:"host"`         // 主机别名
	Container   string `yaml:"container"    mapstructure:"container"`    // 容器名
	WorkflowDir string `yaml:"workflow_dir" mapstructure:"workflow_dir"` // 远程工作流目录
	APIURL      string `yaml:"api_url"      mapstructure:"api_url"`      // API 地址
	// APIKey 从 hosts/<host>/.env 动态读取
}

// TrueNASConfig 定义 TrueNAS 集成配置
type TrueNASConfig struct {
	Host     string `yaml:"host"     mapstructure:"host"`     // 主机别名
	APIURL   string `yaml:"api_url" mapstructure:"api_url"` // API 地址
	Username string `yaml:"username" mapstructure:"username"` // 用户名
	Insecure bool   `yaml:"insecure" mapstructure:"insecure"` // 跳过 TLS 证书校验（自签证书无 IP SAN 时）
	// APIKey 从 hosts/<host>/.env 动态读取
}

// ==================== 根配置 ====================

// Config 是 silkspool.yaml 的根结构
type Config struct {
	Global         GlobalConfig          `yaml:"global"          mapstructure:"global"`
	Hosts          map[string]HostConfig `yaml:"hosts"           mapstructure:"hosts"`
	InstallSources []InstallSource       `yaml:"install_sources" mapstructure:"install_sources"`
	N8N            N8NConfig             `yaml:"n8n"             mapstructure:"n8n"`
	TrueNAS        TrueNASConfig         `yaml:"truenas"         mapstructure:"truenas"`
}

// GetHost 返回指定别名的主机配置，不存在则返回 nil
func (c *Config) GetHost(alias string) *HostConfig {
	if host, ok := c.Hosts[alias]; ok {
		return &host
	}
	return nil
}

// GetInstallSource 返回指定别名的安装源，不存在则返回 nil
func (c *Config) GetInstallSource(alias string) *InstallSource {
	for i := range c.InstallSources {
		if c.InstallSources[i].Alias == alias {
			return &c.InstallSources[i]
		}
	}
	return nil
}

// GetService 返回主机中指定别名的服务，不存在则返回 nil
func (h *HostConfig) GetService(alias string) *ServiceEntry {
	for i := range h.Services {
		if h.Services[i].Alias == alias {
			return &h.Services[i]
		}
	}
	return nil
}
