package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// GenerationMeta 记录远端 generation 快照的元数据。
type GenerationMeta struct {
	Version     int           `yaml:"version"`
	Bundle      string        `yaml:"bundle"`
	Host        string        `yaml:"host"`
	Generation  int           `yaml:"generation"`
	LockHash    string        `yaml:"lock_hash,omitempty"`
	ComposeHash string        `yaml:"compose_sha256,omitempty"`
	Status      string        `yaml:"status"`
	CreatedAt   string        `yaml:"created_at"`
	BackupDir   string        `yaml:"backup_dir,omitempty"`
	Services    []ServiceSpec `yaml:"services,omitempty"`
}

// LocalState 是控制机上的资源索引（可重建缓存）。
type LocalState struct {
	Host        string `yaml:"host"`
	Bundle      string `yaml:"bundle"`
	Generation  int    `yaml:"generation"`
	Status      string `yaml:"status"`
	LockHash    string `yaml:"lock_hash,omitempty"`
	ComposeHash string `yaml:"compose_sha256,omitempty"`
	BackupDir   string `yaml:"backup_dir,omitempty"`
	UpdatedAt   string `yaml:"updated_at"`
}

// StatePath 返回本地 state 路径。
func StatePath(baseDir, host, bundle string) string {
	return filepath.Join(baseDir, ".spool", "state", host, bundle+".yaml")
}

// WriteLocalState 写入本地索引。
func WriteLocalState(baseDir string, state *LocalState) error {
	path := StatePath(baseDir, state.Host, state.Bundle)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := yaml.Marshal(state)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// ReadLocalState 读取本地索引；不存在时返回 os.ErrNotExist。
func ReadLocalState(baseDir, host, bundle string) (*LocalState, error) {
	data, err := os.ReadFile(StatePath(baseDir, host, bundle))
	if err != nil {
		return nil, err
	}
	var state LocalState
	if err := yaml.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

// ParseGenerationMeta 解析远端 meta.yaml。
func ParseGenerationMeta(data []byte) (*GenerationMeta, error) {
	var meta GenerationMeta
	if err := yaml.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

// ComposeFilesForDeploy 返回部署目录中的 compose 文件（基础 + 可选 override）。
func ComposeFilesForDeploy(deployPath string) []string {
	return []string{
		filepath.Join(deployPath, "docker-compose.yaml"),
		filepath.Join(deployPath, "docker-compose.spool.yaml"),
	}
}

// GenerationDir 返回远端 generation 目录。
func GenerationDir(deployPath string, generation int) string {
	return filepath.Join(deployPath, ".spool-gen", fmt.Sprintf("%d", generation))
}

// RemoteGenerationCurrentPath 返回远端当前 generation 指针。
func RemoteGenerationCurrentPath(deployPath string) string {
	return filepath.Join(deployPath, ".spool-gen", "current")
}

// nowUTC 便于测试注入时间。
func nowUTC(now func() time.Time) string {
	if now == nil {
		return time.Now().UTC().Format(time.RFC3339)
	}
	return now().UTC().Format(time.RFC3339)
}

func generationNumber(name string) (int, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return 0, false
	}
	value := 0
	for _, r := range name {
		if r < '0' || r > '9' {
			return 0, false
		}
		value = value*10 + int(r-'0')
	}
	return value, true
}
