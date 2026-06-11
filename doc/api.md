# API Reference / API 参考

Go package documentation for SilkSpool internals.

---

## internal/config

Configuration loading and type definitions.

### Types

| Type | Description |
|------|-------------|
| `Config` | Root structure for `silkspool.yaml`. Contains `Global`, `Hosts`, `InstallSources`, `N8N`, `TrueNAS`. |
| `GlobalConfig` | Global settings: `SSHKeyPath`, `AgeKeyPath`, `DefaultDomain`, `BackupDir`, `DNSGatewayIP`, `DNSGatewayHost`, `DNSHeadscaleHost`, `DNSHeadscaleServer`, `Timeouts`, `Defaults`. |
| `HostConfig` | Per-host configuration: `Address`, `SSHPort`, `AppPrefix`, `Bundles`, `SyncRules`, `Services`, `PostPushHooks`, `Backups`, `Stack`. |
| `SyncRule` | Sync mapping: `Local` (relative path) ↔ `Remote` (absolute path). |
| `ServiceEntry` | Service registration: `Alias`, `Type` (docker/systemd/initd/openwrt), `Name`. |
| `PostPushHook` | Push hook: `Pattern` (file match), `Command` (remote command). |
| `BackupRule` | Backup definition: `Type` (volume/dir/db-mysql), `Source`, `Name`. |
| `InstallSource` | Release source: `Alias`, `Repo`, `Pattern`, `ServiceName`, `DefaultVersion`. |
| `N8NConfig` | n8n integration: `Host`, `Container`, `WorkflowDir`, `APIURL`. |
| `TrueNASConfig` | TrueNAS integration: `Host`, `APIURL`, `Username`. |
| `TimeoutConfig` | Timeouts: `SSHConnect`, `HTTPClient`, `AgentHTTP`, `AgentRetry`. |
| `DefaultsConfig` | Defaults: `LogLines`, `DockerLogMax`, `DockerLogNum`, `DeployPath`, `ComposeVer`. |
| `ConfigLoader` | Loads config via viper. Search paths: baseDir, baseDir/.., /etc/silkspool. |

### Key Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `LoadConfig` | `(baseDir string) (*Config, error)` | Load config from BaseDir |
| `LoadConfigFromCWD` | `() (*Config, error)` | Load config from current directory |
| `LoadEnvFile` | `(baseDir, hostAlias string) (map[string]string, error)` | Parse `hosts/<alias>/.env` |
| `GetEnvVar` | `(key, hostAlias, baseDir string) string` | Get env var from .env, fallback to os.Getenv |
| `ResolveSSHKeyPath` | `(baseDir, keyPath string) string` | Resolve relative SSH key path against BaseDir |
| `ConfigFilePath` | `(baseDir string) (string, error)` | Find absolute path of silkspool.yaml |
| `RemoveHostFromYAML` | `(path, alias string) error` | Remove host block from YAML preserving comments |
| `ParseDuration` | `(s string, defaultVal time.Duration) time.Duration` | Parse duration with fallback |
| `DefaultInt` | `(val, defaultVal int) int` | Return default if val is 0 |
| `DefaultString` | `(val, defaultVal string) string` | Return default if val is empty |

### Methods

| Method | Description |
|--------|-------------|
| `Config.GetHost(alias)` | Returns `*HostConfig` or nil |
| `Config.GetInstallSource(alias)` | Returns `*InstallSource` or nil |
| `HostConfig.GetService(alias)` | Returns `*ServiceEntry` or nil |
| `ConfigLoader.Load()` | Load and parse config |
| `ConfigLoader.ResolveSSHKey(path)` | Resolve SSH key path relative to BaseDir |

---

## internal/engine

Core orchestration logic: SSH, sync, DNS, bundles, services, key management, backups.

### SSH

| Type/Function | Description |
|---------------|-------------|
| `SSHClient` | SSH connection with SFTP support. Options: `WithSSHPort`, `WithTimeout`, `WithKnownHosts`. |
| `SSHClientPool` | Connection pool. Reuses connections across commands. Thread-safe. |
| `NewSSHClient(address, sshKey, ...opts)` | Create client with functional options |
| `client.Connect()` | Establish SSH connection |
| `client.Execute(cmd)` | Run remote command, return stdout |
| `client.Upload(content, remotePath)` | SFTP upload content to remote path |
| `client.Download(remotePath, localPath)` | SFTP download to local path |
| `client.RemoveFile(remotePath)` | SFTP delete remote file |
| `InitGlobalPool(opts...)` | Initialize the global connection pool |
| `SSHExecute(address, sshKey, cmd)` | Execute via global pool |
| `SSHUpload(address, sshKey, content, path)` | Upload via global pool |

