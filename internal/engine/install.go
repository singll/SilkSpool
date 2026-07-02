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

// InstallOptions 控制单次安装行为
type InstallOptions struct {
	Force  bool // 跳过幂等检查，强制重装
	DryRun bool // 只解析版本/URL/格式并打印，不执行安装（仍会探测远程架构）
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

// InstallApp 安装单个应用（默认选项）
func (m *InstallManager) InstallApp(host, appAlias string) error {
	return m.InstallAppWithOptions(host, appAlias, InstallOptions{})
}

// InstallAppWithOptions 安装单个应用
func (m *InstallManager) InstallAppWithOptions(host, appAlias string, opts InstallOptions) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("主机 %s 不存在", host)
	}

	src := cfg.GetInstallSource(appAlias)
	if src == nil {
		return fmt.Errorf("安装源不存在: %s", appAlias)
	}

	// 配置自洽性校验：url⊕repo、直链/GitLab 必须显式 pin 版本
	if err := src.Validate(); err != nil {
		return err
	}

	utils.Step("安装 %s 到 %s", appAlias, host)

	// 获取架构（只读操作）
	arch, err := m.getRemoteArch(hostCfg.Address)
	if err != nil {
		utils.Warn("架构探测失败，回退 amd64")
		arch = "amd64"
	}

	// 解析版本：GitHub 源的 latest 走 API 解析成具体 tag；直链/GitLab 已在 Validate 保证是具体版本
	version := src.DefaultVersion
	if version == "latest" && !src.IsDirectURL() && !src.IsGitLab() {
		version, _ = m.getLatestVersion(src.Repo)
		if version == "" {
			version = "latest"
		}
	}

	// 构建下载 URL 与格式判定
	downloadURL := m.buildDownloadURL(src, version, arch)
	format := detectFormat(urlFilename(downloadURL), src.Format)

	// binary_path 对单文件压缩/raw 无意义（解出即二进制），误配时 warn 忽略
	if strings.TrimSpace(src.BinaryPath) != "" && !format.isArchive() {
		utils.Warn("binary_path 对 %s 格式无意义（单文件解压即二进制），已忽略", format)
	}

	// 解析当前架构的 sha256：map 非空但缺当前 arch → 报错（想校验却漏配，不能静默放行）
	expectedSHA := ""
	if len(src.SHA256) > 0 {
		sum, ok := src.SHA256[arch]
		if !ok {
			return fmt.Errorf("安装源 %s 配置了 sha256 但缺少架构 %s 的校验和，请补全或清空 sha256", appAlias, arch)
		}
		expectedSHA = strings.TrimSpace(sum)
	}

	if opts.DryRun {
		utils.Info("[dry-run] %s: 版本=%s 架构=%s 格式=%s", appAlias, version, arch, format)
		utils.Info("[dry-run] 下载 URL: %s", downloadURL)
		if tool := format.requiredTool(); tool != "" {
			utils.Info("[dry-run] 需要远程命令: %s", tool)
		}
		if expectedSHA != "" {
			utils.Info("[dry-run] 将校验 sha256: %s", expectedSHA)
		}
		if src.ServiceName != "" {
			utils.Info("[dry-run] 将生成/保留 systemd 服务: %s", src.ServiceName)
		}
		return nil
	}

	// 幂等检查：版本标记一致且二进制存在则跳过
	if !opts.Force && m.alreadyInstalled(hostCfg.Address, appAlias, version) {
		utils.Success("%s 已是 %s，跳过（--force 可强制重装）", appAlias, version)
		return nil
	}

	// 在远程执行安装
	installScript := m.buildInstallScript(src, downloadURL, version, arch, expectedSHA)
	if _, err = SSHExecute(hostCfg.Address, m.sshKey, installScript); err != nil {
		return fmt.Errorf("安装失败: %w", err)
	}

	utils.Success("已安装 %s %s", appAlias, version)
	return nil
}

// InstallStack 安装整个栈（默认选项）
func (m *InstallManager) InstallStack(host string) error {
	return m.InstallStackWithOptions(host, InstallOptions{})
}

