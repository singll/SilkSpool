package engine

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

type BackupManager struct {
	sshClient *SSHClient
	host      string
	hostConfig *config.HostConfig
	localDir  string
}

func NewBackupManagerFromConfig(host string, hostConfig *config.HostConfig) *BackupManager {
	homeDir, _ := os.UserHomeDir()
	localDir := filepath.Join(homeDir, "silkspool_backups", host, time.Now().Format("20060102_150405"))

	return &BackupManager{
		host:       host,
		hostConfig: hostConfig,
		localDir:   localDir,
	}
}

func (m *BackupManager) SetSSHClient(client *SSHClient) {
	m.sshClient = client
}

func (m *BackupManager) LocalDir() string {
	return m.localDir
}

func (m *BackupManager) Host() string {
	return m.host
}

type BackupResult struct {
	Name   string
	Path   string
	Status string
	Error  error
}

func (m *BackupManager) Run(ctx context.Context) ([]BackupResult, error) {
	if m.sshClient == nil {
		return nil, fmt.Errorf("SSH client not configured")
	}

	if len(m.hostConfig.Backups) == 0 {
		return nil, fmt.Errorf("no backup rules configured for host: %s", m.host)
	}

	utils.Info("Starting backup for host: %s", m.host)

	if err := os.MkdirAll(m.localDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create backup dir: %w", err)
	}

	var results []BackupResult

	for _, rule := range m.hostConfig.Backups {
		result := m.backupRule(ctx, rule)
		results = append(results, result)

		if result.Error != nil {
			utils.Warn("Backup failed: %s - %v", result.Name, result.Error)
		} else {
			utils.Success("Backup completed: %s", result.Name)
		}
	}

	return results, nil
}

func (m *BackupManager) backupRule(ctx context.Context, rule config.BackupRule) BackupResult {
	result := BackupResult{Name: rule.Name}

	utils.Info("Backing up: %s (%s)...", rule.Name, rule.Type)

	remoteTmp := fmt.Sprintf("/tmp/bk_%s.tar.gz", rule.Name)
	localPath := filepath.Join(m.localDir, rule.Name+".tar.gz")

	var cmd string
	switch rule.Type {
	case "volume":
		cmd = fmt.Sprintf(
			"docker run --rm -v %s:/data -v /tmp:/backup alpine tar czf /backup/%s -C /data .",
			rule.Source, filepath.Base(remoteTmp),
		)
	case "dir":
		dir := rule.Source
		base := filepath.Base(dir)
		parent := filepath.Dir(dir)
		cmd = fmt.Sprintf("tar czf %s -C %s %s", remoteTmp, parent, base)
	case "db-mysql":
		cmd = fmt.Sprintf(
			"docker exec %s mysqldump -u root -p${MYSQL_ROOT_PASSWORD} --all-databases 2>/dev/null | gzip > %s",
			rule.Source, remoteTmp,
		)
	case "db-pg":
		cmd = fmt.Sprintf(
			"docker exec %s pg_dumpall -U postgres 2>/dev/null | gzip > %s",
			rule.Source, remoteTmp,
		)
	default:
		result.Error = fmt.Errorf("unknown backup type: %s", rule.Type)
		return result
	}

	// Execute remote command
	_, err := m.sshClient.Execute(cmd)
	if err != nil {
		result.Error = fmt.Errorf("remote backup failed: %w", err)
		return result
	}

	// Download file
	if err := m.sshClient.Download(remoteTmp, localPath); err != nil {
		result.Error = fmt.Errorf("download failed: %w", err)
		return result
	}

	// Cleanup remote temp file
	_, _ = m.sshClient.Execute("rm -f " + remoteTmp)

	result.Path = localPath
	result.Status = "success"
	return result
}

// ParseBackupRules parses backup rules from string format (for legacy shell scripts)
func ParseBackupRules(rulesStr string) []config.BackupRule {
	var rules []config.BackupRule
	if rulesStr == "" {
		return rules
	}

	for _, rule := range strings.Fields(rulesStr) {
		parts := strings.Split(rule, ":")
		if len(parts) >= 3 {
			rules = append(rules, config.BackupRule{
				Type:   parts[0],
				Source: parts[1],
				Name:   parts[2],
			})
		}
	}
	return rules
}

// LocalBackup creates a local backup of a directory
func LocalBackup(ctx context.Context, src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, "tar", "czf", dst, "-C", filepath.Dir(src), filepath.Base(src))
	return cmd.Run()
}
