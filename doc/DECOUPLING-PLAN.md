# SilkSpool 解耦与集成改进方案（评审后修订版）

> 状态: Draft
> 日期: 2026-10-23
> 依据: 对《SilkSpool 解耦与集成设计》的评审意见，以及对 Kamal、Komodo、Dockge、Uncloud、Timoni、deploy-rs 公开文档的核对
> 结论: 继续优化 SilkSpool；不引入平台化运行时。范围收缩为 **Resource 统一模型 + Bundle 轻契约 + 两层集成接口**。

---

## 0. 一页结论

**保留**

- agentless、单二进制、SSH + Docker Compose/systemd 的轻量底座。
- 非容器资源能力：DNS、Site、TrueNAS、SSH Key、n8n 工作流。
- Product / Composition 二分法，以及“类别与驱动正交”。

**收缩**

- 不做 capability marketplace、profiles、五层接口、进程外插件协议、Events、OCI 签名、GitOps 控制器。
- 不做完整的版本约束求解器、跨机服务发现、WireGuard mesh。
- 不为“其他团队发布 bundle”做生态化设计；先服务好 Bellkeeper 这一个外部来源。

**顺序**

| 阶段 | 主题 | 目的 |
|---|---|---|
| P0 | 清理硬编码、`--json`、标签、state、per-bundle 配置 | 先把现有行为变可观测、可机器消费 |
| P1 | 轻契约、显式 wiring、plan/apply、magic rollback | 解决核心解耦与升级安全 |
| P2 | keeper 拆分、本地 API | 用真实产品验证契约 |
| P3 | OCI/CUE/Events，仅在有真实需求时 | 不提前建设 |

**护城河**

不是“更像 K8s 的契约”，而是 **用单二进制统一编排容器与非容器资源**。Komodo 证明了“资源模型 + 声明式同步 + API”可行，Kamal 证明了 agentless SSH 部署可行，但两者都停在容器层；DNS、站点、NAS、密钥是 SilkSpool 的差异化。

---

## 1. 对评审意见的处理

| 评审意见 | 处理 | 落地方式 |
|---|---|---|
| 药方超过项目体量 | 采纳 | 本方案只保留 P0/P1 必需项，P3 明确“按需” |
| Resolver + 跨机 wiring 被低估 | 采纳 | 改为**单向显式引用**，不做 capability 自动匹配；解析在 plan 时一次完成 |
| 五层接口过剩 | 采纳 | 只保留 `--json` + `spool serve --socket` |
| 缺少战略问题（不可替代性） | 采纳 | 以 Resource 统一模型作为主线，而不是 manifest v2 |
| CUE 替代 deepMerge | 部分采纳 | 先用 Compose 原生多文件 `-f` + 生成的 override；CUE 只做 P3 spike |
| lockfile 完整依赖锁 | 采纳 | 只做 apply 后的 resolved outputs 快照，不做 semver solver |
| 进程外插件协议 | 采纳 | 改为 `pkg/driver` 公开 Go interface，编译期注册 |
| Events/NATS/SSE | 推迟 | 等第一个真实订阅者 |
| OCI + cosign | 推迟 | P3，照 Timoni 的 artifact 布局 |
| profiles | 砍掉 | 用两个 composition 文件表达 minimal/full |
| capability 自动匹配市场 | 砍掉 | composition 只显式引用 `bundles.<name>.outputs.<key>` |
| keeper 拆分 | 保留为 P2 | 用 3 条可测验收标准 |

---

## 2. 竞品核对与借鉴边界

以下结论基于 2026-10-23 可访问的公开文档，链接见第 13 节。

