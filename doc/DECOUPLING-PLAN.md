# SilkSpool 解耦与集成改进方案（评审后修订版）

> 状态: Revised（P1 施工蓝图）
> 日期: 2026-10-23
> 依据: 对《SilkSpool 解耦与集成设计》的评审意见，以及对 Kamal、Komodo、Dockge、Uncloud、Timoni、deploy-rs 公开文档的核对
> 修订: 2026-10-23，按二次评审修正 outputs 拓扑语义、备份 hook、组件健康、锁粒度与 plan 语义；按三次评审拆分 components/dependencies、明确 health 执行上下文与 restore 契约
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
| P1 | 轻契约、显式 wiring、plan/apply、magic rollback（单 host） | 解决核心解耦与升级安全 |
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
| capability 自动匹配市场 | 砍掉 | composition 只显式引用 `components.<key>.outputs.*` / `dependencies.<key>.outputs.*` |
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
2. **不做自动 capability 解析**。`requires: postgres` 自动找 provider 是 Crossplane 式设计，解析时机、IP 漂移、部分失败语义都很难；改为显式引用具体 component/dependency 的 outputs。
3. **不把 Events 作为 P1**。n8n/Bellkeeper/CI 用 `--json` 和 HTTP action 足够；Events 等真实订阅者出现再做。

---

## 3. 设计原则

1. **内核不认识应用名**。`internal/engine` 不出现 `bellkeeper`、`n8n`、`redis` 等产品/组件名。
2. **类别与驱动正交**。`class: product | composition | capability | infrastructure | tool` 与 `delivery.driver: compose | stack | script` 分开。
3. **显式引用，不做自动匹配**。composition 只能引用 `components.<key>.outputs.*` 或 `dependencies.<key>.outputs.*`，引用不存在则在 plan 阶段失败。
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
- P1 先接 `Bundle`、`Service`；`DNSRecord`、`Site` 可裁剪到 P2；`Dataset`、`Key` 在 P3 接入。
- `Backupable.Restore` 对应 `lifecycle.restore.hook`；未声明时返回 `manual`，而不是假装成功。
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
    internal:
      kind: endpoint
      service: bellkeeper
      port: 8080
      remote: "${host.magicdns}"

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
    restore:
      hook: scripts/restore.sh   # 可选；缺省时 restore 为人工流程

  backup:
    # 产品方提供的一致性备份入口；DB dump、应用导出等由产品自己实现
    hook: scripts/backup.sh
    assets:
      - type: volume
        source: kp-bellkeeper-uploads
