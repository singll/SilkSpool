package engine

import (
	"fmt"
	"path/filepath"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/sops"
	"github.com/singll/silkspool/pkg/utils"
)

// SOPSManager 封装 pkg/sops，提供更高级的集成
type SOPSManager struct {
	mgr *sops.Manager
}

// NewSOPSManager 创建 SOPS 管理器
func NewSOPSManager(baseDir string) (*SOPSManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	ageKeyPath := cfg.Global.AgeKeyPath
	if ageKeyPath == "" {
		// 尝试默认路径
		ageKeyPath = filepath.Join(baseDir, "keys", "age.key")
	}

	return &SOPSManager{
		mgr: sops.NewManager(ageKeyPath),
	}, nil
}

// NewSOPSManagerWithKey 使用指定密钥路径创建 SOPS 管理器
func NewSOPSManagerWithKey(ageKeyPath string) *SOPSManager {
	return &SOPSManager{
		mgr: sops.NewManager(ageKeyPath),
	}
}

// IsEncrypted 检查文件是否已加密
func (m *SOPSManager) IsEncrypted(path string) bool {
	return m.mgr.IsEncrypted(path)
}

// Decrypt 解密文件
func (m *SOPSManager) Decrypt(encryptedPath string) ([]byte, error) {
	return m.mgr.Decrypt(encryptedPath)
}

// DecryptAndUpload 解密并上传到远程
func (m *SOPSManager) DecryptAndUpload(sshClient *SSHClient, encryptedPath, remotePath string) error {
	utils.Info("Decrypting and uploading: %s", encryptedPath)

	decrypted, err := m.Decrypt(encryptedPath)
	if err != nil {
		return err
	}

	// 上传到远程
	if err := sshClient.Upload(string(decrypted), remotePath); err != nil {
		return fmt.Errorf("upload failed: %w", err)
	}

	utils.Success("Uploaded decrypted content to: %s", remotePath)
	return nil
}

// ProcessEncryptedFilesInHost 扫描主机目录中的加密文件
func (m *SOPSManager) ProcessEncryptedFilesInHost(baseDir, host string, uploadFn func(src, dst string, data []byte) error) error {
	hostDir := filepath.Join(baseDir, "hosts", host)

	return m.mgr.ProcessEncryptedFiles(hostDir, func(src, plainName string, data []byte) error {
		utils.Info("Processing encrypted file: %s", src)
		if uploadFn != nil {
			return uploadFn(src, plainName, data)
		}
		return nil
	})
}