| 项目 | 已核对的事实 | 借鉴 | 不借鉴 |
|---|---|---|---|
| **Kamal 2** | SSH + `kamal-proxy`；`destinations` 做配置叠加；未知配置键直接报错，`x-` 前缀可扩展；`minimum_version`；secrets 按 common/destination 分层；hooks 带 `KAMAL_*` 审计变量；healthcheck/readiness/deploy timeout；`kamal rollback` 复用旧容器；`kamal lock` | 严格 schema + 扩展前缀；配置叠加；健康门禁；保留旧版本用于回滚；部署锁 | proxy/Traefik、镜像构建流水线 |
| **Komodo** | Resource 抽象（Server/Stack/Deployment 等），统一 name/id/tags；Resource Sync 用 TOML 声明、diff 后**人工确认**；`after` 可跨服务器排序；Core + Periphery agent（数据库通常为 MongoDB）；API 分 read/execute | 资源模型、tags/labels、diff + confirm、显式 `after` 依赖、action/job API | agent、MongoDB、UI、复杂权限矩阵 |
| **Dockge** | “File based structure”，不绑架 compose 文件，磁盘上的 `compose.yaml` 就是 stack，普通 `docker compose` 可直接操作 | 文件即真相；state 只是可重建缓存；远程产物保持人类可读 | Web UI、agent 管理 |
| **Uncloud** | WireGuard mesh + corrosion（CRDT SQLite）+ 内置 DNS；无中心控制面；项目自述仍在活跃开发、尚未 production-ready | 跨机网络不要自己造；优先复用已有 Headscale/MagicDNS；未来可评估集成 | 不把 WireGuard mesh/corrosion 引入 SilkSpool |
| **Timoni** | Module / Instance / Bundle 三层；Module 与 Bundle 以 OCI artifact 分发；semver + digest 固定；`bundle apply --diff`；CUE 做类型安全配置 | Product≈Module、Composition≈Bundle、Host 上的部署≈Instance；digest 固定；diff 先行；P3 的 OCI 布局 | 不现在引入 CUE/Kubernetes |
| **deploy-rs** | “Magic Rollback”：激活后回连确认主机仍可用，未确认则目标自动回滚；`autoRollback`、activation/confirm timeout、profilesOrder | 升级后健康检查 + 回连确认 + 自动回滚 + 超时；顺序部署 | Nix 体系 |
| **Ansible** | inventory + 幂等模块 + handler | inventory 思维；`hosts:` 就是 inventory | 不引入 DSL |
| **Docker Swarm** | 仍在维护但只修不演进；`docker stack deploy` 有已知行为坑 | 不作为底座 | — |

**关键调整（相对上一版方案）**

1. **不立即引入 CUE**。CUE 能解决列表合并、默认值、类型约束，但会给单二进制项目增加显著的学习和维护成本。先用 Compose 原生多文件合并 + 生成的 override 文件解决 80% 问题；只有当 composition 的 wiring 复杂度超过阈值（例如单 bundle 超过 10 个组件或 3 层引用）再做 CUE spike。
2. **不做自动 capability 解析**。`requires: postgres` 自动找 provider 是 Crossplane 式设计，解析时机、IP 漂移、部分失败语义都很难；改为显式引用具体 bundle 的 outputs。
3. **不把 Events 作为 P1**。n8n/Bellkeeper/CI 用 `--json` 和 HTTP action 足够；Events 等真实订阅者出现再做。

---

## 3. 设计原则

1. **内核不认识应用名**。`internal/engine` 不出现 `bellkeeper`、`n8n`、`redis` 等产品/组件名。
2. **类别与驱动正交**。`class: product | composition | capability | infrastructure | tool` 与 `delivery.driver: compose | stack | script` 分开。
3. **显式引用，不做自动匹配**。composition 只能引用 `bundles.<name>.outputs.<key>`，引用不存在则在 plan 阶段失败。
4. **文件是真相，state 是缓存**。远端 compose 文件、manifest、资源标签是真相；`.spool/state` 可删除后重建。
5. **先 plan 再 apply**。所有变更先产出 diff；危险操作可 dry-run、可回滚、可加锁。
6. **机器可读优先**。stdout 只放数据，stderr 放日志；所有读操作和关键写操作支持 `--json`。
7. **不引入常驻控制面**。`spool serve` 是可选的本地 Unix socket 服务，不是必须运行的 Core。
8. **只统一资源模型，不统一实现**。DNS 仍走 dnsmasq/OpenClash，NAS 仍走 TrueNAS API，Bundle 仍走 Compose/systemd；统一的是 `plan/status/apply/backup` 这些动词。

---

## 4. 目标模型

### 4.1 Resource：统一非容器与容器资源

SilkSpool 已有的对象本质上都是 Resource：

| Kind | 现有实现 | 说明 |
|---|---|---|
| `Host` | `config.HostConfig` / SSH | 被管理主机 |
| `Bundle` | `BundleManager` + drivers | 交付单元 |
| `Service` | `ServiceManager` | docker/systemd/initd/openwrt |
| `SyncRule` | `SyncManager` | 本地 ↔ 远程文件 |
| `DNSRecord` | `DNSManager` | dnsmasq/OpenClash |
| `Site` | `SiteManager` | DNS + Caddy + Homepage |
| `Dataset` | `tools/truenas` | TrueNAS pool/dataset/snapshot |
| `Secret` | `pkg/sops` | SOPS/age 加密配置 |
| `Backup` | `BackupManager` | volume/dir/db |
| `Key` | `KeyManager` | SSH 管控密钥 |

统一接口保持很小，避免变成 controller-runtime：