```

`backup.hook` 在 `spool backup` 和 `backup-then-recreate` 升级前执行，wiring 注入的 DB/缓存凭据对它可用；spool 通过 `SPOOL_BACKUP_DIR` 指定产物目录，通过 `SPOOL_GENERATION` 传入当前 generation。`backup.assets` 只负责卷/目录等无一致性语义的对象。若产品无法提供 hook，可用 `type: exec` 作为通用逃生口，但必须显式声明命令和组件。

`lifecycle.restore.hook` 是备份的对称入口，spool 通过 `SPOOL_BACKUP_DIR` / `SPOOL_RESTORE_REF` 传入备份产物。未声明时 restore 明确按人工流程处理：spool 只负责列出产物路径和清单，不假装能自动恢复。

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
    internal:
      kind: endpoint
      service: bellkeeper
      port: 8080
      remote: "${host.magicdns}"

  lifecycle:
    health:
      http: "${outputs.health}"
      timeout: 60s
    upgrade:
      strategy: backup-then-recreate
      migrate: /app/bellkeeper migrate
      irreversible: false
    restore:
      hook: scripts/restore.sh

  backup:
    hook: scripts/backup.sh
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
  # components：本 composition 负责部署，全部位于 apply 的目标 host。
  components:
    bellkeeper:
      bundle: bellkeeper
      version: 2.4.0
      source:
        type: git
        repo: https://github.com/singll/Bellkeeper.git
        path: deploy
        commit: <pinned-sha>
      health:
        http: http://127.0.0.1:8080/api/health
        from: container

    n8n:
      image: docker.n8n.io/n8nio/n8n:1.62.1@sha256:...
      config: components/n8n/
      after: [bellkeeper]     # 同 host 组件启动顺序示例
      health:
        http: http://127.0.0.1:5678/healthz
        from: container

    memos:
      image: neosmemo/memos:0.22.3@sha256:...
      health:
        http: http://127.0.0.1:5230/healthz
        from: container

    rsshub:
      image: diygod/rsshub:2025-01-01@sha256:...
      optional: true          # 失败只告警，不触发整栈回滚；仍然会被部署
      health:
        http: http://127.0.0.1:1200/
        from: container

  # dependencies：已在别处部署，本 composition 只读 outputs，不 apply、不升级、不回滚。
  dependencies:
    data:
      bundle: silkdata
      version: 1.2.0
      host: silkdata          # provider 所在主机；用于 endpoint 拓扑解析
      outputs: [postgres, redis, search]

  wiring:
    bellkeeper:
      DB_HOST: "${dependencies.data.outputs.postgres.host}"
      DB_PORT: "${dependencies.data.outputs.postgres.port}"
      REDIS_URL: "redis://:${secrets.redis_password}@${dependencies.data.outputs.redis.host}:${dependencies.data.outputs.redis.port}/0"
      MEILI_URL: "http://${dependencies.data.outputs.search.host}:${dependencies.data.outputs.search.port}"
    n8n:
      N8N_ENCRYPTION_KEY: "${secrets.n8n_encryption_key}"
      BELLKEEPER_URL: "http://${components.bellkeeper.outputs.internal.host}:${components.bellkeeper.outputs.internal.port}"
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

  # endpoint 是逻辑输出，不把地址写死在 provider 里；
  # spool 按 consumer 与 provider 的拓扑位置决定 host/port。
  outputs:
    postgres:
      kind: endpoint
      service: postgres
      port: 5432
      published_port: 5432
      remote: "${host.magicdns}"
      protocol: postgres
    redis:
      kind: endpoint
      service: redis
      port: 6379
      published_port: 6379
      remote: "${host.magicdns}"
    search:
      kind: endpoint
      service: meilisearch
      port: 7700
      published_port: 7700
      remote: "${host.magicdns}"
    queue:
      kind: endpoint
      service: nats
      port: 4222
      published_port: 4222
      remote: "${host.magicdns}"
    couchdb:
      kind: endpoint
      service: couchdb
      port: 5984
      published_port: 5984
      remote: "${host.magicdns}"
```

**关键点**

- `components` 由本 composition 部署，全部位于 apply 的目标 host；P1 的 `spool apply <bundle> <host>` 不跨主机。
- `dependencies` 是已在别处部署的 bundle，只读 outputs；不 apply、不升级、不回滚。跨主机编排推迟到有真实需求。
- composition 不写 `requires`，只写 `components`、`dependencies` 和 `wiring`。
- 所有版本都是精确版本或 digest；没有 `^2.4` 这类范围，避免引入 solver。
- `source` 是显式的：`dir` 或 `git`（P1 只支持这两种）。
- `after` 是 **per-component** 的，只影响同 host 组件的 apply 顺序，不参与版本解析，也不能跨 dependencies 排序。
- `health` 支持 `http` / `tcp` / `command`；未声明时退化为“容器 running”检查。执行上下文见 6.1。
- `optional: true` 表示“失败不阻塞整栈”，不是“不部署”，也不是 profiles 的替代品。
- endpoint 的 `remote` 可省略：依次回退 `host.magicdns`、`host.address`；跨机时两者都缺失则 plan 失败。
- 含 `${secrets.*}` 的 wiring 自动视为 sensitive，plan 输出用 `secret://...` 占位。

**表达式命名空间**

