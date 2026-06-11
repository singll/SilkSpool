package engine

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
	"gopkg.in/yaml.v3"
)

// ComposeDriver Docker Compose 驱动
type ComposeDriver struct {
	baseDir    string
	sshKey     string
	bundleName string
	defaults   config.DefaultsConfig
}

func NewComposeDriver(baseDir, sshKey, bundleName string) *ComposeDriver {
	return &ComposeDriver{
		baseDir:    baseDir,
		sshKey:     sshKey,
		bundleName: bundleName,
	}
}

func NewComposeDriverWithDefaults(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) *ComposeDriver {
	return &ComposeDriver{
		baseDir:    baseDir,
		sshKey:     sshKey,
		bundleName: bundleName,
		defaults:   defaults,
	}
}

// Setup 初始化并启动服务
func (d *ComposeDriver) Setup(host string, hostCfg *config.HostConfig, deployPath string) error {
	manifest, err := d.loadManifest()
	if err != nil {
		return err
	}

	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}

	// 1. 确保远程目录存在
	if err := re.EnsureDir(deployPath); err != nil {
		return err
	}

	// 2. 确保 Docker 环境
	if err := re.EnsureDocker(); err != nil {
		return err
	}
	if err := re.EnsureCompose(); err != nil {
		return err
	}

	// 3. 特性：Docker 日志轮转
	if manifest.Features.DockerLogRotation {
		if err := re.ConfigureDockerLogRotation(); err != nil {
			utils.Warn("Docker log rotation failed: %v", err)
		}
	}

	// 4. 特性：创建网络
	if manifest.Features.CreateNetwork != "" {
		if err := re.CreateDockerNetwork(manifest.Features.CreateNetwork); err != nil {
			utils.Warn("Network creation failed: %v", err)
		}
	}

	// 5. 特性：Git 克隆
	if manifest.Features.GitClone != nil {
		targetPath := filepath.Join(deployPath, manifest.Features.GitClone.Path)
		if err := re.GitClone(manifest.Features.GitClone.Repo, targetPath); err != nil {
			utils.Warn("Git clone failed: %v", err)
		}
	}

	// 6. 推送配置 + 合并 YAML
	if err := d.pushAndMerge(host, hostCfg, deployPath, manifest); err != nil {
		return err
	}

	// 7. Compose build + up
	composeFile := filepath.Join(deployPath, "docker-compose.yaml")
	if err := re.ComposeBuild(composeFile); err != nil {
		return fmt.Errorf("compose build failed: %w", err)
	}
	if err := re.ComposeUp(composeFile); err != nil {
		return fmt.Errorf("compose up failed: %w", err)
	}

	// 8. 特性：Docker 清理
	if manifest.Features.DockerPrune {
		if err := re.CleanupDocker("normal"); err != nil {
			utils.Warn("Docker cleanup failed: %v", err)
		}
	}

	return nil
}

// Up 更新并启动服务
func (d *ComposeDriver) Up(host string, hostCfg *config.HostConfig, deployPath string) error {
	manifest, err := d.loadManifest()
	if err != nil {
		return err
	}

	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}

	// 1. 特性：Git 拉取
	if manifest.Features.GitClone != nil {
		targetPath := filepath.Join(deployPath, manifest.Features.GitClone.Path)
		if err := re.GitPull(targetPath); err != nil {
			utils.Warn("Git pull failed: %v", err)
		}
	}

	// 2. 推送配置 + 合并 YAML
	if err := d.pushAndMerge(host, hostCfg, deployPath, manifest); err != nil {
		return err
	}

	// 3. Compose build + up
	composeFile := filepath.Join(deployPath, "docker-compose.yaml")
	if err := re.ComposeBuild(composeFile); err != nil {
		return fmt.Errorf("compose build failed: %w", err)
	}
	if err := re.ComposeUp(composeFile); err != nil {
		return fmt.Errorf("compose up failed: %w", err)
	}

	return nil
}

// Down 停止服务
func (d *ComposeDriver) Down(host string, hostCfg *config.HostConfig, deployPath string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	composeFile := filepath.Join(deployPath, "docker-compose.yaml")
	return re.ComposeDown(composeFile)
}