```go
type Resource interface {
    Kind() string
    Name() string
    Status(ctx context.Context) (Status, error)
}

type PlanApplier interface {
    Plan(ctx context.Context, opts Options) (Diff, error)
    Apply(ctx context.Context, opts Options) (Result, error)
}

type Backupable interface {
    Backup(ctx context.Context, opts Options) (BackupRef, error)
    Restore(ctx context.Context, ref BackupRef) error
}
```

**实施策略**

- 不重写现有 manager；用 adapter 包装。
- P1 先接 `Bundle`、`Service`、`DNSRecord`、`Site`；`Dataset`、`Key` 在 P3 接入。
- `spool inventory --json` 返回所有已注册资源的 `kind/name/host/labels/status/outputs`。
- 不支持的动作返回明确的 `unsupported`，不要静默成功。

### 4.2 Bundle 分类

| class | 定义 | 示例 | 生命周期 owner |
|---|---|---|---|
| `product` | 单一上游产品，内部强耦合，对外只暴露契约 | Bellkeeper、CSAI | 产品仓库 |
| `composition` | 多个独立组件组成一个能力，只负责 BOM/wiring | knowledge-stack、gateway、server、aigateway、bili、observability | 平台/运维 |
| `capability` | 可复用的数据/中间件能力 | silkdata（Postgres/Redis/Meili/NATS/CouchDB） | 平台/运维 |
| `infrastructure` | 主机级底座/agent | mon-agent | 平台/运维 |
| `tool` | 脚本化工具环境 | vulhub | 工具维护者 |

**判定问题**

1. 是否有单一上游仓库/版本？
2. 是否共享同一数据库、内部 API、迁移脚本？
3. 组件能否独立替换/升级？
4. 备份是否需要跨组件一致性？
5. 配置 schema 是否由产品方定义？

前三个偏“是”即 `product`，偏“否”即 `composition`。混合形态说明还没拆干净。

**keeper 现状**：同时包含 Bellkeeper 产品、n8n/Memos/RSSHub 组件、数据层和跨机 wiring，属于混合体，P2 拆分。

### 4.3 Bundle 轻契约

不引入完整 manifest v2。只增加以下字段，旧 manifest 自动兼容：

```yaml
apiVersion: spool/v1alpha1
kind: Bundle

metadata:
  name: bellkeeper
  class: product          # product | composition | capability | infrastructure | tool
  version: 2.4.0
  owner: singll/Bellkeeper
  labels:
    io.silkspool.product: bellkeeper

spec:
  compatibility:
    spool: ">=1.2"

  delivery:
    driver: compose       # compose | stack | script
    templates:
      - 00-base.yaml
      - 10-app.yaml

  outputs:
    url: "${input.public_url}"
    health: "${input.public_url}/api/health"

  lifecycle:
    health:
      http: "${outputs.health}"
      timeout: 60s
    upgrade:
      strategy: recreate  # recreate | rolling | backup-then-recreate
      irreversible: false # true 时禁止自动回滚，必须显式确认
    hooks:
      pre_upgrade: scripts/pre-upgrade.sh
      post_upgrade: scripts/post-upgrade.sh

  backup:
    assets:
      - type: volume
        source: kp-bellkeeper-uploads
```

**明确不放入契约的东西**

- 不写 `requires: postgres` 自动匹配；需要数据层时，在 composition 里显式引用 `silkdata`。
- 不做 `profiles`；minimal/full 用两个 composition 文件表达。
- 不把 secret 写进 manifest；只写 `secret://` 引用，值由 secret provider 提供。
- 不把跨机 IP 写进模板；由 outputs 或 Headscale MagicDNS 提供。

### 4.4 Product 与 Composition 示例

**Product：Bellkeeper（放在 Bellkeeper 仓库）**

```yaml
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: bellkeeper
  class: product
  version: 2.4.0

spec:
  delivery:
    driver: compose
    artifact:
      type: image
      image: ghcr.io/singll/bellkeeper
      digest: sha256:...
    templates:
      - deploy/compose.yaml

  outputs:
    url: "${input.public_url}"
    health: "${input.public_url}/api/health"

  lifecycle:
    health:
      http: "${outputs.health}"
      timeout: 60s
    upgrade:
      strategy: backup-then-recreate
      migrate: /app/bellkeeper migrate
      irreversible: false

  backup:
    assets:
      - type: volume
        source: kp-bellkeeper-uploads
```

**Composition：knowledge-stack（放在 SilkSpool 仓库）**