| 表达式 | 来源 | 示例 |
|---|---|---|
| `${input.<key>}` | host/bundle 输入 | `${input.public_url}` |
| `${host.name}` | 目标 host 别名 | `keeper` |
| `${host.address}` | 目标 host 网络地址（去掉 SSH 用户前缀） | `192.168.7.231` |
| `${host.magicdns}` | 目标 host 的 Headscale MagicDNS 名；跨机解析优先使用 | `silkdata` |
| `${host.ssh}` | 目标 host 的 SSH 地址 | `silkspool@192.168.7.231` |
| `${outputs.<key>}` | 当前 bundle 自己的输出 | `${outputs.health}` |
| `${outputs.<key>.host}` / `.port` | endpoint 输出按拓扑解析后的地址/端口 | `${outputs.postgres.host}` |
| `${components.<key>.outputs.<key>}` | 本 composition 负责部署的组件输出 | `${components.bellkeeper.outputs.url}` |
| `${dependencies.<key>.outputs.<key>}` | 外部依赖 bundle 的输出 | `${dependencies.data.outputs.postgres.host}` |
| `${secrets.<key>}` | secret provider | `${secrets.n8n_encryption_key}` |

只做字符串插值，不执行任意表达式或 shell；未解析的引用在 plan 阶段直接报错。

**不支持** `${hosts.<h>.bundles...}` 或 `${bundles.<name>...}` 这类隐式跨 host 引用。组件引用统一走 `components.<key>`，外部依赖统一走 `dependencies.<key>`；跨机地址只能由 dependency 的 `host` + endpoint 解析或显式 `input` 提供。

`outputs` 可标记 `sensitive: true`，此时 `inventory`/API 只返回 `***` 或引用，不返回明文。含 `${secrets.*}` 的 wiring 自动视为 sensitive。`lock` 只保存 secret 引用和哈希，不保存 secret 值；plan 阶段对 sensitive 表达式只渲染 `secret://...` 占位，不要求 secret provider 在线。

### 4.5 Resolver 语义（保持简单）

`spool plan` 做且只做：

1. 读取目标 host 的 composition manifest。
2. 解析 `components` 里的 `source` 和精确版本；P1 要求所有 components 都部署在同一个目标 host。
3. 解析 `dependencies` 的 `bundle/version/host/outputs` 契约；读取其 outputs，但**不 apply、不升级、不回滚**。
4. 检查 `wiring` 引用的 `components.<key>.outputs.*` / `dependencies.<key>.outputs.*` 是否存在；endpoint 输出按 dependency host 与目标 host 的拓扑关系解析为服务名或 MagicDNS/地址。
5. 用 DFS 检查 **per-component `after`** 形成的 DAG，拒绝循环；dependencies 不参与 `after` 排序，默认已就绪。
6. 渲染最终 compose/env/override。
7. 生成 lock 快照。

不做：

- 不做 semver 范围求解。
- 不自动选择 provider。
- 不做跨主机 apply 编排；`spool apply <bundle> <host>` 只操作目标 host。
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
  components:
    bellkeeper:
      host: keeper
      source: {type: git, repo: ..., commit: abc123}
      version: 2.4.0
      image: ghcr.io/singll/bellkeeper@sha256:...
      outputs:
        # consumer=n8n, provider=bellkeeper → 同机同 project，解析为服务名
        internal: {kind: endpoint, host: bellkeeper, port: 8080}
    n8n:
      host: keeper
      image: docker.n8n.io/n8nio/n8n:1.62.1@sha256:...
  dependencies:
    data:
      host: silkdata
      source: {type: dir, path: bundles/silkdata}
      version: 1.2.0
      outputs:
        # consumer=keeper, provider=silkdata → 跨机，解析为 MagicDNS
        postgres: {kind: endpoint, host: silkdata, port: 5432}
        redis:    {kind: endpoint, host: silkdata, port: 6379}
        search:   {kind: endpoint, host: silkdata, port: 7700}
rendered:
  compose_sha256: ...
