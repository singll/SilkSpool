# 配置示例（现行）

> 最后更新：2026-10-24 · 适用 `spool` 1.2+
>
> 本文给出可直接改用的 `silkspool.yaml`、Bundle manifest、`.env` 与 OCI/cosign 示例。
> 所有 secret 均为占位符；实际值只写在 `hosts/<host>/.env`，不要提交。

---

## 1. 运行目录

```text
/opt/SilkSpool/
├── spool
├── silkspool.yaml
├── bundles/            # dir source / 本地示例
├── hosts/<host>/
│   └── .env            # secrets（gitignored）
├── keys/id_silkspool
└── known_hosts
```

`spool` 以二进制所在目录为 BaseDir；也可以 `spool --config /path/silkspool.yaml ...`。

---

## 2. `silkspool.yaml` 最小骨架

```yaml
global:
  ssh_key_path: "./keys/id_silkspool"
  default_domain: "example.com"
  backup_dir: "~/silkspool_backups"
  defaults:
    deploy_path: "/opt/silkspool"
    log_lines: 50
    docker_log_max: "50m"
    docker_log_num: 3

hosts:
  keeper:
    address: "silkspool@192.168.7.230"
    magicdns: "keeper"          # Headscale MagicDNS 名；跨机 wiring 优先使用
    app_prefix: "sp-"
    bundles: ["knowledge-stack"]
    inputs:                     # 覆盖 manifest 的 spec.inputs
      public_url: "https://bellkeeper.example.com"

  silkdata:
    address: "silkspool@192.168.7.231"
    magicdns: "silkdata"
    app_prefix: "sp-"
    bundles: ["silkdata"]

bundle_sources:
  - name: bellkeeper
    type: git
    repo: https://github.com/singll/Bellkeeper.git
    path: deploy
    commit: "<40-hex-pinned-commit>"
  - name: local
    type: dir
    path: ./bundles
```

> `bundle_sources` 从上到下匹配：先按 `name` 精确命中，再回退到 `dir` 父目录。`local` 指向运行时
> `/opt/SilkSpool/bundles/`（相对 BaseDir），不要把仓库路径写死。

---

## 3. Bundle 来源

### 3.1 本地 / git

```yaml
bundle_sources:
  - name: myapp
    type: dir
    path: ./bundles
  - name: product
    type: git
    repo: https://github.com/example/product.git
    path: deploy          # 仓库内子目录；可省略
    commit: "<7-40 hex>"  # 禁止分支/latest
```

### 3.2 OCI（digest 固定）

```yaml
bundle_sources:
  - name: bellkeeper
    type: oci
    ref: ghcr.io/singll/bellkeeper-bundle
    digest: "sha256:<64-hex-manifest-digest>"   # 必填
    path: deploy                                 # artifact 内子目录，可选
    # insecure: true                             # 仅测试/内网 http registry
    # username: robot
    # password_env: SPOOL_OCI_PASSWORD
    cosign:
      key: "./cosign.pub"                        # 或 identity + issuer（keyless）
      # identity: "https://github.com/singll/SilkSpool/.github/workflows/release.yml@refs/heads/main"
      # issuer: "https://token.actions.githubusercontent.com"
```

规则：

- `digest` 必须与拉取到的 manifest 内容一致；只写 tag 会被拒绝。
- 声明 `cosign` 即强制验签：找不到 cosign、无签名或验签失败都会报错，不会降级。
- artifact 内容放在 tar/tar+gzip layer，根目录包含 `manifest.yaml`/`bundle.yaml`。
- 拉取缓存：`.spool/cache/bundles/<name>/sha256-<digest>/`。

---

## 4. Secrets

### 4.1 文件位置

按优先级合并：

1. `hosts/<host>/.env`
2. `hosts/<host>/<bundle>/.env`

键名大小写不敏感（`secrets.redis_password` 可用 `REDIS_PASSWORD`）。

### 4.2 `hosts/keeper/.env` 示例

