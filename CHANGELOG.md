# Changelog

All notable changes to SilkSpool will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-02

### Added

- 二进制安装支持多种打包格式（Artifact Format）：`tar.gz` / `tar.xz` / `tar.zst` / `zip` / `zst`（单文件）/ `gz`（单文件）/ 裸 ELF。补齐 tuwunel 等以 `.zst` 单文件分发的服务（`zstd -d` 解出全静态可执行文件）
- `install_sources.format` 字段：覆盖按文件名后缀的格式自动探测，正则 `pattern` 源的唯一可靠出路
- `install_sources.binary_path` 字段：压缩包内二进制相对路径；未填时按 alias 名优先、最大 ELF 次之定位，彻底弃用脆弱的 `find -executable`
- `install_sources.exec_args` 字段：systemd 最小 unit 的 `ExecStart` 附加参数（如 tuwunel `--config`）；已存在 unit（含 bundle 模板）则不覆盖
- 解压依赖预检：缺 `zstd` / `xz` / `unzip` 时给出明确中文报错与安装包名，绝不擅自改动目标机
- 安装幂等：写 `/usr/local/bin/.spool-<alias>.version` 标记，`latest`（仅 GitHub 源）先解析成具体 tag 再比对，一致则跳过
- `spool stack --force`（强制重装）与 `--dry-run`（只解析版本/URL/格式并打印，不执行安装，仍会探测远程架构）
- `install_sources.url` 字段：任意直链下载源（支持 `{ARCH}`/`{VERSION}` 占位），与 `repo` 互斥、优先，绕开 GitHub/GitLab release API；覆盖不在标准 release 路径的二进制
- `install_sources.sha256` 字段：按架构（`amd64`/`arm64`…）的校验和 map；非空则安装前远程 `sha256sum` 比对，不符即中止清理并非零退出；配了却缺当前架构 → 报错不放行
- 安装源配置校验：`url` 与 `repo` 不可都空或同填；直链源与 GitLab 源无法解析 `latest`，必须显式 pin `default_version`，否则明确报错（不再静默装过一次就永不更新）
- 完整性预检扩围：`curl` 恒检、`sha256sum` 仅在配了校验和时检，与解压工具同一套中文缺失提示
- `binary_path` 用于单文件压缩/裸 ELF 时 warn 忽略；`exec_args` 变更但 unit 已存在时 warn 提示（不覆盖，避免静默不生效）
- `InstallStack` 结尾聚合成功/失败清单，有失败则非 0 退出

### Changed

- 压缩 tar 统一用 `解压器 -dc | tar -xf -` 管道写法，不依赖 tar 的 `--zstd`/`-J` 标志（兼容老版本 tar）
- 二进制安装统一 `install -m 0755`，绕开发布包内权限为 644 的坑

## [1.1.0] - 2026-06-16

### Added

- n8n 工作流无损 round-trip：导入导出保持节点/连线/凭证引用完整
- `spool n8n export --to-source`：导出工作流直接回写到源文件目录
- `spool n8n update` 预推送 diff 守卫：推送前展示变更并要求确认，防止误覆盖

## [1.0.0] - 2026-06-11

### Breaking Changes

- Removed environment-specific default values from config (`default_domain`, `dns_gateway_ip`, etc.) — must be explicitly set in `silkspool.yaml`
- SSH host key verification enabled via `known_hosts` — first connection requires `spool init`
- RDP gateway/agent no longer have fallback defaults — environment variables are required

### Added

- SSH `known_hosts` management for host key verification
- SFTP-based file transfer (replaces shell injection-vulnerable cat/pipe)
- Configurable SSH port per host (`ssh_port` field)
- Timeout configuration (`global.timeouts`: `ssh_connect`, `http_client`, `agent_http`, `agent_retry`)
- Default value configuration (`global.defaults`: `log_lines`, `docker_log_max`, `deploy_path`, `compose_version`)
- Version injection via git tags + Makefile ldflags
- Docker Compose command detection caching (per-host, `sync.Map`)
- Log timestamps in all output
- Comprehensive test suite (config 76%, utils 87%, sops 56%, engine 30%, cli 32%, tools 21%)
- `internal/cli` package — all CLI commands extracted from `main.go`
- `SSHProvider` interface for n8n tools (eliminates circular dependency)
- `BundleDriver` interface with `compose` and `stack` driver registry
- `StackDriver` for binary service installation via GitHub/GitLab releases
- `InstallManager` with `{ARCH}` and `{VERSION}` placeholder support
- `KeyManager` for SSH key rotation and host decommission
- `BackupManager` for volume, directory, and database backups
- `DNSManager` for dnsmasq/OpenClash DNS record management
- `SiteManager` for DNS + Caddy + Homepage triple-integration
- `SOPSManager` integration for encrypted config sync
- `TrueNASClient` WebSocket JSON-RPC client
- `N8NClient` with remote SSH-tunneled API support
- `ConfigLoader` with viper-based YAML parsing and path resolution
- `RemoveHostFromYAML` for comment-preserving host removal from config
- `RemoteExecutor` for common remote operations (Docker install, compose detection, log rotation)

### Changed

- Go version upgraded from 1.22 to 1.24
- All dependencies updated to latest versions
- `main.go` reduced from 1289 lines to 15-line thin wrapper
- All `os.Exit(1)` patterns replaced with `RunE` error returns
- Manual JSON parsing in `install.go` replaced with `encoding/json`
- DNS file write errors now properly propagated
- Config search order: `--config` flag → `SILKSPOOL_CONFIG` env → BaseDir → CWD → `/etc/silkspool`

### Fixed

- Shell injection vulnerability in SSH `Upload`/`Download`
- Production IPs/MAC addresses removed from source code
- n8n client creation errors no longer silently ignored
- Duplicate `headscaleConfigExists` function consolidated
- `GetN8NWorkflowDir`/`GetN8NBackupDir` moved from `truenas.go` to `n8n.go`
- Dead code removed (`SSHUploadContent`, `ListRemoteWorkflows` stub, `_ = cfg.Hosts`)

### Security

- SSH host key verification (`known_hosts`) replaces `InsecureIgnoreHostKey`
- SFTP replaces shell-piped file operations (eliminates injection vectors)
- RDP binaries require explicit configuration (no hardcoded credentials)
- SSH key permissions enforced (0600 for private key, 0700 for keys directory)