```yaml
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: knowledge-stack
  class: composition

spec:
  components:
    data:
      bundle: silkdata
      version: 1.2.0
      source: { type: dir, path: bundles/silkdata }

    bellkeeper:
      bundle: bellkeeper
      version: 2.4.0
      source:
        type: git
        repo: https://github.com/singll/Bellkeeper.git
        path: deploy
        commit: <pinned-sha>

    n8n:
      image: docker.n8n.io/n8nio/n8n:1.62.1@sha256:...
      config: components/n8n/

    memos:
      image: neosmemo/memos:0.22.3@sha256:...

    rsshub:
      image: diygod/rsshub:2025-01-01@sha256:...

  after: [data]          # 只表达启动顺序，不做能力解析

  wiring:
    bellkeeper:
      DB_HOST: "${bundles.data.outputs.postgres_host}"
      DB_PORT: "${bundles.data.outputs.postgres_port}"
      REDIS_URL: "${bundles.data.outputs.redis_url}"
      MEILI_URL: "${bundles.data.outputs.search_url}"
    n8n:
      N8N_ENCRYPTION_KEY: "${secrets.n8n_encryption_key}"
```

**Capability：silkdata**

```yaml
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: silkdata
  class: capability

spec:
  delivery:
    driver: compose
    templates: [10-redis.yaml, 12-meilisearch.yaml, 15-nats.yaml, 40-couchdb.yaml, 50-postgres.yaml]

  outputs:
    postgres_host: "${host.address}"
    postgres_port: "5432"
    redis_url: "redis://:${secrets.redis_password}@${host.address}:6379/0"
    search_url: "http://${host.address}:7700"
```

**关键点**

- composition 不写 `requires`，只写 `components` 和 `wiring`。
- 所有版本都是精确版本或 digest；没有 `^2.4` 这类范围，避免引入 solver。
- `source` 是显式的：`dir` 或 `git`（P1 只支持这两种）。
- `after` 只影响 apply 顺序，不参与版本解析。

**表达式命名空间**

| 表达式 | 来源 | 示例 |
|---|---|---|
| `${input.<key>}` | host/bundle 输入 | `${input.public_url}` |
| `${host.name}` | 目标 host 别名 | `keeper` |
| `${host.address}` | 目标 host 网络地址（去掉 SSH 用户前缀） | `192.168.7.231` |
| `${host.ssh}` | 目标 host 的 SSH 地址 | `silkspool@192.168.7.231` |
| `${outputs.<key>}` | 当前 bundle 自己的输出 | `${outputs.health}` |
| `${bundles.<name>.outputs.<key>}` | 同一 host 上另一个 bundle 的输出 | `${bundles.data.outputs.postgres_host}` |
| `${secrets.<key>}` | secret provider | `${secrets.n8n_encryption_key}` |

只做字符串插值，不执行任意表达式或 shell；未解析的引用在 plan 阶段直接报错。

`outputs` 可标记 `sensitive: true`，此时 `inventory`/API 只返回 `***` 或引用，不返回明文。`lock` 只保存 secret 引用和哈希，不保存 secret 值。

### 4.5 Resolver 语义（保持简单）

`spool plan` 做且只做：

1. 读取目标 host 的 composition manifest。
2. 解析 `components` 里的 `source` 和精确版本。
3. 检查 `wiring` 引用的 `bundles.<name>.outputs.<key>` 是否存在。
4. 用 DFS 检查循环引用（只检查 composition → component 的 `after`/引用）。
5. 渲染最终 compose/env/override。
6. 生成 lock 快照。

不做：

- 不做 semver 范围求解。
- 不自动选择 provider。
- 不做跨主机运行时发现。
- 不在 apply 时重新解析依赖。

**Lock 快照（不是依赖锁）**

```yaml
# .spool/lock/keeper/knowledge-stack.yaml
version: 1
host: keeper
bundle: knowledge-stack
inputs_hash: sha256:...
resolved:
  data:
    source: {type: dir, path: bundles/silkdata}
    version: 1.2.0
    outputs:
      postgres_host: silkdata
      postgres_port: 5432
  bellkeeper:
    source: {type: git, repo: ..., commit: abc123}
    version: 2.4.0
    image: ghcr.io/singll/bellkeeper@sha256:...
  n8n:
    image: docker.n8n.io/n8nio/n8n:1.62.1@sha256:...
rendered:
  compose_sha256: ...
```

`spool apply --locked` 只使用 lock 中的 resolved 结果；如果 plan 结果与 lock 不一致则拒绝执行。这样可以复现上一次部署，但不引入 solver。

### 4.6 跨机 wiring

**优先级**

1. 如果已有 Headscale：直接使用 tailnet MagicDNS 名称（稳定、无需自己实现 discovery）。
2. 如果没有 Headscale：使用 `silkspool.yaml` 中显式配置的地址/域名，由 spool 在渲染时注入。
3. 不要在 bundle 模板里写 IP。

**渲染方式**

