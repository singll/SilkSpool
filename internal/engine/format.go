package engine

import "strings"

// ArtifactFormat 打包/压缩格式 —— 描述下载产物的封装形态，与其内部二进制本身相区分。
type ArtifactFormat string

const (
	FormatTarGz  ArtifactFormat = "tar.gz"  // gzip 压缩 tar 包
	FormatTarXz  ArtifactFormat = "tar.xz"  // xz 压缩 tar 包
	FormatTarZst ArtifactFormat = "tar.zst" // zstd 压缩 tar 包
	FormatZip    ArtifactFormat = "zip"     // zip 压缩包
	FormatZst    ArtifactFormat = "zst"     // 单文件 zstd 压缩 (解出即二进制，如 tuwunel)
	FormatGz     ArtifactFormat = "gz"      // 单文件 gzip 压缩 (解出即二进制)
	FormatRaw    ArtifactFormat = "raw"     // 裸 ELF / 无扩展名 / 正则 pattern 兜底
)

// detectFormat 根据文件名后缀探测打包格式。
// explicit 非空时直接采用（跳过探测）—— 这是正则 pattern 源（末尾无干净后缀）的唯一可靠出路。
// 探测按"最长后缀优先"匹配：.tar.gz 必须先于 .gz，.tar.zst 必须先于 .zst。
// 无法识别（含正则 pattern、无后缀）一律落到 raw。
func detectFormat(filename, explicit string) ArtifactFormat {
	if explicit != "" {
		return normalizeFormat(explicit)
	}
	name := strings.ToLower(strings.TrimSpace(filename))
	switch {
	case strings.HasSuffix(name, ".tar.gz"), strings.HasSuffix(name, ".tgz"):
		return FormatTarGz
	case strings.HasSuffix(name, ".tar.xz"), strings.HasSuffix(name, ".txz"):
		return FormatTarXz
	case strings.HasSuffix(name, ".tar.zst"):
		return FormatTarZst
	case strings.HasSuffix(name, ".zip"):
		return FormatZip
	case strings.HasSuffix(name, ".zst"):
		return FormatZst
	case strings.HasSuffix(name, ".gz"):
		return FormatGz
	default:
		return FormatRaw
	}
}

// normalizeFormat 把配置里的 format 字段归一化到内部常量；无法识别落到 raw。
func normalizeFormat(s string) ArtifactFormat {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "tar.gz", "tgz", "targz":
		return FormatTarGz
	case "tar.xz", "txz", "tarxz":
		return FormatTarXz
	case "tar.zst", "tarzst":
		return FormatTarZst
	case "zip":
		return FormatZip
	case "zst", "zstd":
		return FormatZst
	case "gz", "gzip":
		return FormatGz
	default:
		return FormatRaw
	}
}

// requiredTool 返回解该格式所需的远程命令；返回 "" 表示无需额外工具 (raw)。
func (f ArtifactFormat) requiredTool() string {
	switch f {
	case FormatTarGz:
		return "tar"
	case FormatTarXz:
		return "xz"
	case FormatTarZst:
		return "zstd"
	case FormatZip:
		return "unzip"
	case FormatZst:
		return "zstd"
	case FormatGz:
		return "gzip"
	default:
		return ""
	}
}

// installHint 缺失解压工具时给用户的中文安装提示包名。
func (f ArtifactFormat) installHint() string {
	switch f {
	case FormatTarXz:
		return "xz-utils"
	case FormatTarZst, FormatZst:
		return "zstd"
	case FormatZip:
		return "unzip"
	case FormatTarGz, FormatGz:
		return "gzip"
	default:
		return ""
	}
}

// isArchive 是否为多文件压缩包 —— 解压后需要进一步定位其中的二进制。
// 单文件压缩 (zst/gz) 和 raw 解出来直接就是二进制，无需定位。
func (f ArtifactFormat) isArchive() bool {
	switch f {
	case FormatTarGz, FormatTarXz, FormatTarZst, FormatZip:
		return true
	}
	return false
}
