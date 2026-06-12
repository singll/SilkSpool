package engine

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// InitManager 处理主机初始化
type InitManager struct {
	baseDir  string
	sshKey  string
	sshPub  string
	reader  *bufio.Reader
}

// NewInitManager 创建初始化管理器
func NewInitManager(baseDir string) (*InitManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	// 解析 SSH 密钥路径
	sshKey := resolveSSHKeyPath(cfg.Global.SSHKeyPath, baseDir)
	sshPub := sshKey + ".pub"

	return &InitManager{
		baseDir: baseDir,
		sshKey: sshKey,
		sshPub: sshPub,
		reader: bufio.NewReader(os.Stdin),
	}, nil
}

// resolveSSHKeyPath 解析 SSH 密钥路径
func resolveSSHKeyPath(sshKeyPath, baseDir string) string {
	if sshKeyPath == "" {
		// 默认值
		sshKeyPath = "~/.ssh/id_rsa"
	}

	// 展开 ~
	if strings.HasPrefix(sshKeyPath, "~") {
		home, err := os.UserHomeDir()
		if err == nil {
			sshKeyPath = home + sshKeyPath[1:]
		}
	}

	// 展开环境变量
	sshKeyPath = os.ExpandEnv(sshKeyPath)

	// 如果是相对路径，基于配置文件目录
	if !filepath.IsAbs(sshKeyPath) {
		// 尝试 baseDir
		if baseDir != "" {
			sshKeyPath = filepath.Join(baseDir, sshKeyPath)
		}
		// 否则基于当前目录
		if !filepath.IsAbs(sshKeyPath) {
			if cwd, err := os.Getwd(); err == nil {
				sshKeyPath = filepath.Join(cwd, sshKeyPath)
			}
		}
	}

	return sshKeyPath
}

// Run 执行交互式初始化
func (m *InitManager) Run(host string) error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host not found: %s", host)
	}

	utils.Step("Initializing host: %s", host)
	utils.Info("Address: %s", hostCfg.Address)

	// 1. 确保本地 SSH 密钥存在
	if err := m.ensureSSHKey(); err != nil {
		return err
	}

	// 2. 读取公钥
	pubKey, err := os.ReadFile(m.sshPub)
	if err != nil {
		return fmt.Errorf("failed to read public key: %w", err)
	}

	// 3. 解析远程地址
	addr := hostCfg.Address
	targetUser := strings.Split(addr, "@")[0]

	utils.Info("")
	utils.Info("Target user: %s", targetUser)
	utils.Info("Public key will be deployed to: ~%s/.ssh/authorized_keys", targetUser)

	// 4. 询问管理员账号
	utils.Info("")
	utils.Warn("Cannot connect directly to %s@%s", targetUser, extractHost(addr))
	utils.Info("Please provide an admin account with sudo privileges to setup the user.")

	fmt.Print("Admin username (default: root): ")
	adminUser, _ := m.reader.ReadString('\n')
	adminUser = strings.TrimSpace(adminUser)
	if adminUser == "" {
		adminUser = "root"
	}

	// 5. 构建初始化脚本
	script := m.buildInitScript(targetUser, string(pubKey))

	// 6. 执行远程初始化
	utils.Info("")
	utils.Info("Executing initialization script on %s@%s...", adminUser, extractHost(addr))

	sshPort := hostCfg.SSHPort
	if sshPort == "" {
		sshPort = "22"
	}
	knownHosts := filepath.Join(m.baseDir, "known_hosts")

	cmd := exec.Command("ssh",
		"-t",
		"-p", sshPort,
		"-o", fmt.Sprintf("UserKnownHostsFile=%s", knownHosts),
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "PubkeyAuthentication=no",
		fmt.Sprintf("%s@%s", adminUser, extractHost(addr)),
		script,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("SSH initialization failed: %w", err)
	}

	// 7. 验证连接
	utils.Info("")
	utils.Info("Verifying connection...")

	testCmd := exec.Command("ssh",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=5",
		"-p", sshPort,
		"-o", fmt.Sprintf("UserKnownHostsFile=%s", knownHosts),
		"-o", "StrictHostKeyChecking=accept-new",
		addr,
		"echo 'Connection OK'",
	)
	var out bytes.Buffer
	testCmd.Stdout = &out

	if err := testCmd.Run(); err != nil {
		utils.Warn("Connection test failed: %v", err)
		utils.Warn("You may need to add the host key manually or check SSH configuration")
	} else {
		utils.Success("Connection verified: %s", strings.TrimSpace(out.String()))
	}

	utils.Success("Host %s initialized successfully!", host)
	utils.Info("")
	utils.Info("You can now use spool commands:")
	utils.Info("  ./spool sync push %s", host)
	utils.Info("  ./spool bundle keeper up %s", host)

	return nil
}