```dotenv
# --- Bellkeeper ---
BELLKEEPER_DB_PASSWORD=<random-password>
BELLKEEPER_API_KEY=<random-api-key>
BELLKEEPER_CREDENTIAL_KEY=<32-byte-hex>

# --- n8n ---
N8N_ENCRYPTION_KEY=<random-string>
N8N_API_KEY=<n8n-api-key>
N8N_OWNER_EMAIL=owner@example.com
N8N_OWNER_FIRSTNAME=Owner
N8N_PASSWORD=<random-password>

# --- silkdata / wiring ---
REDIS_PASSWORD=<random-password>
MEILI_MASTER_KEY=<random-master-key>

# --- Memos ---
MEMOS_API_TOKEN=<random-token>

# --- Matrix / LLM（按需） ---
MATRIX_BOT_ACCESS_TOKEN=<token>
LLM_DASHSCOPE_API_KEY=<key>
```

Plan 阶段只渲染 `secret://...` 占位；只有 apply 才解析真实值。

---

## 5. Composition：knowledge-stack

`bundles/knowledge-stack/manifest.yaml`（节选，完整文件在仓库）：

```yaml
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: knowledge-stack
  class: composition
  version: 1.0.0
name: knowledge-stack
type: compose
deploy_path: /opt/silkspool/keeper   # 迁移期沿用旧目录
config_root: host
spec:
  components:
    bellkeeper:
      bundle: bellkeeper
      version: 2.4.0
      health:
        http: http://localhost:8080/api/health
        from: container
        timeout: 120s
      outputs:
        internal:
          kind: endpoint
          service: bellkeeper
          port: 8080
          remote: "${host.magicdns}"

    n8n:
      bundle: n8n
      version: 1.62.1
      source: {type: dir, path: bundles/knowledge-stack/components/n8n}
      after: [bellkeeper]
      health: {http: "http://localhost:5678/healthz", from: container}

    rsshub:
      bundle: rsshub
      version: 2025-01-01
      source: {type: dir, path: bundles/knowledge-stack/components/rsshub}
      optional: true            # 失败只告警，不触发整栈回滚；仍会部署

  dependencies:
    data:
      bundle: silkdata
      version: 1.2.0
      host: silkdata            # provider 主机，用于 endpoint 拓扑
      outputs: [postgres, redis, search, queue, couchdb]

  wiring:
    bellkeeper:
      BELLKEEPER_DATABASE_HOST: "${dependencies.data.outputs.postgres.host}"
      BELLKEEPER_DATABASE_PORT: "${dependencies.data.outputs.postgres.port}"
      BELLKEEPER_DATABASE_PASSWORD: "${secrets.bellkeeper_db_password}"
      BELLKEEPER_API_KEY: "${secrets.bellkeeper_api_key}"
      BELLKEEPER_CREDENTIAL_KEY: "${secrets.bellkeeper_credential_key}"
      REDIS_HOST: "${dependencies.data.outputs.redis.host}"
      REDIS_PORT: "${dependencies.data.outputs.redis.port}"
      REDIS_PASSWORD: "${secrets.redis_password}"
      NATS_URL: "nats://${dependencies.data.outputs.queue.host}:${dependencies.data.outputs.queue.port}"
      MEILI_URL: "http://${dependencies.data.outputs.search.host}:${dependencies.data.outputs.search.port}"
      MEILI_MASTER_KEY: "${secrets.meili_master_key}"
    n8n:
      N8N_ENCRYPTION_KEY: "${secrets.n8n_encryption_key}"
      BELLKEEPER_URL: "http://${components.bellkeeper.outputs.internal.host}:${components.bellkeeper.outputs.internal.port}"
```

要点：

- `components` 只部署在 apply 的目标 host；`dependencies` 只读 outputs，不 apply/升级/回滚。
- 同机 endpoint 解析为服务名（`bellkeeper:8080`）；跨机解析为 `silkdata` 的 MagicDNS → address。
- `optional: true` 表示失败不阻塞整栈，不是“不部署”。
- `after` 只影响同 host 组件，不能跨 dependencies；apply 会把组件级 `after` 渲染为 Compose `depends_on`（`service_started`），保证实际启动顺序，而不仅是 plan 排序。

---

## 6. Capability：silkdata

```yaml
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: silkdata
  class: capability
name: silkdata
type: compose
deploy_path: /opt/silkspool/silkdata
spec:
  delivery:
    driver: compose
    templates: [10-redis.yaml, 12-meilisearch.yaml, 15-nats.yaml, 40-couchdb.yaml, 50-postgres.yaml]
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
```

独立部署/升级 data 层（不会被 `knowledge-stack apply` 触碰）：

```bash
spool plan silkdata silkdata --offline
spool plan silkdata silkdata
spool apply silkdata silkdata --locked --yes
```

---

