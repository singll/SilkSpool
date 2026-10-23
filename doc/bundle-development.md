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

Register a custom bundle driver:

```go
engine.RegisterDriver("mydriver", func(baseDir, sshKey, bundleName string, defaults config.DefaultsConfig) engine.BundleDriver {
    return &MyDriver{...}
})
```

The driver must implement `BundleDriver`:

```go
type BundleDriver interface {
    Setup(host string, hostCfg *config.HostConfig, deployPath string) error
    Up(host string, hostCfg *config.HostConfig, deployPath string) error
    Down(host string, hostCfg *config.HostConfig, deployPath string) error
    Status(host string, hostCfg *config.HostConfig, deployPath string) error
    Cleanup(host string, hostCfg *config.HostConfig, deployPath string, mode string) error
    Service(host string, hostCfg *config.HostConfig, deployPath string, svc string, action string) error
}
```
