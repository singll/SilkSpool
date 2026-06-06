package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ConfigFilePath 返回已解析的 silkspool.yaml 绝对路径。
// 复刻 ConfigLoader.Load 的 viper 搜索顺序: baseDir, baseDir/.., /etc/silkspool。
func ConfigFilePath(baseDir string) (string, error) {
	candidates := []string{
		filepath.Join(baseDir, "silkspool.yaml"),
		filepath.Join(baseDir, "..", "silkspool.yaml"),
		"/etc/silkspool/silkspool.yaml",
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			abs, aerr := filepath.Abs(p)
			if aerr != nil {
				return p, nil
			}
			return abs, nil
		}
	}
	return "", fmt.Errorf("silkspool.yaml not found (searched: %v)", candidates)
}

// RemoveHostFromYAML 从 silkspool.yaml 的 hosts 映射中删除指定主机，
// 同时保留其它条目的注释与标量风格 (引号 / flow 序列)。
// 写入前先生成 <path>.bak 备份。主机不存在时返回错误且不修改文件。
func RemoveHostFromYAML(path, alias string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read config: %w", err)
	}

	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("failed to parse YAML: %w", err)
	}

	// 文档节点 -> 顶层 mapping
	if len(root.Content) == 0 {
		return fmt.Errorf("empty YAML document")
	}
	doc := root.Content[0]
	if doc.Kind != yaml.MappingNode {
		return fmt.Errorf("unexpected YAML structure: root is not a mapping")
	}

	// 定位 hosts 值节点
	var hostsVal *yaml.Node
	for i := 0; i+1 < len(doc.Content); i += 2 {
		if doc.Content[i].Value == "hosts" {
			hostsVal = doc.Content[i+1]
			break
		}
	}
	if hostsVal == nil || hostsVal.Kind != yaml.MappingNode {
		return fmt.Errorf("no 'hosts' mapping found in config")
	}

	// 删除目标主机的 keyNode + valNode 一对
	newContent := make([]*yaml.Node, 0, len(hostsVal.Content))
	removed := false
	for i := 0; i+1 < len(hostsVal.Content); i += 2 {
		if hostsVal.Content[i].Value == alias {
			removed = true
			continue
		}
		newContent = append(newContent, hostsVal.Content[i], hostsVal.Content[i+1])
	}
	if !removed {
		return fmt.Errorf("host %q not found in config", alias)
	}
	hostsVal.Content = newContent

	// 重新编码 (保留 2 空格缩进)
	out, err := encodeYAMLNode(&root)
	if err != nil {
		return fmt.Errorf("failed to encode YAML: %w", err)
	}

	// 写入前备份
	if err := os.WriteFile(path+".bak", data, 0644); err != nil {
		return fmt.Errorf("failed to write backup: %w", err)
	}

	if err := os.WriteFile(path, out, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// encodeYAMLNode 用 2 空格缩进编码 YAML 节点。
func encodeYAMLNode(n *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(n); err != nil {
		_ = enc.Close()
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
