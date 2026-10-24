# API Reference / API 参考

---

# 本地 HTTP/JSON API（spool serve，P2）

> 完整端点、安全与消费方示例；Go package 参考在本文后半部分。

## 概览

`spool serve` 是可选的本地 HTTP/JSON 服务，用于让 n8n、Bellkeeper、CI 等消费方在不直接 SSH
的前提下读取 inventory、触发 plan/apply/rollback 并轮询 job。

```bash
spool serve --socket /run/spool.sock
# 可选
spool serve --socket /run/spool.sock --token "$SPOOL_TOKEN" --audit-log /var/log/spool-audit.log
```

---

## 安全模型

| 项 | 行为 |
|---|---|
| socket | 固定 `0600`，默认只允许当前用户 |
| token | 可选；设置后所有端点（除 `/healthz`）要求 `Authorization: Bearer <token>` |
| scope | P2 裁剪为单 token（等价 `admin`）；不实现 read/deploy/admin 多 token |
| 危险动作 | `bundle.apply` / `bundle.rollback` 必须 `options.yes=true`，或带 `X-Spool-Approval: <token>` |
| actor | 审计 actor 取 `X-Spool-Actor`；缺省 `local`（有 token 时为 `token`） |
| 审计 | JSON Lines，记录 actor、action、target、idempotency_key、job_id、state、error |

> P3 提供 `api/openapi.yaml` 与生成的 `pkg/apiclient`；不提供 Events/SSE/Webhook（尚无真实订阅者）。

---

## 端点

### GET /healthz

```json
{"status":"ok"}
```

### GET /v1/inventory

返回主机、bundle、服务以及资源适配器（Bundle/Service/DNSRecord/Site/Dataset/Key）状态。
`sensitive` 字段只返回 `secret://...` 引用，不返回明文。

默认只读本地配置与 state（Dataset 返回 `declared` 占位，Key 返回 `declared`）。
加 `?probe=true` 才会连接 TrueNAS/SSH 获取 Dataset/Key 实际状态；探测失败会以
`status=error` 和 `outputs.error` 返回，不伪造成功。

### GET /v1/hosts/{host}/bundles/{bundle}

返回 bundle manifest 摘要、components/dependencies、逻辑 outputs、lock 中的 resolved outputs、
本地 state/generation。

### GET /v1/hosts/{host}/bundles/{bundle}/outputs

默认返回逻辑声明（endpoint 的 service/port 等）；加 `?resolved=true` 返回 lock 中的拓扑解析结果。

```json
{
  "host": "keeper",
  "bundle": "knowledge-stack",
  "resolved": true,
  "outputs": {
    "components.bellkeeper.internal": "bellkeeper:8080",
    "dependencies.data.postgres": "silkdata-magic:5432"
  }
}
```

### POST /v1/actions

```json
{
  "action": "bundle.apply",
  "target": {"host": "keeper", "bundle": "knowledge-stack"},
  "options": {"locked": true, "yes": true},
  "idempotency_key": "deploy-2026-10-23-001"
}
```

支持 action：

| action | 说明 |
|---|---|
| `bundle.plan` | `options.offline=true` 时只做静态校验；否则 SSH online diff |
| `bundle.apply` | 单 host、components only；dependencies 只读 outputs |
| `bundle.rollback` | `options.generation` 可选，缺省回滚到 current-1 |

响应 `202 Accepted`：

```json
{"job_id":"job_ab12cd34ef56","state":"queued"}
```

相同 `idempotency_key` 在 job 未完成（queued/running）时复用同一 job，并返回
`"idempotent_reuse": true`。完成后同 key 可创建新 job。

### GET /v1/jobs/{id}

```json
{
  "id": "job_ab12cd34ef56",
  "action": "bundle.apply",
  "target": {"host": "keeper", "bundle": "knowledge-stack"},
  "state": "succeeded",
  "started_at": "2026-10-24T10:00:00Z",
  "finished_at": "2026-10-24T10:01:12Z",
  "result": {"generation": 7, "status": "healthy"}
}
```

状态：`queued → running → succeeded/failed`。失败时 `error` 为错误文本。

---

## 并发与锁

- 同 host job 通过进程内队列串行；`bundle.apply` 同时使用 `.spool/locks/<host>.lock`，
  与其他 spool 进程互斥（serve 内 apply 等待上限 10 分钟）。
- 不同 host 并行。
- job 失败/中断后锁释放；必要时 `spool unlock <host>`。

---

## 消费方示例

### n8n HTTP 节点

1. `POST /v1/actions`，Header `Idempotency-Key: {{ $execution.id }}`（或固定部署 key），
   body 使用 `bundle.apply` + `options.yes=true`。
2. 读取响应 `job_id`。
3. 轮询 `GET /v1/jobs/{job_id}`，直到 `succeeded` / `failed`；失败时把 `error` 写入告警。

> n8n 只需要挂载/访问 Unix socket，不必持有 SSH 私钥。

### Bellkeeper

- Bellkeeper 仓库发布 `deploy/bundle.yaml`（product），在 `silkspool.yaml` 的
  `bundle_sources` 固定 commit。
- 读取契约：`GET /v1/hosts/keeper/bundles/bellkeeper/outputs?resolved=true`。
- 触发部署：`POST /v1/actions` `bundle.apply`，不要直接 SSH。
- 产品自身健康/备份/恢复由 product manifest 声明，spool 调用其 hook。

