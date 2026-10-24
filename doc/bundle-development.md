# Bundle Development / Bundle 开发指南

How to create, test, and deploy a new bundle.

---

## Bundle Directory Structure / 目录结构

```
bundles/<name>/
├── manifest.yaml          # Bundle metadata and features
└── templates/             # Docker Compose or systemd templates
    ├── 00-base.yaml       # Networks and volumes
    ├── 10-service1.yaml   # Service definitions
    └── 20-service2.yaml   # More services
```

## manifest.yaml Format / 格式说明

```yaml
name: mybundle                    # Bundle name (defaults to directory name)
type: compose                     # compose | stack

# 配置作用域（默认 host，兼容旧布局）:
#   host   -> hosts/<host>/<path>
#   bundle -> hosts/<host>/<bundle>/<path>（推荐，多 bundle 共存）
config_root: bundle

features:                         # Optional capabilities
  docker_log_rotation: true       # Configure Docker log rotation on host
  git_clone:                      # Clone a repo during init
    repo: https://github.com/user/repo.git
    path: repo-dir                # Relative to deploy path
  docker_prune: true              # Run docker system prune during init
  create_network: my-network      # Create a Docker network

defaults:                         # Default config files to create (never overwrite existing)
  - path: .env                    # Relative to deploy path
    content: |                    # File content (multiline)
      KEY=value
      ANOTHER_KEY=another_value

# Bundle 自带的同步规则。local 相对于配置根目录，remote 支持 ${deploy_path}/${host}。
# defaults 中的 .env 会自动推送到 ${deploy_path}/.env；显式规则优先。
sync_rules:
  - local: n8n-workflows/
    remote: ${deploy_path}/n8n-workflows/

templates:                        # Compose files (compose type) or systemd units (stack type)
  - 00-base.yaml                  # Order matters: base first
  - 10-app.yaml

services:                         # Service names for status reporting
  - app
  - app-db
```

### 配置作用域与同步

- `config_root: bundle` 时，`defaults` 写到 `hosts/<host>/<bundle>/`，多个 bundle 在
  同一主机上不会互相覆盖 `.env`。
- 若旧布局 `hosts/<host>/.env` 已存在，初始化会跳过 bundle 作用域副本，同步阶段
  自动回退到旧路径，保证平滑迁移。
- `manifest.sync_rules` 由 `spool bundle up/setup` 自动推送，失败会让命令整体失败。
- 声明了 `.env` default 时，spool 自动推送 `deploy_path/.env`，不需要在
  `silkspool.yaml` 里写 host 级 `sync_rules`。

### Bundle Types / 类型

| Type | Driver | Description |
|------|--------|-------------|
| `compose` | `ComposeDriver` | Docker Compose deployment. Templates are YAML compose files. |
| `stack` | `StackDriver` | Binary installation from GitHub releases. Templates are systemd unit files. |

## 轻契约 Manifest（P1）

新 bundle 推荐使用以下结构；旧扁平字段（`name/type/templates/services/features/defaults`）继续兼容。

```yaml
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: bellkeeper
  class: product          # product | composition | capability | infrastructure | tool
  version: 2.4.0          # 精确版本或 digest，禁止 latest/范围
  owner: singll/Bellkeeper
  labels:
    io.silkspool.product: bellkeeper
spec:
  delivery:
    driver: compose       # compose | stack | script
    templates: [compose.yaml]

  outputs:
    health: "${input.public_url}/api/health"
    internal:
      kind: endpoint
      service: bellkeeper
      port: 8080
      remote: "${host.magicdns}"

  lifecycle:
    health:
      http: "${outputs.health}"
      from: container     # container | host
      exec_in: bellkeeper # command 时在哪个容器内执行
      timeout: 60s
    upgrade:
      strategy: recreate  # recreate | rolling | backup-then-recreate
      irreversible: false
    hooks:
      pre_upgrade: scripts/pre-upgrade.sh
      post_upgrade: scripts/post-upgrade.sh
    restore:
      hook: scripts/restore.sh   # 可选；缺省时 restore 为人工流程

  backup:
    hook: scripts/backup.sh      # 一致性备份入口；SPOOL_BACKUP_DIR/SPOOL_GENERATION
    assets:
      - type: volume
        source: kp-bellkeeper-uploads
```

### composition：components vs dependencies

- `components`：由本 composition 部署，**全部位于 apply 的目标 host**。
- `dependencies`：已在别处部署，只读 `outputs`；绝不 apply/升级/回滚。
- `wiring` 只能引用 `components.<key>.outputs.*` / `dependencies.<key>.outputs.*`；
  未解析引用在 plan 阶段直接失败。

