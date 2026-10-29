# SilkSpool 部署指南（现行）

> 适用于: v1.0.0+
> 部署模型: 自包含二进制目录（out/）+ 系统 PATH 软链

---

## 本机实际部署（控制节点）

当前控制节点上的 spool 已按如下方式部署，**日常运维直接用 PATH 中的 `spool` 命令即可**：

```
/opt/SilkSpool/                 # ← 自包含运行目录（由 out/ 复制而来）
├── spool                       # 二进制（make build 产物）
├── silkspool.yaml              # 主配置
├── bundles/                    # Bundle 预制文件
├── hosts/                      # 主机配置（sync pull 填充）
├── keys/                       # SSH 密钥
└── backups/                    # 备份存储

/usr/local/bin/spool  →  /opt/SilkSpool/spool   # 软链，已在 PATH 中
```

因此**任意目录**下执行 `spool <command>` 都会运行 `/opt/SilkSpool/spool`，并自动以
`/opt/SilkSpool/` 为 BaseDir 解析配置。无需 `cd`、无需 `./`、无需 `go run`。

> ⚠️ 注意大小写：本机控制节点安装目录是 `/opt/SilkSpool`（大写 S）。
> 远程 keeper 主机上的 `/opt/silkspool/keeper/...`（小写）是**另一台机器**上的容器栈路径，
> 二者不是同一个目录，配置示例中的远程路径请勿改成大写。

---

## 当前生产目标（2026-10-29 实测）

- `prod`（192.168.7.128）：`prod-stack`（Bellkeeper/n8n）+ 独立 `proddata` 数据依赖；RSSHub 使用独立 `rsshub` bundle。
- `txhk`：Matrix 服务为 `tuwunel`，配置 `/etc/tuwunel/tuwunel.toml`，不是已停用的 `conduit`。
- 工作流与 secret 使用 `/opt/SilkSpool/hosts/prod/`；当前 n8n 卷为 `prod-n8n`，数据库为 PostgreSQL。
- 下文 `keeper` / `knowledge-stack` / `silkdata` 是通用配置示例，不代表本机生产目标。生产应执行 `spool plan prod-stack prod`、`spool restart prod bellkeeper`、`spool service txhk status tuwunel`。
- Matrix 房间、过滤与告警现状见 [Bellkeeper STATUS](../../Bellkeeper/doc/STATUS.md)，持久配置及重载边界见 [Bellkeeper DEPLOYMENT](../../Bellkeeper/doc/DEPLOYMENT.md)。

## 目录结构

### 项目源码（Git 管理）

```
SilkSpool/                      # ← 代码仓库 (git)
├── cmd/spool/                  # CLI 入口
├── internal/                   # 核心模块
├── pkg/                        # 共享包
├── bundles/                    # Bundle 预制模板
├── silkspool.yaml.example      # 配置模板
├── Makefile                    # 构建脚本
├── doc/                        # 文档
└── ...
```

### 构建输出（`out/`，不在 git 中）

```
out/                            # ← 自包含运行包（make build 产物）
├── spool                       # 可执行文件
├── silkspool.yaml              # 主配置文件（make all 时由 example 生成，幂等不覆盖）
├── bundles/                    # Bundle 预制文件
├── hosts/                      # 主机配置（运行时 sync pull 填充）
├── keys/                       # SSH 密钥
└── backups/                    # 备份存储
```

**设计原则**：`out/` 是完全自包含的目录，复制到任何位置（如 `/opt/SilkSpool`）即可运行，
无需依赖项目源码或 `~/.silkspool`。

---

## 安装步骤（首次部署）

### 1. 从源码构建

```bash
git clone https://github.com/singll/SilkSpool.git
cd SilkSpool

make all          # 编译 + 初始化 out/（复制 bundles、创建运行时目录、生成示例配置）
ls -la out/       # 查看构建产物
```

### 2. 复制到系统目录并软链到 PATH

