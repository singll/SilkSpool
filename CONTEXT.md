# Domain Language / 领域语言

> Ubiquitous language for the SilkSpool project.
> When code, docs, or conversation uses these terms, they mean exactly this.

| Term | Definition |
|------|-----------|
| Host | A remote server managed by SilkSpool, identified by an alias string. Defined in `silkspool.yaml` under `hosts.<alias>`. |
| Bundle | A deployable package of Docker Compose services (type: compose) or binary tools (type: stack), with templates and a manifest. |
| Stack | A set of binary services installed from GitHub/GitLab releases onto a host, managed via systemd. Declared in `host.stack[]`. |
| Service | A single runnable unit on a host. Four types: `docker` (container), `systemd`, `initd`, `openwrt`. Defined in `host.services[]`. |
| Sync Rule | A mapping between a local config file (under `hosts/<alias>/`) and a remote absolute path. Bidirectional via `sync pull/push`. |
| Post-Push Hook | A command executed on the remote host after a sync push matches a file pattern. Defined in `host.post_push_hooks[]`. |
| Backup Rule | A definition of what to back up on a host. Types: `volume` (Docker volume), `dir` (directory), `db-mysql`. Defined in `host.backups[]`. |
| Install Source | A GitHub or GitLab release source definition for stack binary installation. Supports `{ARCH}` and `{VERSION}` placeholders in filename patterns. |
| BaseDir | The runtime root directory containing the spool binary, `silkspool.yaml`, `hosts/`, `keys/`, `bundles/`, `backups/`. Resolved via `os.Executable()`. |
| App Prefix | A string prefix prepended to container names on a host (e.g., `sp-`). Set per-host via `app_prefix`. Used as `${APP_PREFIX}` in compose templates. |
| Key Rotation | Two-phase SSH key replacement across all managed hosts: (1) deploy new public key, (2) remove old public key. Prevents lockout. |
| Decommission | Removal of a host from SilkSpool management. Revokes SSH access by removing the spool public key from `authorized_keys`. Optionally purges the host block from config. |
| Known Hosts | SSH host key verification file (`known_hosts` in BaseDir). Populated during `spool init`. Prevents MITM attacks on subsequent connections. |
| Deploy Path | The remote directory where a bundle is deployed. Defaults to `/opt/silkspool/<bundle-name>`. Configurable via `global.defaults.deploy_path`. |
| Compose Driver | The bundle driver that deploys Docker Compose templates. Handles template rendering, file upload, and `docker compose up`. |
| Stack Driver | The bundle driver that installs binary releases and pushes systemd service templates. |
| Bundle Manifest | `manifest.yaml` in a bundle directory. Declares type, features, templates, services, and default config content. |
| Manifest Features | Optional capabilities in a bundle: `docker_log_rotation`, `git_clone`, `docker_prune`, `create_network`. |
| SOPS Manager | SOPS encryption integration for syncing encrypted config files (`.enc` suffix). Uses age key for encryption/decryption. |
| DNS Record | A domain-to-IP mapping managed via the `dns` command. Written to dnsmasq and OpenClash hosts files on the gateway host. |
| Site | A triple-integration entry: DNS record + Caddy reverse proxy + Homepage dashboard widget. Created via `site deploy`. |
| Remote Executor | A helper that wraps SSH operations for common remote tasks: Docker installation, compose detection, log rotation, network creation, file upload. |
| SSH Client Pool | A global connection pool (`SSHClientPool`) that reuses SSH connections across commands. Initialized in CLI `PersistentPreRunE`. |
| N8N Client | API client for n8n workflow automation. Supports both direct HTTP and remote SSH-tunneled requests (when n8n API is on localhost). |
| TrueNAS Client | WebSocket JSON-RPC client for TrueNAS management. Supports system info, pool/dataset/snapshot queries, and job polling. |
| Env File | Per-host `.env` file at `hosts/<alias>/.env`. Stores secrets (API keys, passwords). Gitignored. Loaded by `LoadEnvFile()`. |