```yaml
spec:
  components:
    bellkeeper:
      bundle: bellkeeper
      version: 2.4.0
      source: {type: git, repo: https://github.com/singll/Bellkeeper.git, path: deploy, commit: <sha>}
      health: {http: "http://127.0.0.1:8080/api/health", from: container}
    n8n:
      image: docker.n8n.io/n8nio/n8n:1.62.1@sha256:...
      after: [bellkeeper]     # 只影响同 host 组件顺序，不参与依赖解析
      optional: true          # 失败只告警，但仍会部署
  dependencies:
    data:
      bundle: silkdata
      version: 1.2.0
      host: silkdata          # provider 主机，用于 endpoint 拓扑
      outputs: [postgres, redis]
  wiring:
    n8n:
      BELLKEEPER_URL: "http://${components.bellkeeper.outputs.internal.host}:${components.bellkeeper.outputs.internal.port}"
      DB_HOST: "${dependencies.data.outputs.postgres.host}"
      N8N_ENCRYPTION_KEY: "${secrets.n8n_encryption_key}"
```

endpoint 解析规则：

| 场景 | host | port |
|---|---|---|
| 同 host + 同 compose project | 服务名 | 容器端口 |
| 同 host + 不同 project | 共享网络时服务名，否则 `host.address` | 容器端口或 `published_port` |
| 跨 host | `remote` → MagicDNS → `host.address` | `published_port` |

`${host.magicdns}` 来自 `silkspool.yaml` 的 `hosts.<name>.magicdns`；跨机两者都缺失时 plan 失败。
`secrets.*` 在 plan/lock 中只写 `secret://...` 占位，apply 时才从主机 `.env` 解析。

### plan / apply / rollback

```bash
spool plan mybundle myhost --offline     # 静态校验：合法 0，非法 2
spool plan mybundle myhost --json        # online diff：有 diff 退出 3
spool apply mybundle myhost --yes
spool apply mybundle myhost --locked --yes
spool rollback mybundle myhost [generation]
```

部署后远端目录：

```text
/opt/silkspool/mybundle/
├── docker-compose.yaml
├── docker-compose.spool.yaml
├── .env
├── .spool-gen/<n>/        # compose/env/digest/meta/lock 快照（保留 current + 上一代）
└── backups/               # backup.hook 产物
```

本地 `.spool/lock/`、`.spool/state/`、`.spool/cache/` 均为可重建缓存，已在 `.gitignore` 中。

### bundle_sources

```yaml
bundle_sources:
  - name: mybundle
    type: dir              # dir | git
    path: ./bundles
  - name: bellkeeper
    type: git
    repo: https://github.com/singll/Bellkeeper.git
    path: deploy
    commit: <pinned-sha>   # 必须固定 commit，不能写分支/latest
```

---

## Compose Template Variables / 模板变量

Templates are Docker Compose YAML files. Use these variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `${APP_PREFIX}` | `sp-` | Container name prefix from host config |
| `${APP_PREFIX:-sp-}` | `sp-` | With fallback (recommended) |

Environment variables from the bundle's config directory are pushed to `<deployPath>/.env`
and available at runtime via Docker Compose's built-in `.env` loading.

### 渲染方式：模板 + override

spool 不再把多个模板 deepMerge 成一个文件。远端目录保持“文件即真相”：

```text
/opt/silkspool/mybundle/
├── 00-base.yaml                 # 原始模板（单模板时 docker-compose.yaml 即其副本）
├── 10-app.yaml
├── docker-compose.yaml          # 入口：单模板为副本，多模板为 include 列表
├── docker-compose.spool.yaml    # spool 生成：io.silkspool.* 标签等
└── .env
```

运行时等价于：

```bash
docker compose -f docker-compose.yaml -f docker-compose.spool.yaml up -d
```

因此仍可手动执行普通 `docker compose`；spool 注入项集中在 override 中，diff 清晰。
多模板使用 Compose 原生 `include`，相对挂载/构建路径仍以 deployPath 为 project directory。

### 镜像固定

第三方镜像必须使用精确 tag + digest（`image: repo/name:tag@sha256:...`）。
本地构建的镜像无法预先写 digest，使用显式版本 tag，禁止 `latest`/`stable`。

### Template Example / 模板示例

```yaml
# 00-base.yaml
name: mybundle

networks:
  my-network:
    driver: bridge

volumes:
  my-data:
```

```yaml
# 10-app.yaml
services:
  app:
    image: myapp:latest
    container_name: ${APP_PREFIX:-sp-}myapp
    restart: unless-stopped
    volumes:
      - my-data:/data
    networks:
      - my-network
    env_file:
      - .env
```