```bash
# 复制自包含目录到 /opt/SilkSpool
sudo cp -r out/ /opt/SilkSpool
sudo chown -R "$USER":"$USER" /opt/SilkSpool
chmod 755 /opt/SilkSpool/spool
chmod 700 /opt/SilkSpool/keys

# 软链到 PATH，之后任意目录都能用 `spool`
sudo ln -sf /opt/SilkSpool/spool /usr/local/bin/spool
spool version
```

---

## 配置初始化

### 1. 编辑主配置

```bash
vim /opt/SilkSpool/silkspool.yaml
```

关键字段：

```yaml
global:
  ssh_key_path: "./keys/id_silkspool"   # 相对于 /opt/SilkSpool 目录
  default_domain: "singll.net"
  backup_dir: "~/silkspool_backups"

hosts:
  keeper:
    address: "silkspool@192.168.7.230"
    # ... 其他配置
```

### 2. 生成 SSH 密钥

```bash
ssh-keygen -t ed25519 -f /opt/SilkSpool/keys/id_silkspool -N "" -C "silkspool"
chmod 600 /opt/SilkSpool/keys/id_silkspool
```

### 3. 初始化主机配置（从远程拉取）

```bash
spool init keeper          # 初始化远程主机 SSH 信任 + Docker 权限
spool sync pull keeper     # 拉取远程配置到 /opt/SilkSpool/hosts/
```

**说明**：`hosts/` 目录在首次构建时为空，通过 `sync pull` 从远程主机填充，或手动复制旧配置进去。

---

## 使用方式

### 直接用 PATH 中的 `spool`（推荐）

```bash
spool sync push keeper
spool service keeper status
spool adopt keeper --dry-run   # 可选：纳管既有 compose stack（只读发现）
spool inventory --json
spool exec keeper "docker ps"
```

`spool` 自动以二进制所在目录（`/opt/SilkSpool/`）为 BaseDir 解析配置，**无论从哪运行**都正确。

### 开发模式（项目目录运行）

在项目根目录开发、调试源码时：

```bash
go run ./cmd/spool/ version
go run ./cmd/spool/ sync pull keeper
```

> 运维远程主机时不要用 `go run`，直接用已部署的 `spool` 命令。`go run` 仅用于开发期验证代码改动。

### 指定配置路径

```bash
spool --config /etc/silkspool/silkspool.yaml sync push keeper
```

### 配置搜索顺序

1. `--config` 命令行参数
2. 可执行文件所在目录（`/opt/SilkSpool/`）
3. 当前工作目录（fallback，开发模式）
4. `/etc/silkspool/`（系统级 fallback）

配置字段与完整示例见 [configuration.md](configuration.md)。

---

## 升级（覆盖二进制）

升级**只覆盖二进制**，绝不整目录覆盖 —— `hosts/`、`keys/`、`silkspool.yaml`、`backups/` 必须原样保留。

```bash
cd /path/to/SilkSpool
git pull
make build                              # 重新编译，产出 out/spool

# 仅覆盖二进制；软链 /usr/local/bin/spool 会自动指向新版本
cp /opt/SilkSpool/spool /opt/SilkSpool/spool.bak.$(date +%Y%m%d_%H%M%S)   # 备份旧版（可选）
cp out/spool /opt/SilkSpool/spool
chmod 755 /opt/SilkSpool/spool
spool version
```

> ❌ 不要用 `cp -r out/ /opt/SilkSpool` 升级 —— 会覆盖运行时的 `hosts/`、`keys/`、`silkspool.yaml`。
> 整目录复制只用于**首次**部署到一个空目录。

---

## Makefile 目标

