# 架构（现行）

> 最后更新：2026-10-24 · 适用 `spool` 1.2+
>
> 本文描述**当前实现**；历史方案见 [archive/DECOUPLING-PLAN.md](archive/DECOUPLING-PLAN.md)。

---

## 1. 定位

SilkSpool 是一个 **agentless 的资源编排内核**：

- 单 Go 二进制，通过 SSH + Docker Compose/systemd 操作远程主机；
- 容器用 Bundle 轻契约交付，非容器资源复用现有 manager；
- 不引入常驻控制面、数据库、Kubernetes/CRD 或自研服务发现；
- 其他工具通过 `--json` 或可选的本地 Unix socket API 使用它，不直接 SSH。

设计原则：

1. 内核不认识应用名（`internal/engine` 不出现 bellkeeper/n8n/redis）。
2. 类别与驱动正交：`class` 与 `delivery.driver` 分开。
3. 显式引用，不做 capability 自动匹配。
4. 文件是真相，`.spool/state`、`.spool/lock` 是可重建缓存。
5. 先 plan 再 apply；危险操作可 dry-run、可回滚、可加锁。
6. 机器可读优先：stdout 只放数据，日志走 stderr。
7. 不引入常驻控制面；`spool serve` 是可选本地服务。
8. 只统一资源模型，不统一实现。

---

## 2. Resource 统一模型

所有对象都是 Resource：

| Kind | 实现 | 说明 |
|---|---|---|
| `Host` | `config.HostConfig` + SSH | 被管理主机 |
| `Bundle` | `BundleManager` + driver | 交付单元 |
| `Service` | `ServiceManager` | docker/systemd/initd/openwrt |
| `SyncRule` | `SyncManager` | 本地 ↔ 远程文件 |
| `DNSRecord` | `DNSManager` | dnsmasq/OpenClash |
| `Site` | `SiteManager` | DNS + Caddy + Homepage |
| `Dataset` | `tools/truenas` adapter | TrueNAS dataset |
| `Secret` | `pkg/sops` | SOPS/age 加密配置 |
| `Backup` | `BackupManager` | volume/dir/db |
| `Key` | `KeyManager` adapter | SSH 管控密钥 |

最小接口：

```go
type Resource interface {
    Kind() string
    Name() string
    Status(ctx context.Context) (ResourceStatus, error)
}

type PlanApplier interface {
    Plan(ctx context.Context, opts ResourceOptions) (*PlanResult, error)
    Apply(ctx context.Context, opts ResourceOptions) (*ApplyResult, error)
}

type Backupable interface {
    Backup(ctx context.Context, opts ResourceOptions) (BackupRef, error)
    Restore(ctx context.Context, ref BackupRef) error
}
```

约定：

- 不支持的动作返回 `UnsupportedError`，绝不静默成功。
- `spool inventory --json` 返回 `kind/name/host/labels/status/outputs`。
- sensitive 输出只返回 `secret://...` 引用；Key 不返回私钥内容。
- `Dataset.Apply` / `Key.Apply` 明确 unsupported，分别走 `spool nas rpc` / `spool key rotate`。

---

## 3. Bundle 轻契约

### 3.1 分类

| class | 定义 | 示例 |
|---|---|---|
| `product` | 单一上游产品，内部强耦合，对外只暴露契约 | bellkeeper、csai |
| `composition` | 多个独立组件组成一个能力，只负责 BOM/wiring | knowledge-stack、gateway、server |
| `capability` | 可复用的数据/中间件能力 | silkdata |
| `infrastructure` | 主机级底座/agent | mon-agent |
| `tool` | 脚本化工具环境 | vulhub |

### 3.2 Manifest

新 bundle 推荐使用 `metadata/spec`；旧扁平字段继续兼容。

```yaml
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: myapp
  class: product
  version: 1.0.0
  owner: singll/myapp
spec:
  compatibility:
    spool: ">=1.2"
  delivery:
    driver: compose
    templates: [compose.yaml]
  inputs:
    public_url: "https://myapp.example.com"
  outputs:
    health: "http://127.0.0.1:8080/api/health"
    internal:
      kind: endpoint
      service: myapp
      port: 8080
      remote: "${host.magicdns}"
  lifecycle:
    health:
      http: "${outputs.health}"
      from: container
      timeout: 60s
    upgrade:
      strategy: recreate
      irreversible: false
    restore:
      hook: scripts/restore.sh
  backup:
    hook: scripts/backup.sh
    assets:
      - type: volume
        source: myapp-data
```

