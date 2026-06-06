package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleYAML = `# 顶层注释
global:
  ssh_key_path: "./keys/id_silkspool"

# -------------------- 主机清单 --------------------
hosts:
  # =========================================================================
  # Keeper 知识管理服务器
  # =========================================================================
  keeper:
    address: "silkspool@192.168.7.230"
    bundles: ["keeper"]

  # =========================================================================
  # Bili-Node B站相关服务节点
  # =========================================================================
  bili-node:
    address: "silkspool@192.168.7.108"
    bundles: ["bili"]

  # =========================================================================
  # TXHK 远程 VPS
  # =========================================================================
  txhk:
    address: "silkspool@43.129.195.4"
    bundles: ["server"]
`

func TestRemoveHostFromYAML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0644); err != nil {
		t.Fatal(err)
	}

	if err := RemoveHostFromYAML(path, "bili-node"); err != nil {
		t.Fatalf("RemoveHostFromYAML failed: %v", err)
	}

	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)

	// 目标主机及其横幅注释应消失
	if strings.Contains(s, "bili-node:") {
		t.Errorf("removed host still present:\n%s", s)
	}
	if strings.Contains(s, "Bili-Node") {
		t.Errorf("removed host banner comment still present:\n%s", s)
	}

	// 其它主机及其注释、引号风格应保留
	for _, want := range []string{
		"keeper:", "Keeper 知识管理服务器",
		"txhk:", "TXHK 远程 VPS",
		`"silkspool@192.168.7.230"`, // 引号风格保留
		`["keeper"]`,                // flow 序列风格保留
		"# 顶层注释",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("expected %q to be preserved, but it is missing:\n%s", want, s)
		}
	}

	// 备份文件应包含原始内容 (含被删主机)
	bak, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("backup not written: %v", err)
	}
	if !strings.Contains(string(bak), "bili-node:") {
		t.Errorf("backup should contain original content")
	}
}

func TestRemoveHostFromYAMLNotFound(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0644); err != nil {
		t.Fatal(err)
	}
	if err := RemoveHostFromYAML(path, "does-not-exist"); err == nil {
		t.Error("expected error for missing host, got nil")
	}
}

func TestConfigFilePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := ConfigFilePath(dir)
	if err != nil {
		t.Fatalf("ConfigFilePath failed: %v", err)
	}
	if got != path {
		t.Errorf("ConfigFilePath = %q, want %q", got, path)
	}
}