- 生成 `.env` 或 `docker-compose.spool.yaml` override。
- 不再手写 `extra_hosts`；如果必须用 `extra_hosts`，由 spool 根据 outputs 生成。
- 跨机端口默认只绑定 tailnet/私网地址；公网暴露必须显式声明。

**IP 漂移**

- `plan` 比较 lock 中的 outputs 与当前解析结果，变化时给出 diff。
- 使用 MagicDNS 时通常无感；使用静态地址时，`apply` 重新生成 override。
- 不承诺运行时自动重连；这是 DNS/网络的职责，不是 spool 的。

**Bundle 来源（P1）**

```yaml
bundle_sources:
  - name: bellkeeper
    type: git
    repo: https://github.com/singll/Bellkeeper.git
    path: deploy
    commit: <pinned-sha>
  - name: local
    type: dir
    path: ./bundles
```

只支持 `dir` 和 `git`；`git` 必须固定 commit，不使用 `latest` 分支。OCI source 推迟到 P3。

---

## 5. Plan / Apply / State / Labels

### 5.1 目录布局

```text
.spool/
├── lock/<host>/<bundle>.yaml      # 可复现的 resolved 快照
├── state/<host>/<bundle>.yaml     # 缓存：资源 ID、generation、compose hash
├── cache/bundles/<name>/<ref>/    # git/dir source 缓存
└── deploy.lock                    # 防并发部署
```

**真相顺序**

1. manifest（bundle 声明）
2. 远端 compose/override 文件
3. 远端资源标签
4. `.spool/state`（缓存，可重建）

### 5.2 资源标签

所有 spool 管理的容器/卷/网络打标：

```yaml
labels:
  io.silkspool.managed: "true"
  io.silkspool.host: "keeper"
  io.silkspool.bundle: "knowledge-stack"
  io.silkspool.component: "bellkeeper"
  io.silkspool.version: "2.4.0"
  io.silkspool.generation: "7"
  io.silkspool.lock-hash: "sha256:..."
```

用途：

- `inventory`/`status` 发现资源，不靠容器名。
- GC 只清理带 `io.silkspool.managed=true` 且属于当前 bundle 的资源。
- drift 检测：远端标签与 lock/state 不一致时报告。

### 5.3 文件即真相：生成 override，而不是深度合并

**停止** 把多个模板 `deepMerge` 成一个 `docker-compose.yaml`。这违反 Dockge 的“文件即真相”，也会让列表/锚点语义失真。

**改为**：

```text
/opt/silkspool/knowledge-stack/
├── docker-compose.yaml          # bundle 原始模板（人类可读、可直接 docker compose）
├── docker-compose.spool.yaml    # spool 生成：labels、env、extra_hosts、digest
├── .env                         # 该 bundle 的变量
└── ...
```

运行：

```bash
docker compose -f docker-compose.yaml -f docker-compose.spool.yaml up -d
```

好处：

- 用户仍可手动 `docker compose` 操作。
- spool 的注入项集中在 override，diff 清晰。
- 不再需要自研 YAML 合并语义。
- 符合 Docker Compose 官方 merge 规则。

`spool bundle render <name> <host>` 输出最终两个文件的内容；`spool bundle diff` 显示 override 变化。

### 5.4 命令形态

保留现有命令作为兼容层，新增：

```bash
spool inventory --json
spool plan <bundle> <host> --json
spool apply <bundle> <host> [--locked] [--dry-run] [--yes]
spool rollback <bundle> <host> [generation]
spool bundle outputs <name> --json
spool bundle render <name> <host>
```

旧命令映射：

- `bundle <name> setup <host>` → `apply`
- `bundle <name> up <host>` → `apply --skip-plan`（兼容）
- `bundle <name> status <host>` → `status --json` 的人类输出
- `upgrade <host>` → 保留，内部调用 `apply`

---

## 6. 升级与回滚（magic rollback）

借鉴 deploy-rs 与 Kamal，但明确边界。

### 6.1 流程

```text
plan
  → acquire deploy.lock
  → snapshot（state/compose/env + 必要的数据备份标记）
  → pull image by digest
  → render override
  → apply（docker compose up -d / systemctl restart）
  → health gate（HTTP/TCP/command + timeout）
  → confirm（SSH 回连 + 可选人工确认窗口）
  → success：写 state + generation++
  → failure：自动 rollback 到上一 generation，再健康检查
```

### 6.2 不可逆迁移

自动回滚不能撤销数据库迁移。因此：

- manifest 声明 `lifecycle.upgrade.irreversible: true`。
- 为 true 时：
  - 必须先生成数据备份（`backup` assets）。
  - `apply` 在健康检查失败后**不自动回滚**，而是停在 `needs_attention`，输出回滚命令和备份位置。
  - 必须显式 `--allow-irreversible` 才允许执行迁移。