// ensureSSHKey 确保 SSH 密钥存在
func (m *InitManager) ensureSSHKey() error {
	// 检查密钥是否存在
	if _, err := os.Stat(m.sshKey); err == nil {
		utils.Info("SSH key found: %s", m.sshKey)
		return nil
	}

	// 创建密钥目录
	keyDir := filepath.Dir(m.sshKey)
	if err := os.MkdirAll(keyDir, 0700); err != nil {
		return fmt.Errorf("failed to create key directory: %w", err)
	}

	// 生成密钥
	utils.Warn("SSH key not found, generating...")
	cmd := exec.Command("ssh-keygen",
		"-t", "ed25519",
		"-f", m.sshKey,
		"-N", "",
		"-C", "silkspool-admin",
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to generate SSH key: %w", err)
	}

	// 设置权限
	if err := os.Chmod(m.sshKey, 0600); err != nil {
		return fmt.Errorf("failed to set key permissions: %w", err)
	}

	utils.Success("SSH key generated: %s", m.sshKey)
	return nil
}

// buildInitScript 构建远程初始化脚本
func (m *InitManager) buildInitScript(targetUser, pubKey string) string {
	script := fmt.Sprintf(`set -e

# 获取 SUDO 前缀
SUDO=''
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO='sudo'
fi

TARGET_USER='%s'

echo '[*] Creating user if not exists...'
if ! id "$TARGET_USER" >/dev/null 2>&1; then
    if command -v useradd >/dev/null; then
        $SUDO useradd -m -s /bin/bash "$TARGET_USER"
        echo '$TARGET_USER:$TARGET_USER' | $SUDO chpasswd || true
        echo '$TARGET_USER ALL=(ALL) NOPASSWD: ALL' | $SUDO tee /etc/sudoers.d/"$TARGET_USER" >/dev/null
        $SUDO chmod 440 /etc/sudoers.d/"$TARGET_USER"
        echo '[OK] User created'
    else
        echo '[WARN] useradd not found, skipping user creation'
    fi
else
    echo '[OK] User already exists'
fi

echo '[*] Configuring Docker permissions...'
if command -v docker >/dev/null 2>&1; then
    if getent group docker >/dev/null 2>&1; then
        $SUDO usermod -aG docker "$TARGET_USER" || true
        echo '[OK] Docker group membership added'
    fi
fi

echo '[*] Deploying SSH public key...'
TARGET_HOME=$(eval echo ~"$TARGET_USER" 2>/dev/null || echo "/home/$TARGET_USER")
[ -z "$TARGET_HOME" ] && TARGET_HOME="/home/$TARGET_USER"
[ "$TARGET_USER" = "root" ] && TARGET_HOME="/root"

$SUDO mkdir -p "$TARGET_HOME/.ssh"
echo '%s' | $SUDO tee -a "$TARGET_HOME/.ssh/authorized_keys" >/dev/null
$SUDO chmod 600 "$TARGET_HOME/.ssh/authorized_keys"
$SUDO chown -R "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/.ssh"

echo '[OK] SSH key deployed'
echo '[OK] Initialization complete!'
`, targetUser, strings.TrimSpace(pubKey))

	return script
}
// extractHost 从 user@host 格式提取 host
func extractHost(address string) string {
	if idx := strings.LastIndex(address, "@"); idx != -1 {
		return address[idx+1:]
	}
	return address
}

// RunAll 初始化所有配置的主机
func (m *InitManager) RunAll() error {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}
	for host := range cfg.Hosts {
		if err := m.Run(host); err != nil {
			utils.Warn("Init %s failed: %v", host, err)
		}
	}
	return nil
}