```

> 如果 dependency 与目标 host 相同、且在同一 compose project/network，`postgres.host` 会解析为服务名（如 `postgres`），而不是 MagicDNS 地址。lock 记录的是**本次拓扑下的解析结果**，不是 provider 的固有属性。

P1 的 apply 只使用 `resolved.components`；`resolved.dependencies` 仅用于渲染 wiring，不会被 apply 或回滚。

`spool apply --locked` 只使用 lock 中的 resolved 结果；如果 plan 结果与 lock 不一致则拒绝执行。这样可以复现上一次部署，但不引入 solver。

**online / offline plan**

- `spool plan` 默认 online：SSH 读取远端实际状态，产出 desired vs actual diff；有 diff 时退出码 3。
- `spool plan --offline`：只做静态校验（schema、引用存在性、循环、渲染），不连接远端，不产出 drift diff；退出码 0（合法）或 2（非法）。
- CI 可在 PR 阶段用 `--offline` 做契约校验，在部署门禁阶段用 online plan。
- 两种模式都对 sensitive 表达式输出 `secret://...` 占位，不要求 secret provider 在线。

### 4.6 跨机 wiring 与拓扑解析

endpoint 输出不是固定地址，解析结果取决于 consumer 与 provider 的拓扑位置：

| 场景 | `host` | `port` | 说明 |
|---|---|---|---|
| 同 host + 同 compose project/network | 服务名（如 `postgres`） | 容器端口（5432） | 不发布宿主端口，避免 hairpin NAT |
| 同 host + 不同 compose project | 共享网络的 service alias；否则 `host.address` | 容器端口或 `published_port` | 优先配置共享网络；否则宿主 IP + 发布端口 |
| 跨 host | `remote`（MagicDNS）或 `host.address` | `published_port` | 端口只绑定 tailnet/私网 |

拓扑信息在 **plan 时**由 `dependencies.<key>.host`（外部 provider）或目标 host（同机 component）与目标 host 比较得到，不做运行时 discovery。composition 默认把同 host 的 components 渲染进同一个 compose project/网络；如果显式拆成不同 project，则走“不同 project”分支。没有 `host.magicdns` 时，跨机解析回退到显式地址；两者都没有则 plan 失败。

P1 只对目标 host 上的 components 执行 apply/health/rollback；dependencies 仅用于 outputs 解析。跨主机一次 apply 的锁顺序、部分失败回滚和跨机 DAG 不在 P1 范围内。

**优先级**

1. 如果已有 Headscale：直接使用 tailnet MagicDNS 名称（稳定、无需自己实现 discovery）。
2. 如果没有 Headscale：使用 `silkspool.yaml` 中显式配置的地址/域名，由 spool 在渲染时注入。
3. 不要在 bundle 模板里写 IP。

**渲染方式**

- 生成 `.env` 或 `docker-compose.spool.yaml` override。
- 同机同 project 不发布端口；同机不同 project 优先共享网络；跨机才使用 `published_port`。
- 不再手写 `extra_hosts`；如果必须用 `extra_hosts`，由 spool 根据解析后的 endpoint 生成。
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
├── state/<host>/<bundle>.yaml     # 本地索引：资源 ID、当前 generation、compose hash
├── cache/bundles/<name>/<ref>/    # git/dir source 缓存
└── locks/<host>.lock              # 每主机一把部署锁

/opt/silkspool/<bundle>/           # 远端
└── .spool-gen/<n>/                # compose/env/digest 快照，回滚以远端为准
```

**真相顺序**

1. manifest（bundle 声明）
2. 远端 compose/override 文件与 `.spool-gen` 快照
3. 远端资源标签
4. `.spool/state`（本地缓存，可重建；控制机重装不会丢失回滚能力）

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
├── .spool-gen/<n>/              # 历史 generation 快照（compose/env/digest）
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
spool plan <bundle> <host> [--offline] --json
spool apply <bundle> <host> [--locked] [--dry-run] [--yes]
spool rollback <bundle> <host> [generation]
spool bundle outputs <name> --json
spool bundle outputs <name> --for <consumer>@<host> --json
spool bundle render <name> <host>
```

`bundle outputs` 默认返回**未解析的逻辑声明**（endpoint 的 service/port/remote 等）；加 `--for <consumer>@<host>` 才按目标拓扑返回解析后的 host/port。这样其他工具可以区分“契约”与“本次部署的实际地址”。

旧命令映射：

