package engine

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

type githubRelease struct {
	TagName string `json:"tag_name"`
}

// InstallManager 安装管理器
type InstallManager struct {
	baseDir string
	sshKey  string
}

// NewInstallManager 创建安装管理器
func NewInstallManager(baseDir string) (*InstallManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	sshKey := filepath.Join(baseDir, cfg.Global.SSHKeyPath)
	if !filepath.IsAbs(sshKey) {
		sshKey = filepath.Join(baseDir, sshKey)
	}

	return &InstallManager{
		baseDir: baseDir,
		sshKey:  sshKey,
	}, nil
}

// InstallApp 安装应用
func (m *InstallManager) InstallApp(host, appAlias string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	src := cfg.GetInstallSource(appAlias)
	if src == nil {
		return fmt.Errorf("install source not found: %s", appAlias)
	}

	utils.Step("Installing %s on %s", appAlias, host)

	// 获取架构
	arch, err := m.getRemoteArch(hostCfg.Address)
	if err != nil {
		utils.Warn("Failed to detect arch, using amd64")
		arch = "amd64"
	}

	// 获取版本
	version := src.DefaultVersion
	if version == "latest" {
		version, _ = m.getLatestVersion(src.Repo)
		if version == "" {
			version = "latest"
		}
	}

	// 构建下载 URL
	downloadURL := m.buildDownloadURL(src.Repo, src.Pattern, version, arch)

	// 在远程执行安装
	installScript := m.buildInstallScript(src, downloadURL, version, arch)
	_, err = SSHExecute(hostCfg.Address, m.sshKey, installScript)
	if err != nil {
		return fmt.Errorf("install failed: %w", err)
	}

	utils.Success("Installed %s v%s", appAlias, version)
	return nil
}

// InstallStack 安装整个栈
func (m *InstallManager) InstallStack(host string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host %s not found", host)
	}

	if len(hostCfg.Stack) == 0 {
		return fmt.Errorf("no stack defined for host %s", host)
	}

	utils.Step("Installing stack on %s: %v", host, hostCfg.Stack)

	for _, app := range hostCfg.Stack {
		if err := m.InstallApp(host, app); err != nil {
			utils.Error("Failed to install %s: %v", app, err)
		}
	}

	return nil
}

// getRemoteArch 获取远程架构
func (m *InstallManager) getRemoteArch(address string) (string, error) {
	output, err := SSHExecute(address, m.sshKey, "uname -m")
	if err != nil {
		return "", err
	}

	arch := strings.TrimSpace(output)
	switch arch {
	case "x86_64":
		return "amd64", nil
	case "aarch64", "arm64":
		return "arm64", nil
	default:
		return arch, nil
	}
}

// getLatestVersion 获取最新版本
func (m *InstallManager) getLatestVersion(repo string) (string, error) {
	if strings.HasPrefix(repo, "gitlab:") {
		return "latest", nil
	}

	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)

	cfg, _ := config.LoadConfig(m.baseDir)
	apiTimeout := config.ParseDuration(cfg.Global.Timeouts.HTTPClient, 10*time.Second)

	client := &http.Client{Timeout: apiTimeout}
	resp, err := client.Get(url)
	if err != nil {
		return "latest", nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "latest", nil
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", fmt.Errorf("failed to parse GitHub release: %w", err)
	}
	if release.TagName != "" {
		return release.TagName, nil
	}

	return "latest", nil
}

// buildDownloadURL 构建下载 URL
func (m *InstallManager) buildDownloadURL(repo, pattern, version, arch string) string {
	var baseURL string

	if strings.HasPrefix(repo, "gitlab:") {
		gitlabRepo := strings.TrimPrefix(repo, "gitlab:")
		baseURL = fmt.Sprintf("https://gitlab.com/%s/-/releases/%s/downloads", gitlabRepo, version)
	} else {
		baseURL = fmt.Sprintf("https://github.com/%s/releases/download/%s", repo, version)
	}

	pattern = strings.ReplaceAll(pattern, "{ARCH}", arch)
	pattern = strings.ReplaceAll(pattern, "{VERSION}", version)
	return fmt.Sprintf("%s/%s", baseURL, pattern)
}

// buildInstallScript 构建安装脚本
func (m *InstallManager) buildInstallScript(src *config.InstallSource, downloadURL, version, arch string) string {
	app := src.Alias
	isTarball := strings.HasSuffix(downloadURL, ".tar.gz") || strings.HasSuffix(downloadURL, ".tgz")

	script := fmt.Sprintf(`
set -e
TMPDIR=$(mktemp -d)
cd $TMPDIR

echo "Downloading %s from %s..."
curl -fSL -o %s %s

`, app, downloadURL, app, downloadURL)

	if isTarball {
		script += fmt.Sprintf(`
tar -xzf %s
BIN=$(find . -type f -executable | head -1)
sudo cp $BIN /usr/local/bin/%s
sudo chmod +x /usr/local/bin/%s
`, app, app, app)
	} else {
		script += fmt.Sprintf(`
sudo cp %s /usr/local/bin/%s
sudo chmod +x /usr/local/bin/%s
`, app, app, app)
	}

	if src.ServiceName != "" {
		script += fmt.Sprintf(`
if [ ! -f /etc/systemd/system/%s.service ]; then
cat << 'EOF' | sudo tee /etc/systemd/system/%s.service
[Unit]
Description=%s
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/%s
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
fi
`, src.ServiceName, src.ServiceName, app, app)
	}

	script += `
cd /
rm -rf $TMPDIR
echo "Done"
`

	return script
}
