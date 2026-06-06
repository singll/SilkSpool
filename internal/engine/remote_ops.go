package engine

import (
	"fmt"
	"strings"

	"github.com/singll/silkspool/pkg/utils"
)

// RemoteExecutor 封装远程主机上的常用操作
// 所有方法通过 SSH 在远程主机执行命令序列
type RemoteExecutor struct {
	address string
	sshKey  string
}

// NewRemoteExecutor 创建远程执行器
func NewRemoteExecutor(address, sshKey string) *RemoteExecutor {
	return &RemoteExecutor{
		address: address,
		sshKey:  sshKey,
	}
}

// ==================== Docker 环境 ====================

// EnsureDocker 确保远程主机已安装 Docker
func (re *RemoteExecutor) EnsureDocker() error {
	utils.Info("Checking Docker on remote...")
	cmd := "command -v docker || (curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER)"
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	if err != nil {
		return fmt.Errorf("docker installation failed: %w", err)
	}
	return nil
}

// EnsureCompose 确保远程主机有 docker compose
func (re *RemoteExecutor) EnsureCompose() error {
	utils.Info("Checking docker compose on remote...")
	// 优先检测 docker compose v2，否则回退到 docker-compose v1
	cmd := `docker compose version >/dev/null 2>&1 && echo "docker compose" || (docker-compose version >/dev/null 2>&1 && echo "docker-compose")`
	out, err := SSHExecute(re.address, re.sshKey, cmd)
	if err != nil || strings.TrimSpace(out) == "" {
		// 尝试安装 docker-compose v2
		installCmd := `ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH="x86_64" ;; aarch64) ARCH="aarch64" ;; armv7l) ARCH="armv7" ;; esac; VER=$(curl -sL https://api.github.com/repos/docker/compose/releases/latest | grep '"tag_name":' | cut -d'"' -f4); [ -z "$VER" ] && VER="v2.24.5"; sudo curl -L "https://github.com/docker/compose/releases/download/${VER}/docker-compose-linux-${ARCH}" -o /usr/bin/docker-compose && sudo chmod +x /usr/bin/docker-compose`
		_, err = SSHExecute(re.address, re.sshKey, installCmd)
		if err != nil {
			return fmt.Errorf("docker compose installation failed: %w", err)
		}
	}
	return nil
}

// GetComposeCmd 获取远程主机的 docker compose 命令
func (re *RemoteExecutor) GetComposeCmd() string {
	cmd := `docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose"`
	out, _ := SSHExecute(re.address, re.sshKey, cmd)
	return strings.TrimSpace(out)
}

