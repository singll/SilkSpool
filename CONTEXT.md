# Domain Language / 领域语言

> Ubiquitous language for the SilkSpool project.
> When code, docs, or conversation uses these terms, they mean exactly this.

| Term | Definition |
|------|-----------|
| Host | A remote server managed by SilkSpool, identified by an alias string. Defined in `silkspool.yaml` under `hosts.<alias>`. |
| Bundle | A deployable unit with a manifest. Classes: `product` (single upstream product), `composition` (BOM/wiring of components), `capability` (reusable data/middleware), `infrastructure`, `tool`. Delivery driver: `compose` / `stack` / `script`. |
| Stack | A set of binary services installed from GitHub/GitLab releases onto a host, managed via systemd. Declared in `host.stack[]`. |
| Service | A single runnable unit on a host. Four types: `docker` (container), `systemd`, `initd`, `openwrt`. Defined in `host.services[]` or resolved from a Bundle. |
| Sync Rule | A mapping between a local config file (under `hosts/<alias>/`) and a remote absolute path. Bidirectional via `sync pull/push`. |
| Post-Push Hook | A command executed on the remote host after a sync push matches a file pattern. Defined in `host.post_push_hooks[]`. |
| Backup Rule | A definition of what to back up on a host. Types: `volume` (Docker volume), `dir` (directory), `db-mysql`. Defined in `host.backups[]`. |
| Install Source | A binary release source definition for stack installation. Three flavors: GitHub release (`repo: owner/name`), GitLab release (`repo: gitlab:...`), or a direct URL (`url:`, mutually exclusive with `repo`, bypasses any release API). Supports `{ARCH}` and `{VERSION}` placeholders in the pattern/URL. Direct-URL and GitLab sources cannot resolve `latest` and must pin an explicit `default_version`. Optional `sha256` (per-arch map) enables integrity verification before install. |
| Artifact Format | The packaging/compression shape of a downloaded release asset, distinct from the binary it contains. Single-file compression (`zst`, `gz`) decompresses directly to the executable; compressed archives (`tar.gz`, `tar.xz`, `tar.zst`, `zip`) must be extracted and the binary located inside; `raw` is a bare ELF. An Install Source's format is detected from the asset filename suffix, overridable by an explicit `format` field for regex/ambiguous patterns. |
| BaseDir | The runtime root directory containing the spool binary, `silkspool.yaml`, `hosts/`, `keys/`, `bundles/`, `backups/`. Resolved via `os.Executable()`. |
| App Prefix | A string prefix prepended to container names on a host (e.g., `sp-`). Set per-host via `app_prefix`. Used as `${APP_PREFIX}` in compose templates. |
| Key Rotation | Two-phase SSH key replacement across all managed hosts: (1) deploy new public key, (2) remove old public key. Prevents lockout. |
| Decommission | Removal of a host from SilkSpool management. Revokes SSH access by removing the spool public key from `authorized_keys`. Optionally purges the host block from config. |
| Known Hosts | SSH host key verification file (`known_hosts` in BaseDir). Populated during `spool init`. Prevents MITM attacks on subsequent connections. |
| Deploy Path | The remote directory where a bundle is deployed. Defaults to `/opt/silkspool/<bundle-name>`; manifest `deploy_path` overrides. |
| Compose Driver | The bundle driver that deploys Docker Compose templates. Handles template rendering, file upload, and `docker compose up`. |
| Stack Driver | The bundle driver that installs binary releases and pushes systemd service templates. |
| Bundle Manifest | `manifest.yaml` / `bundle.yaml`. Supports legacy flat fields and the `apiVersion/kind/metadata/spec` contract: class/version/owner/labels, delivery, outputs, lifecycle, backup, components, dependencies, wiring, inputs. |
| Manifest Features | Optional capabilities in a bundle: `docker_log_rotation`, `git_clone`, `docker_prune`, `create_network`. |
| SOPS Manager | SOPS encryption integration for syncing encrypted config files (`.enc` suffix). Uses age key for encryption/decryption. |
| DNS Record | A domain-to-IP mapping managed via the `dns` command. Written to dnsmasq and OpenClash hosts files on the gateway host. |
| Site | A triple-integration entry: DNS record + Caddy reverse proxy + Homepage dashboard widget. Created via `site deploy`. |
| Remote Executor | A helper that wraps SSH operations for common remote tasks: Docker installation, compose detection, log rotation, network creation, file upload. |
| SSH Client Pool | A global connection pool (`SSHClientPool`) that reuses SSH connections across commands. Initialized in CLI `PersistentPreRunE`. |
| N8N Client | API client for n8n workflow automation. Supports both direct HTTP and remote SSH-tunneled requests (when n8n API is on localhost). |
| TrueNAS Client | WebSocket JSON-RPC client for TrueNAS management. Supports system info, pool/dataset/snapshot queries, job polling, and an explicit storage-maintenance RPC allowlist (dataset provisioning, dedicated backup users, NFS entries, service configuration; no dataset deletion or shell execution). |
| Env File | Per-host `.env` file at `hosts/<alias>/.env`. Stores secrets (API keys, passwords). Gitignored. Loaded by `LoadEnvFile()`. |
| Component | A bundle deployed by the current composition, always on the target host. Referenced as `components.<key>`; apply/upgrade/rollback only touches components. |
| Dependency | A bundle already deployed elsewhere (e.g. `silkdata`). Read-only outputs; never applied, upgraded, or rolled back by the consumer. |
| Wiring | Per-component environment interpolation using `${components.*.outputs.*}`, `${dependencies.*.outputs.*}`, `${secrets.*}`, `${input.*}`, `${host.*}`. Unresolved references fail at plan time. |
| Endpoint Output | Logical `{kind: endpoint, service, port, published_port, remote}` output. Resolved by topology: same-project service name, same-host address, or cross-host MagicDNS/address. |
| Generation | A remote snapshot under `.spool-gen/<n>/` containing compose/env/digest/meta. Used for rollback; default retains current + previous. |
| Lock Snapshot | `.spool/lock/<host>/<bundle>.yaml`, the resolved plan used by `apply --locked`. Not a semver dependency lock. |
| State | `.spool/state/<host>/<bundle>.yaml`, a rebuildable local index of generation/status/lock hash. |
| Resource | Unified object model (`Host`, `Bundle`, `Service`, `SyncRule`, `DNSRecord`, `Site`, `Dataset`, `Secret`, `Backup`, `Key`) with `Status` / `Plan` / `Apply` / `Backup` / `Restore` verbs. Unsupported verbs must return `unsupported`. |
| Bundle Source | Where a bundle comes from: `dir`, `git` (pinned commit), or `oci` (pinned manifest digest, optional cosign gate). |
| Adopt | `spool adopt <host>`: read-only discovery of an existing compose project, generating manifest/state/lock without recreating containers. |