### Managers

| Manager | Key Methods | Description |
|---------|-------------|-------------|
| `SyncManager` | `SyncHost(host, direction)`, `pullFile`, `pushFile` | Bidirectional config sync with SOPS support |
| `DNSManager` | `AddRecord`, `RemoveRecord`, `PushRecords`, `ListRecords` | dnsmasq/OpenClash DNS management |
| `SiteManager` | `DeploySite`, `ListSites`, `PushAll` | DNS + Caddy + Homepage triple-integration |
| `BundleManager` | `Init`, `Up`, `Down`, `Status`, `Cleanup` | Bundle lifecycle via driver interface |
| `ServiceManager` | `GetHostServices`, `ControlService` | Service status/start/stop/restart/logs |
| `KeyManager` | `Rotate`, `Status`, `Decommission` | SSH key rotation and host decommission |
| `BackupManager` | `BackupAll` | Volume, directory, and database backups |
| `InitManager` | `InitHost` | SSH trust setup, Docker group, known_hosts |
| `InstallManager` | `InstallApp`, `InstallStack` | Binary installation from GitHub/GitLab releases |
| `SOPSManager` | `IsEncrypted`, `Decrypt` | SOPS encryption integration for sync |
| `RemoteExecutor` | `EnsureDocker`, `EnsureCompose`, `EnsureDir`, `UploadFile`, `CreateDockerNetwork` | Common remote operations wrapper |

### Bundle System

| Type | Description |
|------|-------------|
| `BundleDriver` | Interface: `Setup`, `Up`, `Down`, `Status`, `Cleanup`, `Service` |
| `ComposeDriver` | Docker Compose driver. Renders templates, uploads files, runs compose. |
| `StackDriver` | Binary stack driver. Installs releases, pushes systemd units. |
| `BundleManifest` | Bundle metadata: `Name`, `Type`, `Features`, `Defaults`, `Templates`, `Services`. |
| `BundleFeatures` | Feature flags: `DockerLogRotation`, `GitClone`, `DockerPrune`, `CreateNetwork`. |

### Driver Registry

```go
GetDriver(driverType, baseDir, sshKey, bundleName, defaults) (BundleDriver, error)
RegisterDriver(name, factory)  // Extend with custom drivers
```

---

## internal/tools

External service clients.

### N8NClient

| Type/Function | Description |
|---------------|-------------|
| `N8NClient` | HTTP API client for n8n. Auto-detects localhost and tunnels via SSH. |
| `N8NWorkflow` | Workflow structure: `ID`, `Name`, `Active`, `Nodes`, `Connections`, `Settings`. |
| `NewN8NClient(baseDir, hostAlias, sshProvider)` | Create client. API key from `hosts/<host>/.env`. |
| `client.ListWorkflows(ctx)` | List all workflows |
| `client.GetWorkflow(ctx, id)` | Get single workflow |
| `client.CreateWorkflow(ctx, workflow)` | Create workflow |
| `client.UpdateWorkflow(ctx, id, workflow)` | Update workflow |
| `client.ActivateWorkflow(ctx, id)` | Activate workflow |
| `client.DeactivateWorkflow(ctx, id)` | Deactivate workflow |
| `client.DeleteWorkflow(ctx, id)` | Delete workflow |
| `N8NManager` | High-level manager. `ImportWorkflows`, `ExportWorkflows`, `UpdateWorkflows`, `ActivateWorkflow`, `DeactivateWorkflow`. |
| `LoadWorkflowFromFile(path)` | Parse workflow JSON from file |
| `GetN8NWorkflowDir(baseDir)` | Resolve local workflow directory path |
| `GetN8NBackupDir(baseDir)` | Resolve backup directory with timestamp |

### TrueNASClient