| 目标 | 说明 |
|------|------|
| `make all` | 编译 + 初始化 out/（默认）。幂等，不覆盖已有 `out/silkspool.yaml` 和 `out/hosts/` |
| `make build` | 仅编译二进制到 `out/spool`（升级时用这个） |
| `make init-out` | 仅初始化 out/ 目录结构（复制 bundles、创建空运行时目录） |
| `make clean` | 删除二进制和 `out/bundles/`，**保留** `hosts/`、`keys/`、`backups/`、`silkspool.yaml` |
| `make dist-clean` | **删除整个 out/ 目录**（含用户数据，破坏性，3 秒确认窗口） |
| `make build-linux` | 交叉编译 linux/amd64 |
| `make build-darwin` | 交叉编译 darwin/arm64 |
| `make build-windows` | 交叉编译 windows/amd64 |
| `make openapi` | 从 `api/openapi.yaml` 重新生成 `pkg/apiclient/client.gen.go` |

---

## 安全建议

1. **密钥保护**: `/opt/SilkSpool/keys/` 目录权限设为 `700`
2. **配置隔离**: `out/` 目录不加入 git（已在 `.gitignore` 中）
3. **定期备份**: 备份 `/opt/SilkSpool/silkspool.yaml` 和 `/opt/SilkSpool/hosts/` 目录

---

## Plan / Apply / Rollback（单 host）

单 host 部署主链路：

```bash
# 1. 静态校验（CI/PR，不连远端；合法 0，非法 2，永不返回 3）
spool plan knowledge-stack keeper --offline --json

# 2. online diff（SSH 读取远端实际状态；有 diff 退出 3）
spool plan knowledge-stack keeper --json

# 3. 应用（--locked 复现上一次 lock 快照；script 驱动必须 --yes）
spool apply knowledge-stack keeper --yes
spool apply knowledge-stack keeper --locked --yes

# 4. 回滚（不传 generation 时回滚到 current-1）
spool rollback knowledge-stack keeper
spool rollback knowledge-stack keeper 3

# 5. 显式 restore（未声明 lifecycle.restore.hook 时只输出人工恢复产物路径）
spool restore knowledge-stack keeper
```

约定：

- `.spool/lock/<host>/<bundle>.yaml` 保存 resolved 快照与渲染结果；`.spool/state/` 可删除重建。
- 远端 `/opt/silkspool/<bundle>/.spool-gen/<n>/` 保存 compose/env/digest/meta；
  默认保留 current 与上一代，控制机重装后仍可从远端回滚。
- `.spool/locks/<host>.lock` 是 per-host 部署锁：同 host 串行，不同 host 可并行。
- `dependencies` 只读 outputs，不会被 apply/升级/回滚；`components` 才部署到目标 host。
- 含 `${secrets.*}` 的 wiring 在 plan/lock 中写 `secret://...` 占位；apply 时才从
  `hosts/<host>/<bundle>/.env` 与 `hosts/<host>/.env` 解析。
- `lifecycle.upgrade.irreversible: true` 必须先声明 `spec.backup.hook`，执行时必须带
  `--allow-irreversible`；健康失败不自动回滚，状态停在 `needs_attention`。
- 远端仍可直接手动执行：
  `docker compose -f docker-compose.yaml -f docker-compose.spool.yaml up -d`

### bundle_sources

`silkspool.yaml` 可声明外部 bundle 来源（支持 `dir` / `git` / `oci`）：

```yaml
bundle_sources:
  - name: bellkeeper
    type: git
    repo: https://github.com/singll/Bellkeeper.git
    path: deploy
    commit: c243797fc78911af49c8d70858ed94e499960f01
  - name: local
    type: dir
    path: ./bundles
  - name: bellkeeper-oci
    type: oci
    ref: ghcr.io/singll/bellkeeper-bundle
    digest: "sha256:<64-hex-manifest-digest>"
    # cosign:
    #   key: ./cosign.pub
```

