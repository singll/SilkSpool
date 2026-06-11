# Changelog

All notable changes to SilkSpool will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