- `bundle <name> setup <host>` → `apply`
- `bundle <name> up <host>` → `apply`；无 diff 时自动继续，有 diff 时打印摘要并要求 `--yes`。`--skip-plan` 保留但输出弃用警告。
- `bundle <name> status <host>` → `status --json` 的人类输出
- `upgrade <host>` → 保留，内部调用 `apply`

**script driver 的 plan 语义**

脚本副作用不可预知，`script` 驱动的 `Plan` 返回 `unsupported`（或仅做静态校验：模板存在、引用合法）。`apply` 直接执行，但必须：

- 在输出中标注 `未经 diff 确认`；
- 非交互/CI 环境要求显式 `--yes`；
- 不把 script driver 的“成功”当作 health gate 已通过；仍要求 `lifecycle.health` 或人工确认。

---

## 6. 升级与回滚（magic rollback）

借鉴 deploy-rs 与 Kamal，但明确边界。

### 6.1 流程

```text
plan（online 读 actual；offline 仅静态校验）
  → acquire locks/<host>.lock
  → snapshot（远端 .spool-gen/<n> + 必要的数据备份）
  → pull image by digest
  → render override
  → apply（docker compose up -d / systemctl restart）
  → health gate（所有非 optional 组件：HTTP/TCP/command + timeout）
  → confirm（SSH 回连 + 可选人工确认窗口）
  → success：写 state + generation++
  → failure：自动 rollback 到上一 generation，再健康检查
```

**composition 健康聚合**

- 每个组件独立声明 `health`；未声明时退化为“容器 running”。
- composition 健康 = 所有 **非 optional** 组件健康的逻辑与。
- `optional: true` 组件失败只告警，不触发整栈回滚；它仍然会被部署。
- 单组件 `health` 超时默认 60s；整个 composition 的 gate 超时可配置。
- script driver 没有可观测 health 时，必须人工确认，不能默认成功。

**health 执行上下文**

- 默认 `from: container`：在目标 host 上通过 `docker compose exec` 进入 `exec_in` 指定的容器（缺省为组件主服务）执行；`127.0.0.1` 是容器内地址。
- `http`/`tcp` 目标若未发布到宿主，spool 仍在 compose 网络内用 one-shot 容器或 `exec` 检查；跨服务检查用服务名，不用宿主 IP。
- `command` 在 `exec_in` 容器内执行；例如 `pg_isready` 应声明 `exec_in: postgres`。
- `from: host` 仅用于已发布到宿主/目标的端口；此时 `127.0.0.1` 才是 host-local。
- dependencies 不参与本次 apply 的 health gate；需要时用 `--probe` 从目标 host 做只读连通性检查。

```yaml
health:
  from: container
  exec_in: postgres
  command: ["pg_isready", "-U", "bellkeeper"]
  timeout: 30s
```

### 6.2 不可逆迁移

自动回滚不能撤销数据库迁移。因此：

- manifest 声明 `lifecycle.upgrade.irreversible: true`。
- 为 true 时：
  - 必须先生成数据备份：调用产品方 `backup.hook`，并处理 `backup.assets`。
  - `apply` 在健康检查失败后**不自动回滚**，而是停在 `needs_attention`，输出回滚命令和备份位置。
  - 必须显式 `--allow-irreversible` 才允许执行迁移。
- 为 false 时：允许自动回滚。

DB dump、应用导出等一致性备份由产品方 hook 负责；spool 不猜测数据库凭据，也不假设 bellkeeper 容器内有 PG 客户端。这与“整装应用生命周期由产品方负责”的原则一致。

restore 方向保持对称：声明 `lifecycle.restore.hook` 时由 spool 编排调用；未声明时 spool 只输出备份产物路径/清单，明确标记为人工恢复，不提供假的自动 restore。这样 4.1 的 `Backupable.Restore` 与产品契约不会失衡。

这是对“magic rollback”承诺的必要修正，避免给用户错误的安全感。

### 6.3 保留与清理