## 7. Product：Bellkeeper

Bellkeeper 仓库的 `deploy/bundle.yaml` 是产品契约；SilkSpool 只通过 `bundle_sources` 固定版本：

```yaml
# Bellkeeper/deploy/bundle.yaml（节选）
apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: bellkeeper
  class: product
  version: 2.4.0
name: bellkeeper
type: compose
templates: [compose.yaml]
spec:
  delivery:
    driver: compose
    templates: [compose.yaml]
    artifact:
      type: image
      image: ghcr.io/singll/bellkeeper:2.4.0
      digest: "sha256:<real-manifest-digest>"
  outputs:
    url: "${input.public_url}"
    health: "http://127.0.0.1:8080/api/health"
    internal:
      kind: endpoint
      service: bellkeeper
      port: 8080
      remote: "${host.magicdns}"
  lifecycle:
    health: {http: "${outputs.health}", from: container, timeout: 120s}
    upgrade: {strategy: backup-then-recreate, irreversible: false}
    restore: {hook: scripts/restore.sh}
  backup:
    hook: scripts/backup.sh
    assets:
      - {type: volume, source: kp-bellkeeper-data}
```

独立 apply product（需要 host 提供 `public_url`）：

```yaml
hosts:
  keeper:
    inputs:
      public_url: "https://bellkeeper.example.com"
    bundles: ["bellkeeper"]
```

> 推荐仍然通过 `knowledge-stack` 部署，让 n8n/rsshub/memos 与 data 层 wiring 一起解析。

### 7.1 升级 Bellkeeper

1. 在 Bellkeeper 仓库发布新镜像和 `deploy/bundle.yaml`，拿到真实 manifest digest。
2. 更新 `silkspool.yaml` 中 `bundle_sources.bellkeeper.commit`（或 OCI `digest`）。
3. 更新 `knowledge-stack` 里 `bellkeeper.version` / `delivery.artifact.digest`（如需要）。
4. 验证并部署：

```bash
spool plan knowledge-stack keeper --offline
spool plan knowledge-stack keeper
spool apply knowledge-stack keeper --locked --yes
```

失败时控制端会尽力回滚到上一 generation（控制端在线为前提）；`irreversible: true` 时不会自动回滚，需人工确认。

### 7.2 备份与恢复

```bash
spool restore knowledge-stack keeper          # 调用 product restore.hook
spool rollback knowledge-stack keeper         # 回滚上一 generation
spool rollback knowledge-stack keeper 3       # 指定 generation
```

`backup-then-recreate` 升级前会调用产品 `backup.hook`，产物在远端
`/opt/silkspool/keeper/backups/`。未声明 `restore.hook` 时 spool 只列出产物路径，明确走人工恢复。

---

## 8. 纳管既有 stack

```bash
spool adopt keeper --dry-run
spool adopt keeper --bundle legacy-stack
spool adopt keeper --bundle legacy-stack --force
```

adopt 只读发现，不重建容器；生成的 `bundles/<name>/manifest.yaml`、`.spool/state/`、`.spool/lock/`
可用于后续 `plan/apply`。

---

## 9. Inventory / API

```bash
spool inventory --json
spool inventory --probe --json        # 连接 TrueNAS/SSH 获取 Dataset/Key 实际状态
spool serve --socket /run/spool.sock  # 可选本地 API
```

`GET /v1/inventory?probe=true` 与 CLI 对应。OpenAPI：`api/openapi.yaml`；客户端：

```go
client := apiclient.NewUnixClient("/run/spool.sock")
inv, err := client.GetInventory(ctx, nil)
```

---

## 10. 配置检查清单

```bash
# 1. 静态校验（不连远端；合法 0，非法 2）
spool plan knowledge-stack keeper --offline

# 2. 在线 diff（有 drift 退出 3）
spool plan knowledge-stack keeper

# 3. 固定镜像更新建议
spool bundle check-updates knowledge-stack --json

# 4. 可复现部署
spool apply knowledge-stack keeper --locked --yes
```

常见失败：

- `unresolved input reference ${input.public_url}`：在 host `inputs` 提供 `public_url`。
- `cross-host endpoint ... needs MagicDNS or address`：给 provider host 配置 `magicdns` 或 `address`。
- `OCI ... digest is required`：OCI source 必须固定 digest。
- `cosign verification failed`：签名不匹配、无签名或 cosign 不可用；不会降级。
