# SilkSpool V2 重构计划与进度

> 创建时间: 2026-05-30
> 最后更新: 2026-05-30
> 目标: 将 Bash/Python 轻量级 IaC 编排工具重构为 Go 语言单体二进制 CLI 工具

---

## 一、重构背景与目标

### 1.1 当前系统痛点

| 痛点 | 现状 | 重构目标 |
|------|------|---------|
| 依赖 Bash 环境 | config.ini 依赖 `source` 加载 | Go struct 强类型 |
| Python 魔法 | n8n.sh/truenas_rpc.py 用 Python 处理 JSON | Go 原生 `encoding/json` |
| 外部工具依赖 | 需要宿主机安装 `yq` | Go `gopkg.in/yaml.v3` 原生解析 |
| 文本替换脆弱性 | sed 修改 dnsmasq/headscale 配置 | 结构化 YAML 操作 |
| 跨平台性差 | 仅 Linux/macOS Bash | Go 编译为单一二进制 |

### 1.2 重构原则

- **保持业务逻辑 100% 兼容**: 模板、环境变量、部署流程不变
- **禁止过度设计**: 拒绝重度框架，保持极客美学
- **过渡策略**: Strangler Fig 模式，逐步替换底层执行引擎

---

## 二、技术栈

```
语言:           Go 1.22+
CLI 框架:       github.com/spf13/cobra (v1.8.1)
配置管理:       github.com/spf13/viper (v1.18.2)
YAML 解析:      gopkg.in/yaml.v3 (v3.0.1)
SSH 引擎:       golang.org/x/crypto/ssh (v0.31.0)
WebSocket:      github.com/gorilla/websocket (v1.5.3)
终端着色:       github.com/fatih/color (v1.18.0)
```

---

## 三、目录结构

### 代码仓库结构

```
SilkSpool/                      # Git 管理的代码仓库
├── cmd/spool/                  # CLI 入口
├── internal/                    # 核心模块
│   ├── config/                 # 配置加载
│   ├── engine/                 # IaC 引擎
│   │   ├── dns.go             # DNS 管理
│   │   ├── sync.go           # 配置同步
│   │   ├── bundle.go         # Bundle 编排
│   │   ├── backup.go         # 备份管理
│   │   ├── init.go           # 主机初始化
│   │   └── ...
│   └── tools/                  # 外部工具客户端
├── pkg/                        # 共享包
│   ├── sops/                  # SOPS 加密
│   ├── ssh/                   # SSH 封装
│   └── utils/                 # 日志/工具
├── bundles/                    # Bundle 模板 (与代码同目录)
├── silkspool.yaml.example     # 配置模板
└── doc/DEPLOYMENT.md          # 部署指南
```

### 用户运行环境 (不 git)

```
~/.silkspool/                   # 用户配置目录
├── silkspool.yaml               # 主配置文件
├── keys/                       # SSH 密钥
│   ├── id_silkspool
│   └── age.key                # SOPS 密钥
├── hosts/                      # 主机特定配置
└── backups/                   # 备份存储
```

### 二进制部署

```
/usr/local/bin/spool            # 可执行文件 (PATH 中)
或
./spool                          # 代码仓库中直接运行
```

---

## 四、配置文件结构 (silkspool.yaml)

### 4.1 完整结构