// ConfigureDockerLogRotation 配置 Docker 日志轮转
func (re *RemoteExecutor) ConfigureDockerLogRotation() error {
	utils.Info("Configuring Docker log rotation...")
	cmd := `if [ -f /etc/docker/daemon.json ] && grep -q "max-size" /etc/docker/daemon.json 2>/dev/null; then echo "OK"; else echo '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"3"}}' | sudo tee /etc/docker/daemon.json >/dev/null && sudo systemctl restart docker || true; fi`
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// CreateDockerNetwork 创建 Docker 网络（如果不存在）
func (re *RemoteExecutor) CreateDockerNetwork(name string) error {
	if name == "" {
		return nil
	}
	utils.Info("Creating Docker network: %s", name)
	cmd := fmt.Sprintf("docker network ls | grep -q %q || docker network create %q", name, name)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// CleanupDocker 清理 Docker 资源
func (re *RemoteExecutor) CleanupDocker(mode string) error {
	utils.Info("Cleaning Docker resources (mode: %s)...", mode)
	cmd := "docker image prune -f >/dev/null 2>&1 || true"
	if mode == "aggressive" {
		cmd += "; docker builder prune -af >/dev/null 2>&1 || true"
	} else {
		cmd += "; docker builder prune -f --filter \"until=168h\" >/dev/null 2>&1 || true"
	}
	cmd += "; docker network prune -f >/dev/null 2>&1 || true"
	cmd += "; docker container prune -f >/dev/null 2>&1 || true"
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ==================== Docker Compose 操作 ====================

// ComposePull docker compose pull
func (re *RemoteExecutor) ComposePull(composeFile string) error {
	utils.Info("Pulling images...")
	dc := re.GetComposeCmd()
	cmd := fmt.Sprintf("cd $(dirname %s) && %s -f %s pull", composeFile, dc, composeFile)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ComposeBuild docker compose build
func (re *RemoteExecutor) ComposeBuild(composeFile string, services ...string) error {
	utils.Info("Building images...")
	dc := re.GetComposeCmd()
	var svcArg string
	if len(services) > 0 {
		svcArg = strings.Join(services, " ")
	}
	cmd := fmt.Sprintf("cd $(dirname %s) && %s -f %s build %s", composeFile, dc, composeFile, svcArg)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ComposeUp docker compose up -d --remove-orphans
func (re *RemoteExecutor) ComposeUp(composeFile string) error {
	utils.Info("Starting services...")
	dc := re.GetComposeCmd()
	cmd := fmt.Sprintf("cd $(dirname %s) && %s -f %s up -d --remove-orphans", composeFile, dc, composeFile)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ComposeDown docker compose down
func (re *RemoteExecutor) ComposeDown(composeFile string) error {
	utils.Info("Stopping services...")
	dc := re.GetComposeCmd()
	cmd := fmt.Sprintf("cd $(dirname %s) && %s -f %s down", composeFile, dc, composeFile)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ComposePS docker compose ps
func (re *RemoteExecutor) ComposePS(composeFile string) (string, error) {
	dc := re.GetComposeCmd()
	cmd := fmt.Sprintf("cd $(dirname %s) && %s -f %s ps", composeFile, dc, composeFile)
	return SSHExecute(re.address, re.sshKey, cmd)
}

// ComposeService 对单个服务执行操作 (up/down/build/logs/restart)
func (re *RemoteExecutor) ComposeService(composeFile, service, action string) error {
	dc := re.GetComposeCmd()
	var cmd string
	switch action {
	case "up":
		cmd = fmt.Sprintf("cd $(dirname %s) && %s -f %s up -d --no-deps --build %s", composeFile, dc, composeFile, service)
	case "down":
		cmd = fmt.Sprintf("cd $(dirname %s) && %s -f %s stop %s", composeFile, dc, composeFile, service)
	case "build":
		cmd = fmt.Sprintf("cd $(dirname %s) && %s -f %s build --no-cache %s", composeFile, dc, composeFile, service)
	case "logs":
		cmd = fmt.Sprintf("cd $(dirname %s) && %s -f %s logs -f --tail=100 %s", composeFile, dc, composeFile, service)
	case "restart":
		cmd = fmt.Sprintf("cd $(dirname %s) && %s -f %s restart %s", composeFile, dc, composeFile, service)
	default:
		return fmt.Errorf("unknown service action: %s", action)
	}
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ==================== Git 操作 ====================

// GitClone 克隆仓库
func (re *RemoteExecutor) GitClone(repo, targetPath string) error {
	utils.Info("Cloning repository: %s", repo)
	cmd := fmt.Sprintf("if [ -d %q ]; then echo 'exists'; else git clone %q %q 2>/dev/null || echo 'clone failed'; fi", targetPath, repo, targetPath)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// GitPull 拉取更新
func (re *RemoteExecutor) GitPull(path string) error {
	utils.Info("Pulling updates: %s", path)
	cmd := fmt.Sprintf("if [ -d %q/.git ]; then git -C %q pull || true; fi", path, path)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ==================== Systemd 操作 ====================

// SetupSystemd 配置 Systemd 服务
func (re *RemoteExecutor) SetupSystemd(unitName, unitContent string) error {
	utils.Info("Setting up systemd service: %s", unitName)
	// 通过 cat > 写入服务文件
	cmd := fmt.Sprintf("cat > /tmp/%s.service << 'EOF_SYSTEMD'\n%s\nEOF_SYSTEMD\nsudo mv /tmp/%s.service /etc/systemd/system/\nsudo systemctl daemon-reload\nsudo systemctl enable %s", unitName, unitContent, unitName, unitName)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// Systemctl 执行 systemctl 操作
func (re *RemoteExecutor) Systemctl(action, service string) error {
	cmd := fmt.Sprintf("sudo systemctl %s %s", action, service)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// ==================== 文件系统操作 ====================

// EnsureDir 确保远程目录存在
func (re *RemoteExecutor) EnsureDir(path string) error {
	// 仅对「新建」目录 chown 给执行用户（满足非 sudo 的 cat 写入）；绝不 chown 已存在目录，
	// 否则会夺走 /etc 等系统目录的属主、导致 sudo 失效（同 sync.ensureRemoteDir）。
	cmd := fmt.Sprintf(`if [ ! -d %q ]; then sudo mkdir -p %q && sudo chown $(id -u):$(id -g) %q; fi`, path, path, path)
	_, err := SSHExecute(re.address, re.sshKey, cmd)
	return err
}

// WriteFile 在远程主机写入文件
func (re *RemoteExecutor) WriteFile(content, remotePath string) error {
	_, err := SSHUploadContent(re.address, re.sshKey, content, remotePath)
	return err
}