### CI/CD

```bash
# PR：只做静态校验（合法 0，非法 2，永不返回 3）
spool plan knowledge-stack keeper --offline --json

# 部署门禁：online plan 有 drift 时退出 3
spool plan knowledge-stack keeper --json

# 可复现部署
spool apply knowledge-stack keeper --locked --yes

# 或通过本地 API
curl --unix-socket /run/spool.sock -H 'Content-Type: application/json' \
  -d '{"action":"bundle.apply","target":{"host":"keeper","bundle":"knowledge-stack"},"options":{"locked":true,"yes":true},"idempotency_key":"ci-'$GITHUB_RUN_ID'"}' \
  http://localhost/v1/actions
```

---

## OpenAPI 与生成客户端（P3）

规范文件：`api/openapi.yaml`，覆盖：

| Path | Operation |
|---|---|
| `GET /healthz` | `getHealth` |
| `GET /v1/inventory` | `getInventory` |
| `GET /v1/hosts/{host}/bundles/{bundle}` | `getBundle` |
| `GET /v1/hosts/{host}/bundles/{bundle}/outputs` | `getBundleOutputs` |
| `POST /v1/actions` | `submitAction` |
| `GET /v1/jobs/{id}` | `getJob` |

客户端由规范生成，不手写：

```bash
make openapi
# 等价于：
go run ./internal/openapigen/main -spec api/openapi.yaml -out pkg/apiclient/client.gen.go
```

生成物在 `pkg/apiclient/client.gen.go`。`pkg/apiclient.NewUnixClient` 只负责配置
Unix socket transport，HTTP 方法/类型全部来自 OpenAPI 生成器，因此与本文档和
`spool serve` 路由保持一致。示例：

```go
client := apiclient.NewUnixClient("/run/spool.sock")
inventory, err := client.GetInventory(ctx, nil)
job, err := client.GetJob(ctx, accepted.JobID)
```

CI 应运行 `go test ./internal/openapigen ./pkg/apiclient`；生成物过期会直接失败。

---

## 错误格式

```json
{"error":{"code":"approval_required","message":"dangerous action requires options.yes=true or approval token"}}
```

| code | HTTP | 说明 |
|---|---|---|
| `unauthorized` | 401 | token 缺失/错误 |
| `approval_required` | 403 | 危险动作缺少 yes/审批 token |
| `invalid_request` | 400 | action/target/body 非法 |
| `unknown_host` | 404 | 主机不存在 |
| `unknown_bundle` | 404 | bundle 不存在 |
| `job_not_found` | 404 | job 不存在 |


---



Go package documentation for SilkSpool internals.

---

## internal/config

Configuration loading and type definitions.

### Types

| Type | Description |
|------|-------------|
| `Config` | Root structure for `silkspool.yaml`. Contains `Global`, `Hosts`, `InstallSources`, `N8N`, `TrueNAS`. |
| `GlobalConfig` | Global settings: `SSHKeyPath`, `AgeKeyPath`, `DefaultDomain`, `BackupDir`, `DNSGatewayIP`, `DNSGatewayHost`, `DNSHeadscaleHost`, `DNSHeadscaleServer`, `Timeouts`, `Defaults`. |
| `HostConfig` | Per-host configuration: `Address`, `SSHPort`, `AppPrefix`, `MagicDNS`, `Inputs`, `Bundles`, `SyncRules`, `Services`, `PostPushHooks`, `Backups`, `Stack`. |
| `SyncRule` | Sync mapping: `Local` (relative path) ↔ `Remote` (absolute path). |
| `ServiceEntry` | Service registration: `Alias`, `Type` (docker/systemd/initd/openwrt), `Name`. |
| `PostPushHook` | Push hook: `Pattern` (file match), `Command` (remote command). |
| `BackupRule` | Backup definition: `Type` (volume/dir/db-mysql), `Source`, `Name`. |
| `InstallSource` | Release source: `Alias`, `Repo`, `Pattern`, `ServiceName`, `DefaultVersion`. |
| `N8NConfig` | n8n integration: `Host`, `Container`, `WorkflowDir`, `APIURL`. |
| `TrueNASConfig` | TrueNAS integration: `Host`, `APIURL`, `Username`. |
| `TimeoutConfig` | Timeouts: `SSHConnect`, `HTTPClient`. |
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
| `BundleManifest` | Bundle metadata: `Name/Class/Version`, `Delivery/Outputs/Lifecycle/Backup`, `Components/Dependencies/Wiring`, `AliasOf`. |
| `ResolvedPlan` | Resolver output: components/dependencies, rendered compose/override, lock, component lifecycles. |
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
| `cmd_bundle_updates.go` | `bundle check-updates <name>` | Pinned image update suggestions |
| `cmd_plan.go` | `plan <bundle> <host> [--offline]` | Static validation / online diff |
| `cmd_apply.go` | `apply <bundle> <host> [--locked]` | Apply components on one host |
| `cmd_rollback.go` | `rollback <bundle> <host> [gen]` | Restore remote generation |
| `cmd_serve.go` | `serve --socket <path>` | Optional local Unix-socket API |
| `cmd_adopt.go` | `adopt <host>` | Read-only adoption of an existing compose stack |
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
