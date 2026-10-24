package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

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

	// 6. 推送配置 + 生成 compose override
	if err := d.pushConfig(host, hostCfg, deployPath, manifest); err != nil {
		return err
	}

	// 7. Compose build + up
	if err := d.composeBuildAndUp(re, deployPath); err != nil {
		return err
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

	if err := re.EnsureDir(deployPath); err != nil {
		return err
	}

	// 1. 特性：Git 拉取
	if manifest.Features.GitClone != nil {
		targetPath := filepath.Join(deployPath, manifest.Features.GitClone.Path)
		if err := re.GitPull(targetPath); err != nil {
			utils.Warn("Git pull failed: %v", err)
		}
	}

	// 2. 推送配置 + 生成 compose override
	if err := d.pushConfig(host, hostCfg, deployPath, manifest); err != nil {
		return err
	}

	// 3. Compose build + up
	return d.composeBuildAndUp(re, deployPath)
}

// Down 停止服务
func (d *ComposeDriver) Down(host string, hostCfg *config.HostConfig, deployPath string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	files := d.composeFiles(re, deployPath)
	return re.ComposeDown(files[0], files[1:]...)
}

// Status 查看服务状态
func (d *ComposeDriver) Status(host string, hostCfg *config.HostConfig, deployPath string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}
	files := d.composeFiles(re, deployPath)
	out, err := re.ComposePS(files[0], files[1:]...)
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

// Upgrade compose 驱动暂不支持一键升级
func (d *ComposeDriver) Upgrade(host string, hostCfg *config.HostConfig, deployPath string, force bool) error {
	return fmt.Errorf("upgrade action is not supported for compose driver (bundle %s)", d.bundleName)
}

// Service 管理单个服务
func (d *ComposeDriver) Service(host string, hostCfg *config.HostConfig, deployPath string, svc string, action string) error {
	re, err := NewRemoteExecutorWithDefaults(hostCfg.Address, d.sshKey, d.defaults)
	if err != nil {
		return err
	}

	// 通过 git_clone 构建的服务，在单独 up 前先拉取更新
	manifest, _ := d.loadManifest()
	if action == "up" && manifest != nil && manifest.Features.GitClone != nil {
		if manifest.Features.GitClone.Path != "" && svc == manifest.Features.GitClone.Path {
			targetPath := filepath.Join(deployPath, manifest.Features.GitClone.Path)
			re.GitPull(targetPath)
		}
	}

	files := d.composeFiles(re, deployPath)
	return re.ComposeService(files[0], svc, action, files[1:]...)
}

// ==================== 内部方法 ====================

// loadManifest 加载当前 bundle 的 manifest (使用命令行指定的 bundle 名，而非 hostCfg.Bundles[0])
func (d *ComposeDriver) loadManifest() (*BundleManifest, error) {
	loader := NewManifestLoader(d.baseDir)
	return loader.Load(d.bundleName)
}

func (d *ComposeDriver) composeFile(deployPath string) string {
	return filepath.Join(deployPath, "docker-compose.yaml")
}

func (d *ComposeDriver) overrideFile(deployPath string) string {
	return filepath.Join(deployPath, "docker-compose.spool.yaml")
}

func (d *ComposeDriver) composeBuildAndUp(re *RemoteExecutor, deployPath string) error {
	files := d.composeFiles(re, deployPath)
	if err := re.ComposeBuildFiles(files); err != nil {
		return fmt.Errorf("compose build failed: %w", err)
	}
	if err := re.ComposeUp(files[0], files[1:]...); err != nil {
		return fmt.Errorf("compose up failed: %w", err)
	}
	return nil
}

// composeFiles 返回实际存在的 compose 文件；兼容尚未生成 override 的旧部署。
func (d *ComposeDriver) composeFiles(re *RemoteExecutor, deployPath string) []string {
	files := []string{d.composeFile(deployPath)}
	override := d.overrideFile(deployPath)
	if out, err := re.Exec(fmt.Sprintf("test -f %q && echo yes || true", override)); err == nil && strings.Contains(out, "yes") {
		files = append(files, override)
	}
	return files
}

// pushConfig 推送主机配置、bundle 配置与模板，并生成 override。
// 文件即真相：模板保持原样，spool 注入项只写 docker-compose.spool.yaml。
func (d *ComposeDriver) pushConfig(host string, hostCfg *config.HostConfig, deployPath string, manifest *BundleManifest) error {
	syncMgr, err := NewSyncManager(d.baseDir)
	if err != nil {
		return err
	}
	if err := syncMgr.SyncHost(host, "push"); err != nil {
		return fmt.Errorf("push host config failed: %w", err)
	}
	if err := syncMgr.SyncBundle(host, d.bundleName, deployPath); err != nil {
		return fmt.Errorf("push bundle config failed: %w", err)
	}

	if len(manifest.Templates) == 0 {
		return nil
	}

	client, err := globalPool.Get(hostCfg.Address, d.sshKey)
	if err != nil {
		return fmt.Errorf("SSH connect failed: %w", err)
	}
	bundleRoot := filepath.Join(d.baseDir, "bundles", d.bundleName)
	templateData := make([][]byte, 0, len(manifest.Templates))
	for _, t := range manifest.Templates {
		data, err := os.ReadFile(templateFilePath(bundleRoot, t))
		if err != nil {
			return fmt.Errorf("read template %s failed: %w", t, err)
		}
		templateData = append(templateData, data)
		// 模板与 compose 入口位于同一目录，保证 include 的每个应用模型
		// 都以 deployPath 为 project directory（相对挂载/构建路径不变）。
		remotePath := filepath.Join(deployPath, filepath.Base(t))
		if err := client.Upload(string(data), remotePath); err != nil {
			return fmt.Errorf("upload template %s failed: %w", t, err)
		}
	}

	base, err := renderComposeBase(manifest.Templates, templateData)
	if err != nil {
		return fmt.Errorf("render docker-compose.yaml failed: %w", err)
	}
	if err := client.Upload(string(base), d.composeFile(deployPath)); err != nil {
		return fmt.Errorf("upload docker-compose.yaml failed: %w", err)
	}

	override, err := renderSpoolOverride(templateData, host, d.bundleName, manifest.Version)
	if err != nil {
		return fmt.Errorf("render docker-compose.spool.yaml failed: %w", err)
	}
	if err := client.Upload(string(override), d.overrideFile(deployPath)); err != nil {
		return fmt.Errorf("upload docker-compose.spool.yaml failed: %w", err)
	}

	return nil
}

// renderComposeBase 生成人类可读的入口文件：
//   - 单模板：原样复制
//   - 多模板：使用 Compose include，多文件语义交给 docker compose 自己处理
func renderComposeBase(names []string, data [][]byte) ([]byte, error) {
	if len(data) == 1 {
		return data[0], nil
	}

	type includeFile struct {
		Name    string   `yaml:"name,omitempty"`
		Include []string `yaml:"include"`
	}
	includes := make([]string, 0, len(names))
	for _, name := range names {
		includes = append(includes, filepath.ToSlash(filepath.Base(name)))
	}

	// include 会忽略被包含文件里的顶层 name；从模板中提取并写到入口文件，
	// 避免项目名漂移导致旧容器被当成孤儿。
	var projectName string
	for _, item := range data {
		var doc struct {
			Name string `yaml:"name"`
		}
		if err := yaml.Unmarshal(item, &doc); err == nil && doc.Name != "" {
			projectName = doc.Name
			break
		}
	}
	return yaml.Marshal(includeFile{Name: projectName, Include: includes})
}
