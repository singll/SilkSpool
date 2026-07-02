package engine

import "testing"

func TestDetectFormat(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		explicit string
		want     ArtifactFormat
	}{
		// 后缀探测 —— 最长后缀优先
		{"tar.gz", "app-linux-amd64.tar.gz", "", FormatTarGz},
		{"tgz", "app.tgz", "", FormatTarGz},
		{"tar.xz", "app-x86_64.tar.xz", "", FormatTarXz},
		{"txz", "app.txz", "", FormatTarXz},
		{"tar.zst", "app.tar.zst", "", FormatTarZst},
		{"zip", "app_linux.zip", "", FormatZip},
		{"zst single", "tuwunel-x86_64-linux-musl.zst", "", FormatZst},
		{"gz single", "app-linux-amd64.gz", "", FormatGz},
		{"raw no ext", "linux_amd64", "", FormatRaw},
		{"raw conduit regex", "x86_64.*linux.*musl", "", FormatRaw},
		// 大小写不敏感
		{"upper", "APP.TAR.GZ", "", FormatTarGz},

		// 关键边界：单文件 vs 压缩 tar 同后缀族不能混淆
		{"zst not tar.zst", "foo.zst", "", FormatZst},
		{"tar.zst not zst", "foo.tar.zst", "", FormatTarZst},
		{"gz not tar.gz", "foo.gz", "", FormatGz},
		{"tar.gz not gz", "foo.tar.gz", "", FormatTarGz},

		// explicit 字段覆盖探测 —— 正则源唯一出路
		{"explicit overrides regex", "x86_64.*linux.*musl", "tar.zst", FormatTarZst},
		{"explicit zst on no-ext", "tuwunel-bin", "zst", FormatZst},
		{"explicit raw", "weird.tar.gz", "raw", FormatRaw},
		{"explicit alias zstd", "foo", "zstd", FormatZst},
		{"explicit alias gzip", "foo", "gzip", FormatGz},
		{"explicit unknown -> raw", "foo", "nonsense", FormatRaw},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectFormat(tt.filename, tt.explicit)
			if got != tt.want {
				t.Errorf("detectFormat(%q, %q) = %q, want %q", tt.filename, tt.explicit, got, tt.want)
			}
		})
	}
}

func TestFormatRequiredTool(t *testing.T) {
	tests := []struct {
		f    ArtifactFormat
		tool string
	}{
		{FormatTarGz, "tar"},
		{FormatTarXz, "xz"},
		{FormatTarZst, "zstd"},
		{FormatZip, "unzip"},
		{FormatZst, "zstd"},
		{FormatGz, "gzip"},
		{FormatRaw, ""},
	}
	for _, tt := range tests {
		if got := tt.f.requiredTool(); got != tt.tool {
			t.Errorf("%s.requiredTool() = %q, want %q", tt.f, got, tt.tool)
		}
	}
}

func TestFormatIsArchive(t *testing.T) {
	archives := []ArtifactFormat{FormatTarGz, FormatTarXz, FormatTarZst, FormatZip}
	singles := []ArtifactFormat{FormatZst, FormatGz, FormatRaw}
	for _, f := range archives {
		if !f.isArchive() {
			t.Errorf("%s.isArchive() = false, want true", f)
		}
	}
	for _, f := range singles {
		if f.isArchive() {
			t.Errorf("%s.isArchive() = true, want false", f)
		}
	}
}