```yaml
# -------------------- 全局配置 --------------------
global:
  ssh_key_path: "./keys/id_silkspool"
  default_domain: "singll.net"
  backup_dir: "~/silkspool_backups"
  dns_gateway_ip: "192.168.7.1"
  dns_headscale_server: "100.100.100.100"

# -------------------- 主机清单 --------------------
hosts:
  keeper:
    address: "silkspool@192.168.7.230"
    app_prefix: "sp-"
    bundles: ["keeper"]
    sync_rules:
      - local: ".env"
        remote: "/opt/silkspool/keeper/.env"
      - local: "n8n-workflows/"
        remote: "/opt/silkspool/keeper/n8n-workflows/"
    services:
      - alias: "n8n"
        type: "docker"
        name: "sp-n8n"
      - alias: "bellkeeper"
        type: "docker"
        name: "sp-bellkeeper"
    backups:
      - type: "volume"
        source: "kp-n8n-data"
        name: "n8n-backup"
    post_push_hooks:
      - pattern: ".env"
        command: "docker exec sp-n8n restart"

# -------------------- 安装源 --------------------
install_sources:
  - alias: "caddy"
    repo: "caddyserver/caddy"
    pattern: "linux_{ARCH}.tar.gz"
    service_name: "caddy"
    default_version: "latest"

  - alias: "headscale"
    repo: "juanfont/headscale"
    pattern: "linux_{ARCH}$"
    service_name: "headscale"
    default_version: "v0.22.3"

# -------------------- n8n / TrueNAS 配置 --------------------
n8n:
  host: "keeper"
  container: "sp-n8n"
  workflow_dir: "/opt/silkspool/keeper/n8n-workflows"
  api_url: "http://localhost:5678"

truenas:
  host: "truenas"
  api_url: "https://192.168.7.121"
  username: "admin"
```

### 4.2 Go Struct 定义

```go
// internal/config/types.go

type Config struct {
    Global         GlobalConfig              `yaml:"global"`
    Hosts          map[string]HostConfig   `yaml:"hosts"`
    InstallSources []InstallSource          `yaml:"install_sources"`
    N8N            N8NConfig               `yaml:"n8n"`
    TrueNAS        TrueNASConfig           `yaml:"truenas"`
}

type HostConfig struct {
    Address       string          `yaml:"address"`
    AppPrefix     string          `yaml:"app_prefix"`
    Bundles       []string       `yaml:"bundles"`
    SyncRules     []SyncRule     `yaml:"sync_rules"`
    Services      []ServiceEntry `yaml:"services"`
    PostPushHooks []PostPushHook  `yaml:"post_push_hooks"`
    Backups       []BackupRule   `yaml:"backups"`
    Stack         []string       `yaml:"stack"`
}

type SyncRule struct {
    Local  string `yaml:"local"`
    Remote string `yaml:"remote"`
}

type ServiceEntry struct {
    Alias string `yaml:"alias"`
    Type  string `yaml:"type"`  // docker | systemd | initd
    Name  string `yaml:"name"`
}
```

---

## 五、重构阶段与进度

### Phase 1: CLI 骨架与配置迁移 ✅ 已完成

**目标**: 初始化 Go 项目结构，创建 Cobra CLI 入口

**完成内容**:
- [x] 初始化 `go mod init`
- [x] 创建 `cmd/spool/main.go` - Cobra CLI 入口
- [x] 实现 `internal/config/config.go` - Viper 配置加载
- [x] 实现 `internal/config/types.go` - 强类型 Struct
- [x] 创建 `silkspool.yaml.example` - 新配置文件示例
- [x] 实现 `pkg/utils/logger.go` - 终端日志（兼容旧格式）

**过渡策略**: 尚未用 Go 实现的命令，透传到旧脚本

```bash
./spool-v2 sync pull keeper  # 透传到 lib/core/sync.sh
./spool-v2 dns deploy xxx    # 透传到 lib/core/dns.sh
```

---

### Phase 2: 砍掉 Python 魔法 ✅ 已完成

**目标**: 重写 n8n 与 TrueNAS 工具为 Go 原生实现

**完成内容**:

#### 2.1 n8n Go 客户端 (`internal/tools/n8n.go`)
- [x] 原生 HTTP API 调用（替代 Python curl）
- [x] JSON 序列化/反序列化（替代 Python json）
- [x] 工作流 CRUD 操作
- [x] 本地文件加载与清理