- generation 快照存放在**远端** bundle 目录的 `.spool-gen/<n>/`（compose/env/digest/meta），本地 `.spool/state` 只保存索引。
- 默认保留最近 2 个 generation；控制机重装后仍可从远端回滚。
- 旧镜像/容器按 Kamal 的 `retain_containers` 思路保留 N 个，避免回滚时重新拉取。
- GC 只清理 spool 标签匹配且超过保留期的资源。
- digest 固定后的更新流转：P2 提供 `spool bundle check-updates` 列出可更新镜像；可用 Renovate/Dependabot 或人工修改 manifest 后重新 plan/apply。不能只依赖“记得改 digest”。

### 6.4 并发控制

- `.spool/locks/<host>.lock` 文件锁；同一 host 同时只允许一个 apply，不同 host 可并行。
- `spool serve` 的 job 在开始时 acquire 对应 host 锁；同 host 的 job 排队，而不是直接失败。
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
  - `2` 参数/配置错误（含 offline plan 非法）
  - `3` **online** plan 有 diff（可用于 CI 门禁；`--offline` 不返回 3）
  - `4` 执行失败
  - `5` 需要审批/不可逆操作未确认
- `spool inventory --json` 是其他工具的首选只读入口。
- sensitive 表达式在 plan 中渲染为 `secret://...` 占位；只有 apply 才解析 secret provider。

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

Job 生命周期：`queued → running → succeeded/failed`。同 host 的 job 通过 `locks/<host>.lock` 排队；不同 host 并行。相同 `idempotency_key` 在未完成期间复用同一个 job。`bundle.apply` 只 apply components；`dependencies` 只读 outputs。

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
| CI/CD | `spool plan --json`（PR 用 `--offline`）+ `spool apply --locked` | 仅 online plan 的退出码 3 表示有 drift |
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

- `bellkeeper`：只声明镜像/digest、输入、输出、health、migration、backup/restore。
- `silkdata`：只声明 Postgres/Redis/Meili/NATS/CouchDB 的 outputs；作为 composition 的 **dependency**。
- `knowledge-stack`：声明 `components`（bellkeeper/n8n/memos/rsshub）+ `dependencies`（data）+ per-component `after` + wiring；不包含 Bellkeeper 内部配置。
- `keeper` 作为 `knowledge-stack` 的兼容别名保留一个版本，输出弃用警告。
- 删除 `keeper` 模板中重复的数据服务定义和所有跨机 IP。

### 8.3 验收标准

1. 修改 Bellkeeper 不需要改 SilkSpool 仓库：Bellkeeper 通过 `source: git` 发布自己的 bundle。
2. `knowledge-stack` 模板中零 IP、零容器名硬编码；同机案例（n8n → bellkeeper 的 `internal` endpoint）解析为服务名，跨机案例（bellkeeper → silkdata）解析为 Headscale MagicDNS。
3. `spool apply knowledge-stack keeper` 只操作 keeper，不 apply/升级/回滚 silkdata；dependency 的 outputs 只用于渲染。
4. `spool plan` 能输出 desired vs actual diff；`spool apply --locked` 能复现上一次部署。
5. 健康检查失败时 `spool rollback` 能恢复到上一 generation（含远端 `.spool-gen` 快照）。
6. 不可逆迁移升级前，产品 `backup.hook` 被调用且备份产物可定位；`restore.hook` 或人工恢复流程明确。
7. 远端 `docker compose -f docker-compose.yaml -f docker-compose.spool.yaml up -d` 仍可手动执行。

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

### P1（3-4 周）：轻契约 + plan/apply + rollback（单 host）

> 主链路优先：拓扑解析、DAG、plan/apply/rollback、bundle_sources、magic rollback。
> `DNSRecord`/`Site` 等 Resource adapter 与主链路解耦，可裁剪到 P2，不阻塞 P1 退出。

- 增加 `apiVersion/class/outputs/wiring/lifecycle/backup` 字段，兼容旧 manifest。
- 实现 `plan`（online/offline）/`apply`/`rollback`，lock 快照 + `--locked`。
- endpoint outputs 的拓扑解析：同机服务名 / 跨机 MagicDNS；per-component `after` DAG。
- 明确 `components`（同 host 部署）与 `dependencies`（只读 outputs）语义；P1 只做单 host apply。
- 用 Compose 多文件 `-f` + override 替代 `deepMerge`。
- `bundle_sources: dir | git`（git 固定 commit）。
- magic rollback + per-host deploy lock + 组件级 health gate + 远端 generation 快照。
- 产品 `backup.hook` 在 backup-then-recreate / 不可逆迁移前执行；`lifecycle.restore.hook` 在显式 restore 时执行。
- script driver 的 plan 返回 unsupported/静态校验，apply 要求显式确认。
- `pkg/driver` 公开 `BundleDriver`；`internal/engine` 继续持有实现。
- Resource adapter（可裁剪到 P2）：Bundle、Service 先接；DNSRecord、Site 后接。