## Adding a Bundle to a Host / 关联主机

In `silkspool.yaml`:

```yaml
hosts:
  myhost:
    address: "user@1.2.3.4"
    app_prefix: "sp-"
    bundles: ["mybundle"]          # Add bundle name here
    services:
      - alias: "myapp"
        type: "docker"
        name: "sp-myapp"
```

## Bundle Lifecycle / 生命周期

```bash
spool bundle mybundle init myhost     # Setup: create dirs, push templates, create .env
spool bundle mybundle up myhost       # Start: docker compose up -d
spool bundle mybundle status myhost   # Status: docker compose ps
spool bundle mybundle down myhost     # Stop: docker compose down (⚠️ removes containers)
```

> **Warning**: `bundle down` stops and removes containers. For services with persistent data (n8n, databases), use `spool service <host> stop <svc>` instead.

## Testing a Bundle Locally / 本地测试

1. Build and deploy:
   ```bash
   make all                                    # Copies bundles to out/
   spool bundle mybundle init myhost            # Initialize on test host
   spool bundle mybundle up myhost              # Start services
   spool service myhost status                  # Check status
   ```

2. Verify compose files on remote:
   ```bash
   spool exec myhost "cat /opt/silkspool/mybundle/docker-compose.yaml"
   spool exec myhost "cat /opt/silkspool/mybundle/docker-compose.spool.yaml"
   spool exec myhost "docker compose -f /opt/silkspool/mybundle/docker-compose.yaml -f /opt/silkspool/mybundle/docker-compose.spool.yaml ps"
   ```

3. Check logs:
   ```bash
   spool logs myhost myapp 100
   ```

## Example: Minimal "hello" Bundle / 示例

### `bundles/hello/manifest.yaml`

```yaml
name: hello
type: compose
defaults:
  - path: .env
    content: |
      GREETING=Hello from SilkSpool
templates:
  - 10-hello.yaml
services:
  - hello
```

### `bundles/hello/templates/10-hello.yaml`

```yaml
services:
  hello:
    image: alpine:latest
    container_name: ${APP_PREFIX:-sp-}hello
    restart: "no"
    command: ["sh", "-c", "echo $GREETING && sleep 5"]
    env_file:
      - .env
```

### Deploy

```bash
# Add to silkspool.yaml
# bundles: ["hello"]

make all
spool bundle hello init myhost
spool bundle hello up myhost
spool logs myhost hello
```

## Stack Bundles / 二进制栈 Bundle

For hosts that run systemd services (VPS, bare metal):

```yaml
# bundles/server/manifest.yaml
name: server
type: stack
templates:                    # Systemd unit files
  - caddy.service
  - headscale.service
services:
  - caddy
  - headscale
```

Stack bundles use `install_sources` from `silkspool.yaml` to download binaries:

```yaml
install_sources:
  - alias: "caddy"
    repo: "caddyserver/caddy"
    pattern: "linux_{ARCH}.tar.gz"
    service_name: "caddy"
    default_version: "latest"
```

Placeholder expansion:
- `{ARCH}` → `amd64` (detected from remote host)
- `{VERSION}` → resolved from GitHub releases or `default_version`

## Custom Drivers / 自定义驱动

P1 起公开接口位于 `pkg/driver`（协议版本 + 能力协商，编译期注册）：

```go
driver.Register("mydriver", func(opts driver.Options) driver.BundleDriver {
    return &MyDriver{...}
})
```

驱动必须声明协议版本与能力，并实现旧方法形态（参数为 `driver.HostConfig`）：

```go
type BundleDriver interface {
    ProtocolVersion() string
    Capabilities() []driver.Capability
    Setup(host string, hostCfg *driver.HostConfig, deployPath string) error
    Up(host string, hostCfg *driver.HostConfig, deployPath string) error
    Down(host string, hostCfg *driver.HostConfig, deployPath string) error
    Status(host string, hostCfg *driver.HostConfig, deployPath string) error
    Cleanup(host string, hostCfg *driver.HostConfig, deployPath string, mode string) error
    Service(host string, hostCfg *driver.HostConfig, deployPath string, svc string, action string) error
    Upgrade(host string, hostCfg *driver.HostConfig, deployPath string, force bool) error
}
```

`internal/engine` 的 compose/stack/script 驱动在编译期注册自身适配器；旧调用
（`engine.GetDriver` / `engine.RegisterDriver`）继续可用。不支持的动词必须返回明确的
`unsupported`，不要静默成功。