**核心函数**:
```go
type N8NClient struct {
    baseURL   string
    apiKey    string
    httpClient *http.Client
}

func (c *N8NClient) ListWorkflows(ctx context.Context) ([]N8NWorkflow, error)
func (c *N8NClient) CreateWorkflow(ctx context.Context, wf *N8NWorkflow) (*N8NWorkflow, error)
func (c *N8NClient) UpdateWorkflow(ctx context.Context, id string, wf *N8NWorkflow) (*N8NWorkflow, error)
func (c *N8NClient) ActivateWorkflow(ctx context.Context, id string) error
func (c *N8NClient) DeactivateWorkflow(ctx context.Context, id string) error
```

#### 2.2 TrueNAS Go 客户端 (`internal/tools/truenas.go`)
- [x] gorilla/websocket 实现 WebSocket 连接
- [x] JSON-RPC 协议封装
- [x] API Key 认证
- [x] 作业等待机制

**核心函数**:
```go
type TrueNASClient struct {
    apiURL   string
    apiKey   string
    conn     *websocket.Conn
}

func (c *TrueNASClient) GetSystemInfo() (*TrueNASSystemInfo, error)
func (c *TrueNASClient) ListPools() ([]TrueNASPool, error)
func (c *TrueNASClient) ListDatasets() ([]TrueNASDataset, error)
func (c *TrueNASClient) ListSnapshots(pool string) ([]TrueNASSnapshot, error)
func (c *TrueNASClient) WaitForJob(jobID int, timeout time.Duration) (*TrueNASJob, error)
```

---

### Phase 3: 重构核心 IaC 引擎 ✅ 已完成

**目标**: 用 Go 原生实现替代 Bash 脚本中的核心功能

#### 3.1 DNS 管理器 (`internal/engine/dns.go`)
- [x] 结构化 DNS 记录读取（dnsmasq/OpenClash/Headscale）
- [x] 正则表达式解析（替代 sed 文本替换）
- [x] 幂等添加/删除记录
- [x] Caddyfile 域名同步

**改进点**: 严禁使用文本替换（sed）修改 YAML，改用正则表达式结构化修改

#### 3.2 同步管理器 (`internal/engine/sync.go`)
- [x] rsync 封装（保留 `--rsync-path='sudo rsync'` 提权特性）
- [x] Post-Push Hooks 执行
- [x] 批量同步支持

**关键**: 文件传输必须使用 `os/exec` 封装调用宿主机的 `rsync` 命令

#### 3.3 Bundle 管理器 (`internal/engine/bundle.go`)
- [x] YAML 模板合并（`gopkg.in/yaml.v3` 替代 `yq`）
- [x] 深度合并算法
- [x] 远程脚本执行与占位符替换
- [x] Stack 安装数据生成

**改进点**: 不再依赖宿主机的 `yq` 命令，Go 原生完成 YAML 解析

#### 3.4 SSH 客户端 (`internal/engine/ssh.go`)
- [x] `golang.org/x/crypto/ssh` 原生实现
- [x] 密钥认证支持
- [x] 命令执行与 stdin 流式传输
- [x] 文件上传

#### 3.5 服务管理器 (`internal/engine/service.go`)
- [x] Docker 容器控制
- [x] Systemd 服务控制
- [x] OpenWrt init.d 控制
- [x] 日志获取

#### 3.6 安装管理器 (`internal/engine/install.go`)
- [x] 动态下载器（GitHub API 获取最新版本）
- [x] 架构自动检测
- [x] systemd 服务文件生成
- [x] 批量安装栈

---

### Phase 4: SOPS 集成与旧脚本清理 ✅ 已完成 (2026-05-30)

**目标**: 敏感配置加密 + 清理旧脚本

#### 已删除脚本