- 为 false 时：允许自动回滚。

这是对“magic rollback”承诺的必要修正，避免给用户错误的安全感。

### 6.3 保留与清理

- 默认保留最近 2 个 generation 的 compose/env/digest 元数据。
- 旧镜像/容器按 Kamal 的 `retain_containers` 思路保留 N 个，避免回滚时重新拉取。
- GC 只清理 spool 标签匹配且超过保留期的资源。

### 6.4 并发控制

- `.spool/deploy.lock` 文件锁；同一 host 同时只允许一个 apply。
- 失败/中断后锁自动释放；`spool unlock <host>` 手动恢复。

---

## 7. 对外集成接口（只做两层）

### 7.1 L1：全命令 `--json`

统一 envelope：

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "warnings": [],
  "job_id": null
}
```

约定：

- stdout 只放 JSON；日志/进度到 stderr。
- 统一退出码：
  - `0` 成功
  - `2` 参数/配置错误
  - `3` plan 有 diff（可用于 CI 门禁）
  - `4` 执行失败
  - `5` 需要审批/不可逆操作未确认
- `spool inventory --json` 是其他工具的首选只读入口。

### 7.2 L2：`spool serve --socket`

可选的本地 HTTP/JSON 服务，不做常驻 Core：

```bash
spool serve --socket /run/spool.sock
```

最小端点：

```text
GET  /v1/inventory
GET  /v1/hosts/{host}/bundles/{bundle}
GET  /v1/hosts/{host}/bundles/{bundle}/outputs
POST /v1/actions
GET  /v1/jobs/{id}
```

Action 模型：

```json
POST /v1/actions
{
  "action": "bundle.apply",
  "target": {"host": "keeper", "bundle": "knowledge-stack"},
  "options": {"dry_run": false, "locked": true},
  "idempotency_key": "deploy-2026-10-23-001"
}
```

```json
202 Accepted
{"job_id": "job_01J..."}
```

```json
GET /v1/jobs/job_01J...
{
  "state": "succeeded",
  "started_at": "...",
  "finished_at": "...",
  "result": {"generation": 7}
}
```

安全：

- Unix socket 文件权限 `0600`，默认只允许当前用户。
- 可选 token + scope：`read` / `deploy` / `admin`。
- 危险动作要求显式 `yes: true` 或审批 token。
- 审计日志写本地文件，记录 actor、action、target、idempotency_key、结果。

**明确不做**

- 不做 NATS/SSE/Webhook Events（等第一个真实订阅者）。
- 不手写 SDK；发布 OpenAPI，客户端生成。
- 不做进程外插件协议；`pkg/driver` 公开 Go interface 即可。

### 7.3 消费方建议

| 消费方 | 推荐方式 | 说明 |
|---|---|---|
| Bellkeeper | Product bundle + `/v1/actions` + `outputs` | 自己发布 bundle；不直接 SSH |
| n8n | HTTP 节点调用 `/v1/actions` | 带 `Idempotency-Key`；轮询 job |
| CI/CD | `spool plan --json` + `spool apply --locked` | 退出码 3 表示有 diff |
| Grafana/Prometheus | `spool inventory --json` | 或读取资源标签做发现 |
| SilkSecAgent | 只读 scope 的 inventory | 不返回 secret 明文 |
| SilkRDP | DNS/Site/Bundle action | 通过同一 action API |
| AI Agent | 只读 + dry-run + 审批 | 危险操作必须人工确认 |

---

## 8. Keeper 拆分（P2 验证样板）

### 8.1 目标结构

```text
Bellkeeper 仓库
└── deploy/
    ├── bundle.yaml          # class: product
    ├── compose.yaml
    └── scripts/

SilkSpool 仓库
├── bundles/silkdata/        # class: capability
└── bundles/knowledge-stack/ # class: composition
    ├── manifest.yaml
    └── components/
        ├── n8n/
        ├── memos/
        └── rsshub/