`git` 必须固定 commit（禁止 `latest`/分支）；`oci` 必须固定 digest；缓存写入 `.spool/cache/bundles/<name>/<ref>/`。
OCI 布局与 cosign 门禁见 [bundle-development.md](bundle-development.md#oci-artifact-布局p3)。
Bellkeeper 在自己的仓库维护 `deploy/bundle.yaml`，升级 Bellkeeper 只需改这里固定的 commit，
不需要修改 SilkSpool 的 knowledge-stack 模板。

### knowledge-stack（composition）

`knowledge-stack` 是 composition，`spool apply knowledge-stack keeper` 只操作 keeper 上的
components：

| 角色 | 内容 |
|---|---|
| components | bellkeeper（来自 Bellkeeper 仓库的 product bundle）、n8n、memos、rsshub |
| dependencies | data → silkdata（只读 outputs，绝不 apply/升级/回滚） |
| wiring | `${components.<key>.outputs.*}` / `${dependencies.data.outputs.*}` |

拓扑解析：

- 同机 n8n → bellkeeper 的 `internal` endpoint 解析为服务名 `bellkeeper:8080`。
- 跨机 bellkeeper → silkdata 解析为 `hosts.silkdata.magicdns`；未配置时回退 `address`；
  两者都缺失则 plan 失败。
- MagicDNS 可用时不生成 `extra_hosts`；仅地址回退时由 spool 根据解析结果生成。
- 模板中零 IP、零 `container_name` 硬编码。

迁移期 `keeper` 仍是 `knowledge-stack` 的兼容别名，plan/apply 会输出弃用警告；新命令统一用
`knowledge-stack`。

> Bellkeeper 的 `deploy/bundle.yaml` 中 digest 目前是发布占位值。正式 apply 前必须先发布镜像
> 并把 `delivery.artifact.digest` 换成真实 manifest digest；`spool bundle check-updates` 可用于
> 后续提醒。不要在未替换占位 digest 时对真实主机执行 apply。

### spool serve --socket

可选的本地 HTTP/JSON 服务，不是常驻 Core：

```bash
spool serve --socket /run/spool.sock
# 可选：--token <admin-token>、--audit-log .spool/audit.log
```

- socket 权限固定 `0600`；`--token` 设置后所有请求需 `Authorization: Bearer <token>`。
- 危险动作（`bundle.apply` / `bundle.rollback`）必须 `options.yes=true`，或带
  `X-Spool-Approval: <token>`（token 与服务 token 相同）。
- job 状态：`queued → running → succeeded/failed`；同 host 串行、不同 host 并行；
  未完成期间相同 `idempotency_key` 复用同一个 job。
- 审计日志为 JSON Lines，记录 actor、action、target、idempotency_key、结果。
- 端点与调用示例见 [api.md](api.md)。

### bundle check-updates

```bash
spool bundle check-updates knowledge-stack --json
```

列出固定 digest 镜像的 registry tag 对比结果；**只建议，不修改 manifest、不自动 apply**。
更新流程：Renovate/Dependabot 或人工修改 tag/digest → `spool plan --offline` →
online plan → `spool apply --locked --yes`。

### OCI / cosign（P3）

```yaml
bundle_sources:
  - name: bellkeeper
    type: oci
    ref: ghcr.io/singll/bellkeeper-bundle
    digest: "sha256:<64-hex-manifest-digest>"
    path: deploy
    cosign:
      key: ./cosign.pub   # 或 identity + issuer
```

- digest 固定；tag 只作可读提示。
- 声明 `cosign` 即强制验签：cosign 不存在、无签名或验签失败都会报错，不降级。
- 拉取缓存 `.spool/cache/bundles/<name>/sha256-<digest>/`。

### 纳管既有 stack：`spool adopt`（P3）

```bash
spool adopt keeper --dry-run
spool adopt keeper --bundle legacy-stack
spool adopt keeper --bundle legacy-stack --force
```

只执行只读 `docker ps/inspect` 与读取 compose 文件；不会 stop/start/recreate 容器，也不修改远程文件。
`--dry-run` 不写任何文件；已有 manifest/state/lock 时必须 `--force` 才覆盖。

### OpenAPI / 生成客户端（P3）

```bash
make openapi
# 生成 pkg/apiclient/client.gen.go
```

规范在 `api/openapi.yaml`；Go 客户端通过 `apiclient.NewUnixClient("/run/spool.sock")` 使用。
生成物过期会被 `go test ./internal/openapigen` 检测。

### inventory（含 Dataset/Key）

```bash
spool inventory --json
spool inventory --probe --json   # 连接 TrueNAS/SSH；默认不探测
```

`inventory --json` 返回 `kind/name/host/labels/status/outputs`；sensitive 只返回 `secret://` 引用。

---

## 常用命令

```bash
# 初始化主机
spool init keeper

# 同步配置
spool sync push keeper
spool sync pull keeper

# 资源清单 / 纳管
spool inventory --json
spool adopt keeper --dry-run

# Bundle 操作（knowledge-stack；keeper 为兼容 alias，已弃用）
spool plan knowledge-stack keeper --offline
spool plan knowledge-stack keeper
spool apply knowledge-stack keeper --locked --yes
spool rollback knowledge-stack keeper
spool status knowledge-stack keeper --json
spool bundle check-updates knowledge-stack --json

# data 层独立部署/升级（不会被 knowledge-stack apply 触碰）
spool plan silkdata silkdata --offline
spool apply silkdata silkdata --yes

# 本地 API / OpenAPI（可选）
spool serve --socket /run/spool.sock
make openapi

# 服务管理
spool service keeper status
spool restart keeper n8n
spool logs keeper bellkeeper 200

# n8n 工作流
spool n8n list
spool n8n import

# 远程执行 / 备份
spool exec keeper "docker ps"
spool backup keeper
```

---

*部署模型: 自包含二进制目录 + PATH 软链 | 最后更新: 2026-10-24（P3）*

## 2026-10-29 Matrix 与 RSSHub 接入

prod 的 Bellkeeper 直接连接 txhk tuwunel，n8n 运行 9 个 B/K/O 工作流。房间入口、评分与告警策略见 [Bellkeeper 状态](../../Bellkeeper/doc/STATUS.md)。`rsshub` 是独立无状态 bundle，固定 GHCR digest；`spool apply rsshub prod --yes` 仅管理该服务，prod-net 内供 Bellkeeper 使用。内网反代后端为 `.128:1200`。

当前 Bellkeeper 为不重建容器的持久卷补丁部署，运行时 entrypoint 为 `/app/data/bellkeeper-matrix`；部署新镜像前查阅 Bellkeeper DEPLOYMENT，升级到含修复版本后移除覆盖。凭证、实际 prod-stack 配置和二进制位于 `/opt/SilkSpool/hosts/prod/`，不提交。

2026-10-29 已移除不可达的旧 Memos、RAGFlow、Firecrawl、MinIO、Grafana 首页/DNS/反代入口；原配置保存在私有接入备份目录，不能把旧主机地址当作当前服务。

## prod NFS 与已有 Obsidian 库

三条读写 NFS 均已实测：`/mnt/NAS/data/prod`、`/mnt/NAS/data/knowledge`、`/mnt/NAS/data/media/recordings`。录像复用 NAS 原数据集，新导出仅允许 prod /32，已写入 fstab。Bellkeeper 用直接 NFS volume 接入 knowledge；录像宿主挂载可供后续录像服务使用，本次没有迁移 `.108` 上的录像 Web 服务。

CouchDB 复用 istoreos `https://couchdb.singll.net`，数据库 `obsidian-notes`。通用模板新增 `couchdb/10-livesync.ini` 和同步/挂载声明，实际 proddata 也同步更新；现有容器通过配置 API/持久 volume 修改后重启，未重建。健康端点 `/_up` 保留匿名探活，其余 API 认证。专用管理员密码在私有 `/opt/SilkSpool/hosts/prod/couchdb/obsidian-livesync.env`。

[NFS 说明与写入验收](../../Bellkeeper/doc/ops/NFS-SETUP.md) · [已有 Vault 初始化步骤](../../Bellkeeper/doc/knowledge-base/setup/livesync-checklist.md)。先由已有本地 Vault 上传，后续设备从第一台导出的 Setup URI 接入；不要从空远端覆盖已有笔记，也不要把 NAS 原始文件直接写入 LiveSync JSON 数据库。