| 旧脚本 | Go 替代 | 删除日期 |
|--------|---------|----------|
| `lib/core/runner.sh` | `engine/bundle.go` | 2026-05-30 |
| `lib/core/sync.sh` | `engine/sync.go` | 2026-05-30 |
| `lib/core/dns.sh` | `engine/dns.go` + `engine/site.go` | 2026-05-30 |
| `lib/core/service.sh` | `engine/service.go` | 2026-05-30 |
| `lib/core/backup.sh` | `engine/backup.go` | 2026-05-30 |
| `lib/core/ssh.sh` | `engine/ssh.go` (init 提示) | 2026-05-30 |
| `lib/core/utils.sh` | `pkg/utils/logger.go` | 2026-05-30 |
| `lib/core/env.sh` | `internal/config/config.go` | 2026-05-30 |
| `lib/core/confirm.sh` | 合并到 Go | 2026-05-30 |
| `lib/core/install.sh` | `engine/install.go` | 2026-05-30 |
| `lib/core/truenas_rpc.py` | `tools/truenas.go` | 2026-05-30 |
| `lib/tools/n8n.sh` | `tools/n8n.go` | 2026-05-30 |
| `lib/tools/nas.sh` | `tools/truenas.go` | 2026-05-30 |
| `spool.sh` | `spool` (Go CLI) | 2026-05-30 |
| `config.ini.example` | `silkspool.yaml.example` | 2026-05-30 |

#### 新增 Go 模块

| 模块 | 说明 |
|------|------|
| `pkg/sops/sops.go` | SOPS SDK 封装 |
| `internal/engine/sops.go` | SOPS 高级集成 |
| `internal/engine/site.go` | 站点管理 (DNS + Caddy) |
| `internal/engine/backup.go` | 备份管理器 |

#### 已迁移脚本

| 脚本 | 用途 | 迁移目标 |
|------|------|----------|
| `lib/tools/scan_dups.py` | 重复文件扫描 | `Bellkeeper/scripts/scan_dups.py` |

---

### Phase 5: 运行时模型重构 — out/ 自包含目录 ✅ 已完成 (2026-05-30)

**目标**: 弃用 `~/.silkspool` 分离模型，实现二进制自包含的运行时目录

#### 5.1 BaseDir 自动解析 (`cmd/spool/main.go`)
- **新增** `resolveBaseDir()`：自动以二进制所在目录为 BaseDir
- **优先级**：`--config` > 可执行文件目录（有效目录判定）> `cwd`
- **开发兼容**：`go run` 时临时目录无效，自动 fallback 到项目根目录

#### 5.2 构建脚本 (`Makefile`)
- **新增** `make all`：一键编译 + 初始化 `out/` 目录
- **内容**：二进制 + `bundles/` 复制 + `silkspool.yaml` 示例 + 空运行时目录
- **幂等**：不覆盖已有的 `out/silkspool.yaml` 和 `out/hosts/`

#### 5.3 配置路径调整 (`internal/config/config.go`)
- `~/.silkspool` 优先级降为**最后 fallback**
- 从 `~/.silkspool` 加载时输出 deprecation 警告
- 主要搜索路径改为以 BaseDir（如 `out/`）为根

#### 5.4 `.gitignore` 更新
- 新增 `out/` 忽略规则，确保构建产物不污染版本控制

#### 部署模型对比

| 模型 | 旧模型 (v1.x-v2.0早期) | 新模型 (v2.0+) |
|------|----------------------|----------------|
| 配置位置 | `~/.silkspool/` | `out/`（二进制同目录） |
| bundles | 项目目录或符号链接 | 复制到 `out/bundles/` |
| 运行方式 | `cd SilkSpool && ./spool` | `/opt/silkspool/spool`（任意位置） |
| BaseDir | `cwd` | 自动解析为二进制目录 |
| 可移植性 | 需源码 + 配置分离复制 | `cp -r out/` 即可 |

---

## 六、CLI 命令对照表