**退出标准**：`spool plan` 能显示 diff；`spool apply --locked` 可复现；升级失败可自动回滚（不可逆迁移除外）；dependencies 不被 apply。

### P2（2-4 周）：keeper 拆分 + 本地 API

- 按第 8 节拆分 keeper。
- Bellkeeper 仓库发布 `deploy/bundle.yaml`。
- Headscale MagicDNS wiring；移除 `extra_hosts` IP。
- `spool serve --socket`：inventory、outputs、actions、jobs；job 按 host 锁排队。
- `spool bundle check-updates`：列出固定 digest 的可更新版本；接入 Renovate/Dependabot 或人工更新。
- 若 P1 未完成，补齐 DNSRecord/Site Resource adapter。
- 消费方示例：n8n HTTP、Bellkeeper action、CI plan/apply。
- 文档：bundle-development、DEPLOYMENT、api 更新。

**退出标准**：第 8.3 的 7 条全部满足；n8n/Bellkeeper 不直接 SSH 即可触发部署与读取状态。

### P3（按需）：不提前建设

- 跨主机 apply 编排：多 host 锁顺序、跨机 DAG、部分失败回滚范围。
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
- 砍掉 P1/P2 的跨主机 apply 编排；`dependencies` 只读 outputs，不 apply/升级/回滚。
- 砍掉自动跨主机 restore；无 `restore.hook` 时明确走人工流程。
- 推迟 OCI/cosign、CUE、Events 到 P3。
- 不重写现有 DNS/Site/NAS/Backup 实现，只做 adapter。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 跨机 output 漂移 | 优先 MagicDNS；plan 显示 diff；静态地址集中在 host 配置，不进模板 |
| 同机 hairpin NAT / 不必要端口暴露 | endpoint 拓扑解析：同机同 project 用服务名且不发布端口；不同 project 优先共享网络 |
| components/dependencies 语义混淆 | components 同 host 部署；dependencies 只读 outputs；P1 不做跨主机 apply |
| 多主机锁顺序/死锁 | P1 单 host apply；跨机编排推迟到 P3，未设计前不实现 |
| health 执行上下文歧义 | 明确 `from: container` / `from: host` 与 `exec_in`；未发布端口默认容器内检查 |
| 不可逆迁移被自动回滚误导 | `irreversible: true` 禁止自动回滚；强制 `backup.hook` + 显式确认 |
| `backup.hook` 缺失或失败 | `backup-then-recreate` / 不可逆迁移在 plan 阶段拒绝；apply 前再次校验 |
| restore 与 backup 不对称 | `lifecycle.restore.hook`；缺省时明确人工流程，spool 只定位产物 |
| digest 固定后长期不更新 | P2 `check-updates` + Renovate/Dependabot/人工更新流程 |
| offline plan 被误当 drift 门禁 | 明确 `--offline` 只做静态校验，永不返回退出码 3 |
| script driver 无真实 diff | plan 返回 unsupported；apply 标注“未经 diff 确认”并要求 `--yes` |
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
| `internal/engine/compose_driver.go` | 删除 `bellkeeper` 特判；读取 lifecycle/health；按 `from/exec_in` 执行 health；生成 override；注入组件标签 |
| `internal/engine/bundle.go` | 删除 `resolveDeployPath` 反推；读 state/manifest 显式路径；per-host lock |
| `internal/engine/bundle_manifest.go` | 增加 `apiVersion/class/outputs/wiring/lifecycle/backup`、组件 `health/optional`、restore hook，保留旧字段 |
| `internal/engine/resolver.go`（新增） | components/dependencies 分离、单 host 约束、endpoint 拓扑解析、per-component `after` DAG、lock 生成 |
| `internal/engine/backup.go` | 调用产品 `backup.hook` / `restore.hook`；远端 generation 快照 |
| `internal/engine/bundle_driver.go` | 迁到 `pkg/driver`；编译期注册 |
| `internal/engine/script_driver.go` | 保留为逃生口；Plan 返回 unsupported/静态校验；apply 显式确认 |
| `internal/engine/stack_driver.go` | 服务清单改用 manifest，host.Stack 仅作兼容 |
| `internal/engine/sync.go` | bundle 级 sync；失败返回错误 |
| `internal/config/types.go` | `host.services`/`host.backups` 标记 legacy；新配置进 bundle |
| `internal/cli/*` | 增加 `--json`、`plan --offline`、`apply/rollback/inventory/serve` |
| `bundles/keeper/*` | P2 拆为 `knowledge-stack`（components）+ `dependencies: data` + 外部 `bellkeeper` |
| `bundles/silkdata/*` | 增加 endpoint outputs 声明；Postgres 服务名改为 `postgres`；作为 capability/dependency |
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

