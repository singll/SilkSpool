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

features:                         # Optional capabilities
  docker_log_rotation: true       # Configure Docker log rotation on host
  git_clone:                      # Clone a repo during init
    repo: https://github.com/user/repo.git
    path: repo-dir                # Relative to deploy path
  docker_prune: true              # Run docker system prune during init
  create_network: my-network      # Create a Docker network

defaults:                         # Default config files to create
  - path: .env                    # Relative to deploy path
    content: |                    # File content (multiline)
      KEY=value
      ANOTHER_KEY=another_value

templates:                        # Compose files (compose type) or systemd units (stack type)
  - 00-base.yaml                  # Order matters: base first
  - 10-app.yaml

services:                         # Service names for status reporting
  - app
  - app-db
```

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

Environment variables from `hosts/<host>/.env` are available at runtime via Docker Compose's built-in `.env` loading.

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
   spool exec myhost "docker compose -f /opt/silkspool/mybundle/docker-compose.yaml ps"
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