| 命令 | 旧实现 | 新实现 | 状态 |
|------|--------|--------|------|
| `./spool sync pull/push <host>` | lib/core/sync.sh | engine/sync.go | ✅ 已删除 |
| `./spool dns add/remove/push` | lib/core/dns.sh | engine/dns.go | ✅ 已删除 |
| `./spool site deploy` | lib/core/dns.sh | engine/site.go | ✅ 已删除 |
| `./spool bundle <name> up` | lib/core/runner.sh | engine/bundle.go | ✅ 已删除 |
| `./spool n8n list/import/export` | lib/tools/n8n.sh | tools/n8n.go | ✅ 已删除 |
| `./spool nas info/pool/dataset` | lib/tools/nas.sh | tools/truenas.go | ✅ 已删除 |
| `./spool service status/restart` | lib/core/service.sh | engine/service.go | ✅ 已删除 |
| `./spool stack <host>` | lib/core/install.sh | engine/install.go | ✅ |
| `./spool backup <host>` | lib/core/backup.sh | engine/backup.go | ✅ 已删除 |
| `./spool exec <host> <cmd>` | lib/core/ssh.sh | engine/ssh.go | ✅ 透传已移除 |
| `./spool init <host>` | lib/core/ssh.sh | engine/init.go | ✅ 交互式实现 |

---

## 八、测试与验证

### 编译验证
```bash
go build -o spool ./cmd/spool/
./spool --help
./spool version
./spool sync --help
./spool dns --help
./spool n8n --help
./spool nas --help
```

### 预期输出
```
SilkSpool V2.0.0
  Build: unknown (unknown)

Available Commands:
  sync        同步配置文件
  dns         DNS 记录管理
  n8n         n8n 工作流管理
  nas         TrueNAS 存储管理
  ...
```

---

## 八、备份与回滚

### 备份文件位置
```
/home/ubuntu/silkspool_backup_20260530_045154.tar.gz (23MB)
```

### 回滚方法
```bash
# 停止 spool-v2
pkill spool-v2

# 解压备份
tar -xzf ~/silkspool_backup_20260530_045154.tar.gz

# 恢复旧版
cp spool.sh.bak spool.sh
rm spool-v2
```

---

## 九、后续计划

### 9.1 Phase 5 (SOPS 完善)
- [ ] 实现 `.env.enc` 自动解密流程
- [ ] SSH 原生上传解密后的 `.env`
- [ ] 清理 SilkSpool 目录中残留的 Python 脚本（已全部迁移或删除）

### 9.2 Phase 6 (测试覆盖)
- [ ] 单元测试覆盖核心模块（config、engine、tools）
- [ ] 集成测试（模拟 SSH 连接）
- [ ] BaseDir 解析逻辑测试
- [ ] 配置加载路径测试

### 9.3 Phase 7 (文档完善)
- [ ] 更新 README.md（out/ 部署模型）
- [ ] 编写 CLI 使用手册
- [ ] 更新 doc/STATUS.md
- [ ] 编写迁移指南（~/.silkspool → out/）

---

## 十、关键文件索引

| 文件路径 | 说明 |
|----------|------|
| `cmd/spool/main.go` | CLI 入口 |
| `internal/config/types.go` | 数据结构定义 |
| `internal/config/config.go` | 配置加载器 |
| `internal/engine/dns.go` | DNS 管理器 |
| `internal/engine/sync.go` | 同步管理器 |
| `internal/engine/bundle.go` | Bundle 编排器 |
| `internal/engine/ssh.go` | SSH 客户端 |
| `internal/engine/service.go` | 服务控制器 |
| `internal/engine/install.go` | 安装管理器 |
| `internal/tools/n8n.go` | n8n API 客户端 |
| `internal/tools/truenas.go` | TrueNAS RPC 客户端 |
| `pkg/utils/logger.go` | 日志工具 |
| `silkspool.yaml.example` | 配置文件示例 |
| `Makefile` | 构建脚本（out/ 自包含目录） |
| `.gitignore` | Git 忽略规则 |
| `go.mod` | Go 模块定义 |

---

*本文档随重构进度持续更新*