// InstallStackWithOptions 安装整个栈，结尾聚合成功/失败清单
func (m *InstallManager) InstallStackWithOptions(host string, opts InstallOptions) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("主机 %s 不存在", host)
	}

	if len(hostCfg.Stack) == 0 {
		return fmt.Errorf("主机 %s 未定义 stack", host)
	}

	utils.Step("在 %s 安装栈: %v", host, hostCfg.Stack)

	var failed []string
	ok := 0
	for _, app := range hostCfg.Stack {
		if err := m.InstallAppWithOptions(host, app, opts); err != nil {
			utils.Error("安装 %s 失败: %v", app, err)
			failed = append(failed, app)
		} else {
			ok++
		}
	}

	utils.Step("栈安装完成: 成功 %d，失败 %d", ok, len(failed))
	if len(failed) > 0 {
		return fmt.Errorf("以下服务安装失败: %s", strings.Join(failed, ", "))
	}
	return nil
}

// alreadyInstalled 远程检查版本标记是否匹配且二进制存在
func (m *InstallManager) alreadyInstalled(address, app, version string) bool {
	check := fmt.Sprintf(
		`test -x /usr/local/bin/%s && [ "$(cat /usr/local/bin/.spool-%s.version 2>/dev/null)" = "%s" ]`,
		app, app, version,
	)
	_, err := SSHExecute(address, m.sshKey, check)
	return err == nil
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

// buildDownloadURL 构建下载 URL。
// 直链源 (url 非空)：直接用 url，仅替换 {ARCH}/{VERSION} 占位，不碰 GitHub/GitLab release 路径。
// repo 源：按 GitHub / GitLab release 下载路径拼装 + pattern。
func (m *InstallManager) buildDownloadURL(src *config.InstallSource, version, arch string) string {
	if src.IsDirectURL() {
		u := strings.ReplaceAll(src.URL, "{ARCH}", arch)
		u = strings.ReplaceAll(u, "{VERSION}", version)
		return u
	}

	var baseURL string
	if src.IsGitLab() {
		gitlabRepo := strings.TrimPrefix(src.Repo, "gitlab:")
		baseURL = fmt.Sprintf("https://gitlab.com/%s/-/releases/%s/downloads", gitlabRepo, version)
	} else {
		baseURL = fmt.Sprintf("https://github.com/%s/releases/download/%s", src.Repo, version)
	}

	pattern := strings.ReplaceAll(src.Pattern, "{ARCH}", arch)
	pattern = strings.ReplaceAll(pattern, "{VERSION}", version)
	return fmt.Sprintf("%s/%s", baseURL, pattern)
}

// urlFilename 取 URL 的 basename，用于格式探测
func urlFilename(u string) string {
	if i := strings.LastIndex(u, "/"); i >= 0 {
		return u[i+1:]
	}
	return u
}

// buildInstallScript 构建安装脚本：下载 → 依赖预检 → 校验和 → 按格式解压 → 定位二进制 → 安装 → 写版本标记 → systemd
// expectedSHA 非空时在解压前做 sha256 比对，不符则中止。
func (m *InstallManager) buildInstallScript(src *config.InstallSource, downloadURL, version, arch, expectedSHA string) string {
	app := src.Alias
	format := detectFormat(urlFilename(downloadURL), src.Format)

	var b strings.Builder

	// 依赖预检（下载前）：curl 恒检；解压工具按格式检；sha256sum 仅在配了校验和时检。
	// 缺工具时明确中文报错退出，绝不擅自动目标机的包。
	b.WriteString(`command -v curl >/dev/null 2>&1 || { echo "错误: 目标机缺少 curl，无法下载，请先安装（apt install curl 或对应包管理器）"; exit 1; }
`)
	if tool := format.requiredTool(); tool != "" {
		fmt.Fprintf(&b, `command -v %s >/dev/null 2>&1 || { echo "错误: 目标机缺少 %s，无法解压 %s 格式，请先安装（apt install %s 或对应包管理器）"; exit 1; }
`, tool, tool, format, format.installHint())
	}
	if expectedSHA != "" {
		b.WriteString(`command -v sha256sum >/dev/null 2>&1 || { echo "错误: 目标机缺少 sha256sum，无法校验完整性，请先安装（apt install coreutils 或对应包管理器）"; exit 1; }
`)
	}

	fmt.Fprintf(&b, `set -e
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
echo "下载 %s (格式 %s): %s"
curl -fSL -o payload "%s"
`, app, format, downloadURL, downloadURL)

	// 完整性校验（解压前）：sha256 不符则中止 + 清临时目录 + 非零退出
	if expectedSHA != "" {
		fmt.Fprintf(&b, `echo "校验 sha256 (%s)"
ACTUAL=$(sha256sum payload | cut -d' ' -f1)
if [ "$ACTUAL" != "%s" ]; then echo "错误: sha256 校验失败，期望 %s，实际 $ACTUAL；已中止安装"; cd /; rm -rf "$TMPDIR"; exit 1; fi
`, arch, expectedSHA, expectedSHA)
	}

	// 解压 + 定位二进制 → 统一产出 $BIN
	b.WriteString(m.extractSnippet(format, app, src.BinaryPath))

	// 安装到 /usr/local/bin 并写版本标记（幂等比对依据）
	fmt.Fprintf(&b, `sudo install -m 0755 "$BIN" /usr/local/bin/%s
echo "%s" | sudo tee /usr/local/bin/.spool-%s.version >/dev/null
`, app, version, app)

	// systemd 服务（档2/方案C）：已存在 unit（含 bundle 模板推送）则不覆盖；
	// 否则用 exec_args 拼最小 unit，让需要参数的服务（如 tuwunel --config）能起来。
	// 注意：本工具只写 unit 文件，不 enable/start —— 安装与启动严格分离（启动归 restart / bundle up）。
	if src.ServiceName != "" {
		execLine := "/usr/local/bin/" + app
		hasArgs := strings.TrimSpace(src.ExecArgs) != ""
		if hasArgs {
			execLine += " " + strings.TrimSpace(src.ExecArgs)
		}
		fmt.Fprintf(&b, `if [ ! -f /etc/systemd/system/%s.service ]; then
cat << 'EOF' | sudo tee /etc/systemd/system/%s.service
[Unit]
Description=%s
After=network.target

[Service]
Type=simple
ExecStart=%s
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
`, src.ServiceName, src.ServiceName, app, execLine)
		// exec_args 非空但 unit 已存在：不覆盖，但打 warn 而非静默（避免"改了参数不生效"的困惑）
		if hasArgs {
			fmt.Fprintf(&b, `else
echo "警告: unit %s.service 已存在，exec_args 未写入；如需更新请删除该 unit 后重装，或改用 bundle 模板管理"
fi
`, src.ServiceName)
		} else {
			b.WriteString("fi\n")
		}
	}

	b.WriteString(`cd /
rm -rf "$TMPDIR"
echo "完成"
`)

	return b.String()
}

// extractSnippet 生成"解压 + 定位二进制"的 shell 片段，统一以 $BIN 指向最终可执行文件。
// 压缩 tar 一律用 "解压器 -dc | tar -xf -" 管道写法，不依赖 tar 的 --zstd/-J 标志（老版本 tar 不认）。
func (m *InstallManager) extractSnippet(format ArtifactFormat, app, binaryPath string) string {
	if format.isArchive() {
		var s strings.Builder
		s.WriteString("mkdir -p extract\n")
		switch format {
		case FormatTarGz:
			s.WriteString("gzip -dc payload | tar -xf - -C extract\n")
		case FormatTarXz:
			s.WriteString("xz -dc payload | tar -xf - -C extract\n")
		case FormatTarZst:
			s.WriteString("zstd -dc payload | tar -xf - -C extract\n")
		case FormatZip:
			s.WriteString("unzip -oq payload -d extract\n")
		}
		// 定位二进制：binary_path 显式优先 → 按 alias 名 → 最大 ELF；彻底弃用 -executable
		if strings.TrimSpace(binaryPath) != "" {
			fmt.Fprintf(&s, "BIN=\"extract/%s\"\n", strings.TrimSpace(binaryPath))
		} else {
			fmt.Fprintf(&s, `BIN=$(find extract -type f -name '%s' | head -1)
if [ -z "$BIN" ]; then
  if command -v file >/dev/null 2>&1; then
    BIN=$(find extract -type f | while IFS= read -r f; do
      if file "$f" 2>/dev/null | grep -qi ELF; then
        printf '%%s %%s\n' "$(stat -c '%%s' "$f" 2>/dev/null || echo 0)" "$f"
      fi
    done | sort -rn | head -1 | cut -d' ' -f2-)
  fi
fi
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then echo "错误: 解压后未能在包内定位 %s 的可执行文件，请在 install_sources 显式配置 binary_path"; exit 1; fi
`, app, app)
		}
		return s.String()
	}

	// 单文件压缩 / 裸 ELF：解出来直接就是二进制
	switch format {
	case FormatZst:
		return fmt.Sprintf("zstd -dc payload > %s.bin\nBIN=\"%s.bin\"\n", app, app)
	case FormatGz:
		return fmt.Sprintf("gzip -dc payload > %s.bin\nBIN=\"%s.bin\"\n", app, app)
	default: // FormatRaw
		return "BIN=payload\n"
	}
}