```

### 8.2 拆分规则

- `bellkeeper`：只声明镜像/digest、输入、输出、health、migration、backup。
- `silkdata`：只声明 Postgres/Redis/Meili/NATS/CouchDB 的 outputs。
- `knowledge-stack`：只声明 components、`after`、wiring；不包含 Bellkeeper 内部配置。
- `keeper` 作为 `knowledge-stack` 的兼容别名保留一个版本，输出弃用警告。
- 删除 `keeper` 模板中重复的数据服务定义和所有跨机 IP。

### 8.3 验收标准

1. 修改 Bellkeeper 不需要改 SilkSpool 仓库：Bellkeeper 通过 `source: git` 发布自己的 bundle。
2. `knowledge-stack` 模板中零 IP、零容器名硬编码；只出现 `outputs` 引用和 Headscale MagicDNS 名称。
3. `spool plan` 能输出 desired vs actual diff；`spool apply --locked` 能复现上一次部署。
4. 健康检查失败时 `spool rollback` 能恢复到上一 generation。
5. 远端 `docker compose -f docker-compose.yaml -f docker-compose.spool.yaml up -d` 仍可手动执行。

---

## 9. 路线图

### P0（1-2 周）：清理，不引入新架构

- 删除 `compose_driver.go` 中的 `svc == "bellkeeper"` 特判。
- 删除 `resolveDeployPath` 的 sync-rule 反推；改为 manifest `deploy_path` 或 state 显式记录。
- 所有读命令 + `bundle` 命令支持 `--json` 和统一 envelope。
- 资源标签注入 `docker-compose.spool.yaml` override。
- per-bundle `.env` 与 bundle 级 `sync_rules`；同步失败必须返回错误。
- 镜像全部改为精确 tag + digest（至少 keeper/silkdata/observability）。
- `spool inventory --json` 最小实现：hosts + bundles + services + labels + status。
- 补测试：JSON envelope、标签、per-bundle 配置、路径解析。

**退出标准**：新增一个简单 product bundle 不需要改内核；`spool inventory --json` 可供 n8n 消费。

### P1（2-3 周）：轻契约 + plan/apply + rollback

- 增加 `apiVersion/class/outputs/wiring/lifecycle/backup` 字段，兼容旧 manifest。
- 实现 `plan`/`apply`/`rollback`，lock 快照 + `--locked`。
- 用 Compose 多文件 `-f` + override 替代 `deepMerge`。
- `bundle_sources: dir | git`（git 固定 commit）。
- magic rollback + deploy lock + health gate + generation 保留。
- `pkg/driver` 公开 `BundleDriver`；`internal/engine` 继续持有实现。
- Resource adapter：Bundle、Service、DNSRecord、Site 接入 `inventory/status`。

**退出标准**：`spool plan` 能显示 diff；`spool apply --locked` 可复现；升级失败可自动回滚（不可逆迁移除外）。

### P2（2-4 周）：keeper 拆分 + 本地 API

- 按第 8 节拆分 keeper。
- Bellkeeper 仓库发布 `deploy/bundle.yaml`。
- Headscale MagicDNS wiring；移除 `extra_hosts` IP。
- `spool serve --socket`：inventory、outputs、actions、jobs。
- 消费方示例：n8n HTTP、Bellkeeper action、CI plan/apply。
- 文档：bundle-development、DEPLOYMENT、api 更新。

**退出标准**：第 8.3 的 5 条全部满足；n8n/Bellkeeper 不直接 SSH 即可触发部署与读取状态。

### P3（按需）：不提前建设

- OCI bundle artifact + cosign（照 Timoni 的布局）。
- CUE spike（仅当 composition 复杂度确实超过 YAML 能力）。
- Events/SSE/Webhook（仅当出现真实订阅者）。
- OpenAPI 生成 SDK。
- `spool adopt` 纳管既有 stack。
- TrueNAS/Key 资源接入统一 inventory。

**进入条件**：P2 完成且有一个明确的、无法用现有接口满足的消费方需求。

---

## 10. 明确砍掉/推迟

- 砍掉 capability 自动匹配市场（`requires: postgres` 自动找 provider）。
- 砍掉 profiles（minimal/full 用两个 composition 文件）。
- 砍掉五层接口中的 Events/SDK/插件协议。
- 砍掉完整 semver 依赖求解器。
- 砍掉跨机 discovery 实现；用 Headscale/MagicDNS 或显式地址。
- 砍掉 WireGuard mesh/corrosion 自研。
- 砍掉 Kubernetes/CRD/controller-runtime。
- 砍掉 Web UI、数据库、常驻 agent。
- 砍掉“让其他团队发布 bundle”的生态化设计；先只服务 Bellkeeper。
- 推迟 OCI/cosign、CUE、Events 到 P3。
- 不重写现有 DNS/Site/NAS/Backup 实现，只做 adapter。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 跨机 output 漂移 | 优先 MagicDNS；plan 显示 diff；静态地址集中在 host 配置，不进模板 |
| 不可逆迁移被自动回滚误导 | `irreversible: true` 禁止自动回滚；强制备份 + 显式确认 |
| CUE 学习/维护成本 | 只做 spike；P0/P1 用 YAML + JSON Schema + Compose 原生 merge |
| Resource 抽象过度 | 只包装现有 manager；接口保持 3-4 个方法；不支持的动词明确报错 |
| 公开 `pkg/driver` 破坏兼容 | 接口加版本/能力协商；internal 实现可自由重构 |
| `--json` 改变现有脚本 | 默认保持人类输出；`--json` 显式开启；envelope 稳定 |
| 单人/小团队节奏 | 每阶段有退出标准；不跨阶段并行大改 |
| Compose merge 语义 | 使用官方 `-f` 合并 + 生成 override；不自研 deepMerge |
| 端口公网暴露 | 跨机依赖默认绑定 tailnet/私网；公网暴露需显式配置 |

---

## 12. 与现有代码的映射

| 现有位置 | 改动 |
|---|---|
| `internal/engine/compose_driver.go` | 删除 `bellkeeper` 特判；改为读取 lifecycle/health；生成 override |
| `internal/engine/bundle.go` | 删除 `resolveDeployPath` 反推；读 state/manifest 显式路径 |
| `internal/engine/bundle_manifest.go` | 增加 `apiVersion/class/outputs/wiring/lifecycle/backup`，保留旧字段 |
| `internal/engine/bundle_driver.go` | 迁到 `pkg/driver`；编译期注册 |
| `internal/engine/script_driver.go` | 保留为逃生口；升级走统一 lifecycle |
| `internal/engine/stack_driver.go` | 服务清单改用 manifest，host.Stack 仅作兼容 |
| `internal/engine/sync.go` | bundle 级 sync；失败返回错误 |
| `internal/config/types.go` | `host.services`/`host.backups` 标记 legacy；新配置进 bundle |
| `internal/cli/*` | 增加 `--json`、`plan/apply/rollback/inventory/serve` |
| `bundles/keeper/*` | P2 拆为 `knowledge-stack` + `silkdata` + 外部 `bellkeeper` |
| `bundles/silkdata/*` | 增加 outputs 声明；作为 capability |
| `Makefile` | 把 `bundles/` 作为示例/本地源；支持外部 source 缓存 |

---

## 13. 参考来源（2026-10-23 核对）

- Komodo Resources: <https://komo.do/docs/resources>
- Komodo Sync Resources: <https://komo.do/docs/automate/sync-resources>
- Komodo API: <https://komo.do/docs/ecosystem/api>
- Kamal configuration: <https://kamal-deploy.org/docs/configuration/overview/>
- Kamal proxy: <https://kamal-deploy.org/docs/configuration/proxy/>
- Kamal hooks: <https://kamal-deploy.org/docs/hooks/overview/>
- Kamal deploy: <https://kamal-deploy.org/docs/commands/deploy/>
- Kamal rollback: <https://kamal-deploy.org/docs/commands/rollback>
- Kamal healthcheck (v1): <https://kamal-deploy.org/v1/docs/configuration/healthchecks>
- Dockge README: <https://github.com/louislam/dockge>
- Uncloud design: <https://github.com/psviderski/uncloud/blob/main/misc/design.md>
- Uncloud README: <https://github.com/psviderski/uncloud>
- Timoni concepts: <https://timoni.sh/concepts>
- Timoni bundle: <https://timoni.sh/bundle>
- deploy-rs README: <https://github.com/serokell/deploy-rs>
- Docker Compose merge: <https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/>
- Docker Compose include: <https://docs.docker.com/compose/how-tos/multiple-compose-files/include/>

---

## 14. 实施进度（2026-10-23）

P0 已完成：

- [x] 删除 `compose_driver.go` 中 `svc == "bellkeeper"` 硬编码
- [x] manifest 支持显式 `deploy_path`，删除 sync-rule 路径反推
- [x] `spool inventory [--json] [--probe]`，输出主机/Bundle/服务/部署路径
- [x] manifest 增加 `apiVersion/kind/class/version/owner/labels` 字段
- [x] compose 渲染时注入 `io.silkspool.*` 资源标签（兼容 map/list labels）
- [x] `SyncHost` 聚合失败并返回 error，不再静默成功
- [x] `go test ./...`、`go vet ./...` 通过

P0 待完成：

- [ ] 所有读命令统一 `--json` envelope（目前 `inventory` 已支持）
- [ ] per-bundle `.env` 与 bundle 级 `sync_rules`
- [ ] keeper/silkdata/observability 镜像固定 digest
- [ ] `docker-compose.spool.yaml` override 替代 `deepMerge`（P1 起点）

P1/P2 未开始：`plan/apply/rollback`、magic rollback、`bundle_sources`、keeper 拆分、`spool serve`。

---

## 15. 一句话总结

> 不是把 SilkSpool 做成迷你 Crossplane，而是把它做成一个**agentless 的资源编排内核**：容器 bundle 用轻契约和显式 wiring，非容器资源复用现有 manager 并接入统一 inventory；其他工具只通过 `--json` 和本地 socket API 使用它，不直接 SSH。
