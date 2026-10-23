package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedImages(t *testing.T) {
	bundles := []string{"keeper", "silkdata", "observability"}
	for _, bundle := range bundles {
		t.Run(bundle, func(t *testing.T) {
			dir := filepath.Join("..", "..", "bundles", bundle, "templates")
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Skipf("templates unavailable: %v", err)
			}
			for _, entry := range entries {
				if entry.IsDir() || filepath.Ext(entry.Name()) != ".yaml" {
					continue
				}
				data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				for _, line := range strings.Split(string(data), "\n") {
					line = strings.TrimSpace(line)
					if !strings.HasPrefix(line, "image:") {
						continue
					}
					image := strings.TrimSpace(strings.TrimPrefix(line, "image:"))
					if strings.HasPrefix(image, "bellkeeper:") {
						// 本地构建镜像无法预置 digest，但必须使用显式版本 tag。
						if strings.HasSuffix(image, ":latest") {
							t.Errorf("%s: local build image must not use latest (%s)", entry.Name(), image)
						}
						continue
					}
					if !strings.Contains(image, "@sha256:") {
						t.Errorf("%s: image %s is not pinned by digest", entry.Name(), image)
					}
				}
			}
		})
	}
}