| Type/Function | Description |
|---------------|-------------|
| `TrueNASClient` | WebSocket JSON-RPC client for TrueNAS API |
| `NewTrueNASClient(baseDir)` | Create client. API key from `hosts/<host>/.env`. |
| `client.Connect()` | Establish WebSocket connection |
| `client.Authenticate()` | API key authentication |
| `client.Call(method, params)` | Raw RPC call |
| `client.GetSystemInfo()` | System info: version, hostname, uptime, memory |
| `client.ListPools()` | Storage pools: name, status, size, health |
| `client.ListDatasets()` | Datasets: name, pool, type, used/available |
| `client.ListSnapshots(pool)` | Snapshots: name, dataset, created, size |
| `client.WaitForJob(jobID, timeout)` | Poll until job completes |
| `TrueNASManager` | High-level manager. `CmdInfo`, `CmdPoolList`, `CmdDatasetList`, `CmdSnapshotList`. |

### SSHProvider Interface

```go
type SSHProvider interface {
    Execute(address, sshKey, cmd string) (string, error)
}
```

Decouples n8n tools from `internal/engine`, preventing circular imports. Implemented by `SSHClient` via the global pool.

---

## internal/cli

CLI command registration and application bootstrap.

| Type/Function | Description |
|---------------|-------------|
| `App` | Application struct. Holds `BaseDir` and `Config`. |
| `NewApp(baseDir)` | Create app instance |
| `app.LoadConfig()` | Lazy-load config |
| `app.SSHKeyPath()` | Resolve SSH key path |
| `NewRootCmd()` | Create root cobra command with all subcommands registered |

### Commands

| File | Command | Subcommands |
|------|---------|-------------|
| `cmd_init.go` | `init [host]` | SSH trust + Docker setup |
| `cmd_sync.go` | `sync pull/push <host>` | Config sync |
| `cmd_dns.go` | `dns list/add/remove/push` | DNS management |
| `cmd_site.go` | `site list/deploy/push` | Site management |
| `cmd_bundle.go` | `bundle <name> <action> <host>` | Bundle orchestration |
| `cmd_stack.go` | `stack install <host> <app>` | Binary installation |
| `cmd_service.go` | `service <host> <action> <svc>` | Service control |
| `cmd_n8n.go` | `n8n list/import/export/update` | n8n workflows |
| `cmd_nas.go` | `nas info/pool/dataset/snapshot` | TrueNAS management |
| `cmd_backup.go` | `backup <host>` | Host backup |
| `cmd_exec.go` | `exec <host> <cmd>` | Remote command |
| `cmd_key.go` | `key rotate/status` | SSH key management |

### Version Variables

Set via Makefile ldflags:

```go
var Version   = "1.0.0"    // -X internal/cli.Version=...
var BuildTime = "unknown"   // -X internal/cli.BuildTime=...
var GitCommit = "unknown"   // -X internal/cli.GitCommit=...
```

---

## pkg/utils

Logger with timestamps and colors.

| Type/Function | Description |
|---------------|-------------|
| `Logger` | Structured logger with level filtering |
| `LogLevel` | Levels: `Info`, `Warn`, `Error`, `Success`, `Step` |
| `NewLogger()` | Create logger (stdout, Info level) |
| `logger.SetOutput(w)` | Redirect output |
| `logger.Info/Warn/Error/Success/Step(format, args...)` | Level-specific logging |
| `logger.Fatal(format, args...)` | Log error and exit(1) |
| `DefaultLogger` | Package-level singleton |
| `Info/Warn/Error/Success/Step/Fatal(format, args...)` | Package-level convenience functions |

Output format: colored prefix + timestamp + message. Respects `NO_COLOR` and non-TTY.

---

## pkg/sops

SOPS encryption wrapper for age-encrypted config files.

| Type/Function | Description |
|---------------|-------------|
| `Manager` | SOPS manager with age key path |
| `NewManager(ageKeyPath)` | Create manager |
| `manager.IsEncrypted(path)` | Check if file contains SOPS markers |
| `manager.Decrypt(encryptedPath)` | Decrypt file to memory |
| `manager.DecryptToFile(encryptedPath, outputPath)` | Decrypt to file |
| `manager.Encrypt(inputPath, outputPath)` | Encrypt file |
| `manager.ProcessEncryptedFiles(dir, processFn)` | Batch process `.enc` files in directory |
| `EnsureSOPSInstalled()` | Check `sops` binary availability |
| `GenAgeKey(outputPath)` | Generate new age key pair |