// Status 查看服务状态
func (d *ComposeDriver) Status(host string, hostCfg *config.HostConfig, deployPath string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	composeFile := filepath.Join(deployPath, "docker-compose.yaml")
	out, err := re.ComposePS(composeFile)
	if err != nil {
		return err
	}
	fmt.Print(out)
	return nil
}

// Cleanup 清理 Docker 资源
func (d *ComposeDriver) Cleanup(host string, hostCfg *config.HostConfig, deployPath string, mode string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	return re.CleanupDocker(mode)
}

// Service 管理单个服务
func (d *ComposeDriver) Service(host string, hostCfg *config.HostConfig, deployPath string, svc string, action string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	composeFile := filepath.Join(deployPath, "docker-compose.yaml")

	// 对于 build 操作，如果是 bellkeeper 先拉取更新
	manifest, _ := d.loadManifest()
	if action == "up" && manifest != nil && manifest.Features.GitClone != nil {
		if manifest.Features.GitClone.Path != "" && (svc == "bellkeeper" || svc == manifest.Features.GitClone.Path) {
			targetPath := filepath.Join(deployPath, manifest.Features.GitClone.Path)
			re.GitPull(targetPath)
		}
	}

	return re.ComposeService(composeFile, svc, action)
}

// ==================== 内部方法 ====================

// loadManifest 加载当前 bundle 的 manifest (使用命令行指定的 bundle 名，而非 hostCfg.Bundles[0])
func (d *ComposeDriver) loadManifest() (*BundleManifest, error) {
	loader := NewManifestLoader(d.baseDir)
	return loader.Load(d.bundleName)
}

// pushAndMerge 推送配置并合并 YAML 模板
func (d *ComposeDriver) pushAndMerge(host string, hostCfg *config.HostConfig, deployPath string, manifest *BundleManifest) error {
	syncMgr, err := NewSyncManager(d.baseDir)
	if err != nil {
		return err
	}
	if err := syncMgr.SyncHost(host, "push"); err != nil {
		return fmt.Errorf("push config failed: %w", err)
	}

	if len(manifest.Templates) > 0 {
		bundleRoot := filepath.Join(d.baseDir, "bundles", d.bundleName)
		templateFiles := make([]string, 0, len(manifest.Templates))
		for _, t := range manifest.Templates {
			templateFiles = append(templateFiles, filepath.Join(bundleRoot, "templates", t))
		}

		merged, err := d.mergeYAMLFiles(templateFiles)
		if err != nil {
			return fmt.Errorf("YAML merge failed: %w", err)
		}

		remotePath := filepath.Join(deployPath, "docker-compose.yaml")
		client, err := globalPool.Get(hostCfg.Address, d.sshKey)
		if err != nil {
			return fmt.Errorf("SSH connect failed: %w", err)
		}
		if err := client.Upload(string(merged), remotePath); err != nil {
			return fmt.Errorf("upload docker-compose.yaml failed: %w", err)
		}
	}

	return nil
}

// mergeYAMLFiles 合并多个 YAML 文件
func (d *ComposeDriver) mergeYAMLFiles(files []string) ([]byte, error) {
	var result map[string]interface{}

	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("failed to read %s: %w", file, err)
		}

		var doc map[string]interface{}
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("failed to parse %s: %w", file, err)
		}

		result = deepMerge(result, doc)
	}

	return yaml.Marshal(result)
}

// deepMerge 深度合并两个 map
func deepMerge(base, overlay map[string]interface{}) map[string]interface{} {
	if base == nil {
		return overlay
	}
	if overlay == nil {
		return base
	}

	result := make(map[string]interface{})
	for k, v := range base {
		result[k] = v
	}
	for k, v := range overlay {
		if existing, ok := result[k]; ok {
			if baseMap, ok1 := existing.(map[string]interface{}); ok1 {
				if overlayMap, ok2 := v.(map[string]interface{}); ok2 {
					result[k] = deepMerge(baseMap, overlayMap)
					continue
				}
			}
		}
		result[k] = v
	}
	return result
}