---

## 16. 二次评审修订记录

| 评审项 | 修订位置 | 处理 |
|---|---|---|
| outputs 缺少网络上下文 | 4.4、4.5、4.6 | endpoint 输出 + plan 时拓扑解析；同机服务名、跨机 MagicDNS |
| 数据库备份能力被砍丢 | 4.3、4.4、6.2 | 产品方 `backup.hook` + `backup.assets`；不可逆迁移强制备份 |
| composition 组件无健康定义 | 4.4、6.1 | 组件级 `health` / `optional`；非 optional 的与运算 |
| `deploy.lock` 全局 vs per-host | 5.1、6.4 | 改为 `locks/<host>.lock`；同 host 排队、不同 host 并行 |
| `after` 顶层语义错误 | 4.4、4.5 | 移到 per-component，按组件构建 DAG |
| plan online/offline 未定义 | 4.5、5.4、7.1 | 默认 online；`--offline` 仅静态校验，永不返回 3 |
| generation 快照位置 | 5.1、6.3 | 远端 `.spool-gen/<n>/`；本地只存索引 |
| digest 更新流转缺失 | 6.3、P2 | `check-updates` + Renovate/Dependabot/人工流程 |
| script driver plan 语义 | 5.4 | Plan unsupported/静态校验；apply 显式确认 |
| `bundle up` 绕过 plan | 5.4 | 映射为 `apply`；有 diff 要求 `--yes`；`--skip-plan` 弃用警告 |
| sensitive 在 CI plan 失败 | 4.5、7.1 | plan 渲染 `secret://...` 占位，仅 apply 求值 |
| 跨 host 隐式引用 | 4.4 表达式表 | 明确不支持 `${hosts.<h>.bundles...}`，只走 input/MagicDNS |

---

## 17. 三次评审修订记录

| 评审项 | 修订位置 | 处理 |
|---|---|---|
| `component.host` 带来跨主机 apply 歧义 | 4.4、4.5、4.6、8.3、9、10 | 拆为 `components`（同 host 部署）与 `dependencies`（只读 outputs）；P1 单 host apply |
| health 执行上下文未定义 | 4.4、6.1 | 默认 `from: container`，支持 `exec_in`；未发布端口在容器/网络内检查 |
| restore 方向缺失 | 4.3、4.4、6.2、8.3 | 增加 `lifecycle.restore.hook`；缺省时明确人工流程 |
| silkdata 的 Postgres 服务名带消费者名 | 4.4、12 | 改为 `service: postgres` |
| wiring 命名不一致 | 4.4、4.5、8.3 | 统一为 `${components.<key>...}` / `${dependencies.<key>...}` |
| P1 工作量偏乐观 | 9 | 调整为 3-4 周；Resource adapter 可裁剪到 P2 |
| `bundle outputs` 语义不清 | 5.4 | 默认返回逻辑声明；`--for <consumer>@<host>` 返回拓扑解析结果 |
