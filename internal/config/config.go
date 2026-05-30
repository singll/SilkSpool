package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

// ConfigLoader 负责加载和解析配置
type ConfigLoader struct {
	baseDir string
}

// NewConfigLoader 创建一个新的配置加载器
func NewConfigLoader(baseDir string) *ConfigLoader {
	return &ConfigLoader{baseDir: baseDir}
}

// Load 加载 silkspool.yaml 配置
// 搜索顺序: ./silkspool.yaml, ~/.silkspool/silkspool.yaml, /etc/silkspool/silkspool.yaml
func (cl *ConfigLoader) Load() (*Config, error) {
	v := viper.New()

	// 设置配置文件名和类型
	v.SetConfigName("silkspool")
	v.SetConfigType("yaml")

	// 搜索路径: 当前目录、项目根目录、全局目录
	searchPaths := []string{
		cl.baseDir,
		cl.baseDir + "/..",
	}

	homeDir, err := os.UserHomeDir()
	if err == nil {
		searchPaths = append(searchPaths, filepath.Join(homeDir, ".silkspool"))
	}
	searchPaths = append(searchPaths, "/etc/silkspool")

	for _, p := range searchPaths {
		v.AddConfigPath(p)
	}

	// 尝试读取配置
	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	var cfg Config

	// 解析全局配置
	if err := v.UnmarshalKey("global", &cfg.Global); err != nil {
		return nil, fmt.Errorf("failed to parse global config: %w", err)
	}

	// 解析主机配置
	if err := v.UnmarshalKey("hosts", &cfg.Hosts); err != nil {
		return nil, fmt.Errorf("failed to parse hosts config: %w", err)
	}

	// 解析安装源配置
	if err := v.UnmarshalKey("install_sources", &cfg.InstallSources); err != nil {
		// 安装源是可选的
		cfg.InstallSources = []InstallSource{}
	}

	// 解析 n8n 配置
	if err := v.UnmarshalKey("n8n", &cfg.N8N); err != nil {
		cfg.N8N = N8NConfig{}
	}

	// 解析 TrueNAS 配置
	if err := v.UnmarshalKey("truenas", &cfg.TrueNAS); err != nil {
		cfg.TrueNAS = TrueNASConfig{}
	}

	// 展开路径中的 ~ 和环境变量
	cfg.Global.SSHKeyPath = expandPath(cfg.Global.SSHKeyPath)
	cfg.Global.BackupDir = expandPath(cfg.Global.BackupDir)

	// SyncRules 中的路径是相对于 hosts/<alias>/ 的，不需要展开
	// 确保配置被正确解析
	_ = cfg.Hosts

	return &cfg, nil
}

// LoadEnvFile 加载指定主机的 .env 文件
// 返回环境变量映射
func LoadEnvFile(baseDir, hostAlias string) (map[string]string, error) {
	envPath := filepath.Join(baseDir, "hosts", hostAlias, ".env")

	data, err := os.ReadFile(envPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read env file: %w", err)
	}

	env := make(map[string]string)
	lines := strings.Split(string(data), "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)

		// 跳过空行和注释
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// 跳过 export 前缀
		line = strings.TrimPrefix(line, "export ")
		line = strings.TrimPrefix(line, "export\t")

		// 解析 KEY=VALUE
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])

		// 去除引号
		value = strings.Trim(value, "\"'")

		if key != "" {
			env[key] = value
		}
	}

	return env, nil
}

// GetEnvVar 从环境变量获取值，支持从主机 .env 文件覆盖
func GetEnvVar(key string, hostAlias string, baseDir string) string {
	// 优先从主机 .env 文件获取
	if hostAlias != "" {
		env, err := LoadEnvFile(baseDir, hostAlias)
		if err == nil && env != nil {
			if value, ok := env[key]; ok {
				return value
			}
		}
	}

	// 回退到系统环境变量
	return os.Getenv(key)
}

// expandPath 展开路径中的 ~ 和环境变量
func expandPath(path string) string {
	if path == "" {
		return path
	}

	// 展开 ~
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err == nil {
			path = home + path[1:]
		}
	}

	// 展开环境变量
	path = os.ExpandEnv(path)

	return path
}

// ResolveSSHKey 解析 SSH 密钥路径
// 如果是相对路径，相对于 baseDir
func (cl *ConfigLoader) ResolveSSHKey(sshKeyPath string) string {
	if sshKeyPath == "" {
		return ""
	}

	// 如果是绝对路径，直接返回
	if filepath.IsAbs(sshKeyPath) {
		return sshKeyPath
	}

	// 相对于 baseDir
	if filepath.IsAbs(cl.baseDir) {
		return filepath.Join(cl.baseDir, sshKeyPath)
	}

	// 获取当前工作目录的绝对路径
	cwd, err := os.Getwd()
	if err == nil {
		return filepath.Join(cwd, cl.baseDir, sshKeyPath)
	}

	return sshKeyPath
}

// LoadConfig 加载配置的便捷函数
// 使用当前工作目录作为 baseDir
func LoadConfig(baseDir string) (*Config, error) {
	loader := NewConfigLoader(baseDir)
	return loader.Load()
}

// LoadConfigFromCWD 从当前工作目录加载配置
func LoadConfigFromCWD() (*Config, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("failed to get cwd: %w", err)
	}
	return LoadConfig(cwd)
}
