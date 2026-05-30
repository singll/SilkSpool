package sops

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/singll/silkspool/pkg/utils"
)

// Manager 处理 SOPS 加密/解密
type Manager struct {
	ageKeyPath string
}

// NewManager 创建 SOPS 管理器
func NewManager(ageKeyPath string) *Manager {
	return &Manager{ageKeyPath: ageKeyPath}
}

// IsEncrypted 检查文件是否已加密
func (m *Manager) IsEncrypted(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return bytes.Contains(data, []byte("sops:")) ||
		bytes.Contains(data, []byte("data:"))
}

// Decrypt 解密文件到内存
func (m *Manager) Decrypt(encryptedPath string) ([]byte, error) {
	if m.ageKeyPath == "" {
		return nil, fmt.Errorf("SOPS age key path not configured")
	}

	// 检查 age key 文件是否存在
	if _, err := os.Stat(m.ageKeyPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("age key file not found: %s", m.ageKeyPath)
	}

	// 使用 sops 解密
	cmd := exec.Command("sops",
		"--decrypt",
		"--age", extractAgeRecipients(m.ageKeyPath),
		encryptedPath,
	)
	cmd.Env = append(os.Environ(), "SOPS_AGE_KEY_FILE="+m.ageKeyPath)

	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("sops decrypt failed: %s", string(exitErr.Stderr))
		}
		return nil, fmt.Errorf("sops decrypt failed: %v", err)
	}

	return output, nil
}

// DecryptToFile 解密到指定文件
func (m *Manager) DecryptToFile(encryptedPath, outputPath string) error {
	data, err := m.Decrypt(encryptedPath)
	if err != nil {
		return err
	}

	if err := os.WriteFile(outputPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write decrypted file: %w", err)
	}

	utils.Success("Decrypted: %s -> %s", encryptedPath, outputPath)
	return nil
}

// Encrypt 加密文件
func (m *Manager) Encrypt(inputPath, outputPath string) error {
	if m.ageKeyPath == "" {
		return fmt.Errorf("SOPS age key path not configured")
	}

	cmd := exec.Command("sops",
		"--encrypt",
		"--age", extractAgeRecipients(m.ageKeyPath),
		"--output", outputPath,
		inputPath,
	)
	cmd.Env = append(os.Environ(), "SOPS_AGE_KEY_FILE="+m.ageKeyPath)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sops encrypt failed: %s", string(output))
	}

	utils.Success("Encrypted: %s -> %s", inputPath, outputPath)
	return nil
}

// SetAgeKeyPath 设置 age 密钥路径
func (m *Manager) SetAgeKeyPath(path string) {
	m.ageKeyPath = path
}

// extractAgeRecipients 从 age 密钥文件提取收件人标识
func extractAgeRecipients(keyPath string) string {
	// age 密钥格式: AGE-SECRET-KEY-...
	// 公钥格式: age1...
	data, err := os.ReadFile(keyPath)
	if err != nil {
		return ""
	}

	content := strings.TrimSpace(string(data))

	// 如果是私钥文件，提取公钥 (通过 stdin 传入，避免私钥出现在进程命令行/ps 中)
	if strings.HasPrefix(content, "AGE-SECRET-KEY-") {
		cmd := exec.Command("age-keygen", "-y")
		cmd.Stdin = strings.NewReader(content)
		output, err := cmd.Output()
		if err == nil {
			return strings.TrimSpace(string(output))
		}
	}

	// 如果已经是公钥，直接返回
	if strings.HasPrefix(content, "age1") {
		return content
	}

	return ""
}

// ProcessEncryptedFiles 扫描目录中的加密文件并处理
func (m *Manager) ProcessEncryptedFiles(dir string, processFn func(src, plainName string, data []byte) error) error {
	if m.ageKeyPath == "" {
		utils.Warn("SOPS age key not configured, skipping encrypted file processing")
		return nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		name := entry.Name()
		if !strings.HasSuffix(name, ".enc") && !strings.HasSuffix(name, ".sops.yaml") {
			continue
		}

		encPath := filepath.Join(dir, name)

		// 检查是否存在对应的明文文件
		plainName := strings.TrimSuffix(name, ".enc")
		plainName = strings.TrimSuffix(plainName, ".sops.yaml")
		plainPath := filepath.Join(dir, plainName)

		if _, err := os.Stat(plainPath); os.IsNotExist(err) {
			// 只加密文件存在，解密并处理
			utils.Info("Found encrypted file: %s", name)

			decrypted, err := m.Decrypt(encPath)
			if err != nil {
				utils.Warn("Failed to decrypt %s: %v", name, err)
				continue
			}

			if processFn != nil {
				if err := processFn(encPath, plainName, decrypted); err != nil {
					utils.Warn("Process callback failed for %s: %v", name, err)
				}
			}
		}
	}

	return nil
}

// EnsureSOPSInstalled 检查 sops 是否安装
func EnsureSOPSInstalled() error {
	cmd := exec.Command("sops", "--version")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sops is not installed. Install: https://github.com/getsops/sops#installation")
	}
	return nil
}

// GenAgeKey 生成新的 age 密钥
func GenAgeKey(outputPath string) error {
	dir := filepath.Dir(outputPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create key directory: %w", err)
	}

	cmd := exec.Command("age-keygen", "-o", outputPath)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to generate age key: %w", err)
	}

	utils.Success("Generated age key: %s", outputPath)
	utils.Info("Share the public key with collaborators:")
	utils.Info("  age1...")
	return nil
}