`components`（本 composition 部署，全部在同一目标 host）与 `dependencies`（已在别处部署，只读 outputs）严格分开。`dependencies` 永远不 apply/升级/回滚。

### 3.3 表达式

| 表达式 | 来源 |
|---|---|
| `${input.<key>}` | host/bundle 输入 |
| `${host.name}` / `${host.address}` / `${host.magicdns}` / `${host.ssh}` | 目标 host |
| `${outputs.<key>}` | 当前 bundle 输出 |
| `${components.<key>.outputs.<key>}` | 本 composition 组件输出 |
| `${dependencies.<key>.outputs.<key>}` | 外部依赖输出 |
| `${secrets.<key>}` | secret provider；plan/lock 只写 `secret://...` |

只做字符串插值；未解析引用在 plan 阶段失败。endpoint 拓扑解析：

| 场景 | host | port |
|---|---|---|
| 同 host + 同 compose project | 服务名 | 容器端口 |
| 同 host + 不同 project | 共享网络服务名，否则 `host.address` | 容器端口或 `published_port` |
| 跨 host | MagicDNS → address | `published_port` |

---

## 4. 执行模型

```text
resolve → plan/offline 校验 → lock 快照 → per-host flock
        → 远端 generation 快照 → compose up → health gate
        → SSH 回连确认 → 写 state/generation
        → 失败：自动回滚上一 generation（不可逆迁移除外）
```

- `components` 才部署；`dependencies` 只用于渲染 wiring。
- `spool apply --locked` 只使用本地 lock，plan 不一致则拒绝。
- 远端 `.spool-gen/<n>/` 保存 compose/env/digest/meta，默认保留 current + 上一代。
- `.spool/locks/<host>.lock`：同 host 串行，不同 host 可并行。
- `lifecycle.upgrade.irreversible: true` 必须声明 `backup.hook`，执行时带 `--allow-irreversible`；健康失败不自动回滚，停在 `needs_attention`。
- `script` driver 的 plan 不提供真实 diff；apply 必须显式 `--yes`。

### 目录

```text
.spool/
├── lock/<host>/<bundle>.yaml
├── state/<host>/<bundle>.yaml
├── cache/bundles/<name>/<ref>/     # git/oci 缓存
└── locks/<host>.lock

/opt/silkspool/<bundle>/
├── docker-compose.yaml
├── docker-compose.spool.yaml
├── .env
├── .spool-gen/<n>/
└── backups/
```

---

## 5. Bundle 来源

| type | 固定方式 | 说明 |
|---|---|---|
| `dir` | 本地目录 | 仓库内 `bundles/` 或外部目录 |
| `git` | 7–40 位 commit | 缓存 `.spool/cache/` |
| `oci` | manifest `sha256:` digest | Timoni 风格 OCI artifact；可选 cosign 强制门禁 |

OCI 细节见 [bundle-development.md](bundle-development.md#oci-artifact-布局p3)；cosign 只要声明就是强制门禁，缺失/失败明确报错。

---

## 6. 对外接口

| 层 | 形态 | 说明 |
|---|---|---|
| L1 | 全命令 `--json` | 统一 envelope + 退出码 0/2/3/4/5 |
| L2 | `spool serve --socket` | 可选本地 HTTP/JSON；`/v1/inventory`、bundle、outputs、actions、jobs |
| SDK | `api/openapi.yaml` → `pkg/apiclient` | 客户端由 OpenAPI 生成，不手写 |

`--json` 约定：stdout 只放 JSON，日志走 stderr；online plan 有 diff 退出 `3`，`--offline` 永不返回 `3`。

---

## 7. 纳管既有 stack

`spool adopt <host>` 只读发现 compose project 的容器/卷/网络标签，生成 manifest/state/lock 与本地模板副本：

- 只执行 `docker ps/inspect` 和读取 compose 文件；
- 不 stop/start/recreate 容器，不修改远程文件；
- `--dry-run` 不写任何文件；
- 已有输出必须 `--force` 才覆盖；
- 有挂载的容器在报告中标记 `stateful`，原样保留。

---

## 8. 非目标（明确不做/未启动）

- 跨主机 apply 编排：当前 `components` 只允许单 host；`dependencies` 只读。无真实消费方前不实现。
- CUE：单 bundle >10 components 或引用深度 >3 才评估；当前未触发。
- Events/SSE/Webhook：等第一个真实订阅者。
- 完整 semver solver、capability marketplace、profiles、常驻 agent、Web UI/数据库。
- 自研服务发现/WireGuard mesh；使用 Headscale MagicDNS 或显式地址。
