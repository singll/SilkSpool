# 04 · endpoint 域设计（接口面 / 参数队列——"打哪里、喂什么料"的唯一事实源）

> 版本：v5.0 ｜ 状态：定稿 ｜ 契约版本：endpoint@1（repository-v1）
> 依赖：[`00-conventions.md`](00-conventions.md)（宪法，冲突以它为准）、[`01-bus.md`](01-bus.md)（总线）
> owns（单写者）：`endpoints` 表 + `data/pipeline/{program}/param-queue.txt`、`param-seen.txt`（从 sec-pipeline 收编的参数队列文件）
> 不 owns：`assets`（asset 域）、`findings`（vuln 域）、`data/pipeline/{program}/` 下其余台账文件（ledger 域）
> 订阅：`exec.run.completed`（l2-collect / katana parser proposal 回灌）；被订阅：vuln（endpoint.registered/auth_marked → 越权与注入队列候选）、ledger（endpoint.registered → 接口台账联动）、dashboard（接口视图）

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| cordis 服务名 | `secDomain.endpoint` |
| 域插件包 | `@silksec/sec-domain-endpoint` |
| 后端插件包 | `@silksec/sec-backend-endpoint-sqlite`（endpoints 表 + param-queue/param-seen 文件原语同一插件）——`@silksec/sec-backend-endpoint-file` 包**不存在**（"双后端组合"是早期设计设想，未落地；文件原语已并入 sqlite 后端） |
| bundle 配置 | 无（`sec_domain_endpoint_backend` 配置键**不存在**于任何代码/配置；域 manifest 以 `backend: 'repository-v1'` 固定，sqlite-local 单实现，无后端切换开关） |
| 事件日志 | `data/events/endpoint.jsonl` |
| profile 挂载矩阵 | **web + headless 双面都挂**（worker 要入队/喂料/标注；无仅宿主面动词） |

| profile | model 可用 | dashboard 可用 | script 可用 |
|---|---|---|---|
| web（宿主面） | endpoint_upsert / endpoint_queue_surface / endpoint_consume_queue / endpoint_mark_auth + 全部查询 | 同 model + RPC 投影 | endpoint_upsert（proposal 回灌）/ endpoint_consume_queue |
| headless（worker 面） | 同 web 的 model 列 | — | 同上 |

`human`：只读 + `--actor human` 显式写；`webhook`/`scheduler`/`approval`：白名单为空。

**文件安全基线**：`param-queue.txt` / `param-seen.txt` 是域 owned 文件——run_cli 沙箱**不可写**（宪法 §十四.3：manifest owns × sandbox 白名单在 setup.sh 冒烟交叉断言）。l2-collect 等脚本只能把产出写进 `results/<run_id>/`（沙箱可写区），入库/入队一律经本域命令。

### 1.2 命令总表

| 动词 | 语义（状态机入口） | actor 白名单 | 幂等键（manifest `idempotent` / `idempotent_fields`） | 事件 |
|---|---|---|---|---|
| `endpoint_upsert` | 登记接口（单行或 TSV 批量入库——l2-collect 产出消费口） | model, script, dashboard | `auto`：`(rows, tsv_path, program_id)` | endpoint.registered（仅新行） |
| `endpoint_queue_surface` | 参数面入队：从 TSV/文本提取带参数 URL，全局去重（seen 域内）追加 param-queue | model, script | `auto`：`(program, source)`（**无文件 sha256**） | endpoint.queue.enqueued |
| `endpoint_consume_queue` | 队列消费：dalfox/sqlmap 取料后标记消化（出队；seen 保留防重回） | model, script | `natural`：`(program, run_id)` | endpoint.queue.consumed |
| `endpoint_mark_auth` | 鉴权标注：auth_required / roles_seen（越权矩阵唯一数据源） | model, script, dashboard | `auto`：`(host, method, path, auth_required, roles_seen, evidence)` | endpoint.auth_marked |
| `endpoint_classify_auth` | 登录态判定落列（§5.1 纯函数分类 public/login_required/unknown，run_id 证据链） | model, script | `auto`：`(host, method, path, response, run_id)` | endpoint.auth_classified |
| `endpoint_annotate_semantics` | 业务语义标注（§5.2 should_auth：自动建议 + 人工裁定，人工 > 自动） | model, script, dashboard | `auto`：`(host, method, path, should_auth, body_excerpt, note)` | endpoint.semantics_annotated |

**invariants / timeout_ms**（manifest 逐命令声明，网关前置执行）：`endpoint_upsert` invariants `[upsertMode, batchLimit]` / `timeout_ms: 120000`；`endpoint_queue_surface` `[queueSourceExists]` / `60000`；`endpoint_consume_queue` `[consumeEvidence]` / `60000`；`endpoint_mark_auth` `[endpointExists, authEvidence]` / `60000`；`endpoint_classify_auth` `[endpointExists]` / `60000`；`endpoint_annotate_semantics` `[endpointExists, semanticsRuling]` / `60000`。

**结构性闸门**：`auth_required` / `roles_seen` 两列**只出现在 `endpoint_mark_auth` 的参数表里**；`endpoint_upsert` schema 不含（v4.x `endpoint_add` 工具带这两个参数、l2-collect TSV 也有 `auth_required` 列恒为 `unknown`——v5 一律剥离，登记与标注分动词）。

### 1.3 命令逐个详述

#### 1.3.1 `endpoint_upsert` —— 接口登记（含 l2-collect TSV 批量入库）

**语义**：把一个接口端点（host + method + path）登记进接口图谱；已存在则刷 `last_seen` 并就地补全空 `status`/`params`/`program_id`。**本命令同时是批量动词**：`rows` 内联模式（≤500）或 `tsv_path` 文件模式（≤5,000）二选一——l2-collect 产出 TSV 后经此入库，**替代 v4.x 的 TSV 直写不落库**（v4 实测断层：endpoints 表仅 114 行 vs 台账 TSV 6,594 行，l2-collect.sh 只追加 TSV 从不入库）。

**参数 schema**（`additionalProperties: false`，两组互斥）：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `rows` | array | 模式① | — | 1..500 行；每行字段见下 |
| `tsv_path` | string | 模式② | — | TSV 文件绝对路径（必须在 `results/<run_id>/` 下）；表头必须为 `url\tmethod\tparams\tauth_required\tsource\tcollected_at`；**行数 ≤5,000**（超限 `E_ENDPOINT_BATCH_TOO_LARGE`，hint：l2-collect 侧分批或域内分片重调）；`auth_required` 列读入后**忽略**（登记不带鉴权语义） |
| `program_id` | string | ❌ | `null` | 行级可被 `row.program_id` 覆盖；**INV-3 同 asset 域**：host 必须命中该 program scope |

单行字段：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `url` 或 `host`+`path` | string | 二选一 | url 模式域内拆解 host/path（path = pathname+search）；host 模式 path 必须以 `/` 开头；host 归一化同 asset 域 |
| `method` | string | ❌ | `GET`；大写化；白名单 `GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS`（越枚举 E_SCHEMA——l2 采集无自定义动词） |
| `status` | string | ❌ | `''`；HTTP 状态码字符串；空不覆盖 |
| `params` | object | ❌ | `null`；参数清单 JSON（`{"id": "", "redirect": ""}` 形态，或 l2 的逗号串 `{"_raw": "mode,modelId"}`——域内存对象，展示层拼接）；整包覆盖 |
| `source` | string | ❌ | `''` | `tool:run_id` / `manual` |
| `program_id` | string | ❌ | `null` | 行级覆盖 |

**行内过滤（域内再滤一道，非错误）**：静态资源后缀（`js/css/png/jpe?g/gif/svg/ico/woff2?/ttf/map/mp4/webp`）URL 跳过，计入 `skipped_static`；URL 解析失败行计入 `skipped_invalid`。两计数进返回信封（v4 l2-collect.sh 的归一化规则平移进域，脚本侧仍保留首滤）。

**返回信封**（批量模式）：

```json
{
  "ok": true, "domain": "endpoint", "cmd": "upsert",
  "data": {
    "created": 812, "touched": 3491, "skipped_static": 2273, "skipped_invalid": 18,
    "results": [{ "host": "exp.volcengine.com", "method": "GET", "path": "/ark/vision", "created": false, "error": null }]
  },
  "event_ids": ["evt_..."],
  "idempotency_key": "endpoint:upsert:bulk:sha256:1c4f...",
  "replay": false
}
```

行级结果数组仅含前 100 行明细 + 计数（防 5,000 行信封膨胀；完整明细域内不落、调用方按 TSV 自查）。单行 INV-3（scope）失败：行级 `error` 不回滚整批（与 asset 域同口径）。

**幂等**：行级自然键 `(host, method, path)`（表主键，upsert 语义天然幂等）；批量另记 `endpoint:upsert:bulk:sha256:{tsv 指纹}`（重放同文件返回首次结果）。

**错误码**：

| code | 触发 | hint |
|---|---|---|
| `E_SCHEMA` | rows/tsv 同传或都缺 / method 越枚举 / rows > 500 | "内联批量上限 500 行；更大批量走 tsv_path（上限 5,000）" |
| `E_ENDPOINT_BATCH_TOO_LARGE` | tsv > 5,000 行 | "TSV 行数 {n} 超上限——分批产出 proposal 或分片重调" |
| `E_ENDPOINT_TSV_INVALID` | 文件不存在 / 表头不符 / 编码非 UTF-8 | "期望表头 url\\tmethod\\tparams\\tauth_required\\tsource\\tcollected_at（l2-collect 产出格式）" |
| `E_INVARIANT` | 行级 scope（INV-3） | 同 asset 域 hint |
| `E_CONFLICT` | busy 超时 | retryable |

**actor**：model / script（订阅 handler 回灌）/ dashboard。

**side_effects**：`rows_touched: endpoints ≤5000`，`events: ≤新行数`，`files: 无`，`caches: hosts 聚合缓存失效`。

**agent_note**：
> 登记接口端点（host+method+path 主键去重）。l2-collect 产出的 TSV 传 tsv_path 批量入库（≤5000 行）；小批量传 rows（≤500）。鉴权标注（auth_required/roles_seen）走 endpoint_mark_auth，本动词不收。静态资源 URL 自动跳过。

#### 1.3.2 `endpoint_queue_surface` —— 参数面入队（原 surface_queue 收编）

**语义**：从 endpoints TSV / 任意文本（JS dump、响应体）提取**带参数 URL**，对域内 `param-seen.txt` 全局去重后，将新增 URL 排序追加进 `param-queue.txt`（dalfox/sqlmap 喂料队列）。**seen 集合收编域内**（v4 在 sec-pipeline 工具函数里自持 `param-seen.txt`，v5 文件 owner 归本域）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `program` | string | ✅ | — | 项目名（param-queue 按项目分文件）；须存在于 programs 表（E_NOT_FOUND） |
| `source` | string | ✅ | — | 输入文件绝对路径；`.tsv` 后缀走 TSV 解析（列 0 = url、列 2 = params 非空），否则全文正则抽 `https?://…` 且 query 非空；沙箱可写区或域 owned 只读文件均可 |

**域内处理流水**（事务边界 = 单命令）：

```
读 source → 提取带参数 URL 集合 U → 读 param-seen.txt 得 S
fresh = sort(U − S)（排序保证幂等与可 diff）
若 fresh 非空：
  原子追加 param-queue.txt：读现队列 → 合并 fresh → tmp+rename（替代 v4 appendFileSync）
  原子追加 param-seen.txt：同法 tmp+rename
```

**返回**：

```json
{
  "data": { "new_urls": 217, "pool": 1130, "queue": "/opt/silkspool/dsh/data/pipeline/bytedance/param-queue.txt",
    "hint": "dalfox file <queue> / sqlmap -m <queue> --batch --level 1 --risk 1" }
}
```

**幂等**：`auto`：`(program, source)`——同文件重放由总线幂等表直接返回**首次结果**（`replay: true`，`new_urls` = 首次值，契约测试用例为 `new_urls === 2`），**不是 `new_urls: 0`**；seen 拦截重复 URL 只在非重放的二次运行中生效。

**错误码**：`E_NOT_FOUND`（source 文件不存在 / program 不存在）、`E_SCHEMA`、`E_INVARIANT`（source 文件在域 owned 写保护目录且非只读语义——见 §2.3）。

**actor**：model（vuln 任务 #19/#37 的"param-queue 增量喂料"硬指标入口）/ script。

**agent_note**：
> 参数面入队：从 endpoints TSV 或任意文本提取带参数 URL，全局去重后入 param-queue（dalfox/sqlmap 喂料队列，按项目分文件）。重复 URL 被 seen 集合自动拦截（幂等）。喂完扫描器后用 endpoint_consume_queue 标记消化。

#### 1.3.3 `endpoint_consume_queue` —— 队列消费（dalfox/sqlmap 取料后标记消化）

**语义**：**队列消费语义显式化**。v4 的 param-queue 只增不减（实测 bytedance queue 与 seen 均为 913 行、完全相同——dalfox 喂过料后队列不清、消化不可见）；v5 增加本动词：扫描器取料完成后把已消化 URL 从 `param-queue.txt` 移除，`param-seen.txt` **保留**（防已消化 URL 重新入队）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `program` | string | ✅ | — | 项目名 |
| `mode` | string | ❌ | `'all'` | `all`（消化当前队列全部）/ `urls`（消化显式清单） |
| `urls` | array | ❌（mode=urls 时逻辑上使用，schema 未强制必填） | — | 字符串数组；**无 1..5000 条数限制**；不在队列的计入 `not_in_queue`（非错误——重放安全） |
| `scanner` | string | ✅ | — | enum `dalfox` / `sqlmap` / `arjun` / `other`（审计与统计维度） |
| `run_id` | string | ✅ | — | **证据即参数**：扫描 run 的 run_id（`results/<run_id>/` 须存在，E_EVIDENCE_REQUIRED） |

**域内处理**：读队列 → 按模式选出消化集 C → `param-queue.txt` 重写为 `queue − C`（tmp+rename 原子）→ seen 不动。

**返回**：`data: { program, consumed: 913, remaining: 0, scanner: "dalfox", run_id: "run_..." }`。

**幂等**：`natural`：`(program, run_id)`——同 run 重放由总线幂等表返回**首次结果**（`consumed` = 首次值，契约测试用例为 `consumed === 1`；**不是 0**）；不同 run 消费同一队列是合法的二次喂料。

**错误码**：`E_EVIDENCE_REQUIRED`（run_id 缺失或 results 目录不存在）、`E_SCHEMA`。**`E_ENDPOINT_QUEUE_EMPTY` 未实现**——mode=all 且队列本就为空时返回成功 `data: {..., consumed: 0, remaining: 0, empty: true}`（不抛错）。

**actor**：model / script。

**agent_note**：
> 标记参数队列已消化：扫描器（dalfox/sqlmap/arjun）取料跑完后调用，把已喂 URL 从 param-queue 移除（seen 保留防重回）。必带 scanner 与 run_id 证据。队列消费语义显式化——v4 的队列只增不减，消化不可见。

#### 1.3.4 `endpoint_mark_auth` —— 鉴权标注（越权矩阵数据源）

**语义**：为单个端点标注 `auth_required`（是否需要登录态）与 `roles_seen`（观测到访问过该接口的角色集合）。**越权矩阵（endpoint_matrix）的唯一数据源**。biz-logic 任务的多角色对比（vuln 域 `vuln_authz_diff`，02-vuln C11）、浏览器登录态页面观测都经此回填。

**参数 schema**：

| 参数 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `host` | string | ✅ | 已登记端点（E_NOT_FOUND——先 endpoint_upsert） |
| `method` | string | ❌ | 默认 `GET`；大写 |
| `path` | string | ✅ | — |
| `auth_required` | string | ❌ | enum `yes` / `no` / `unknown`；缺省不动既有值 |
| `roles_seen` | array[string] | ❌ | 角色名数组（如 `["admin", "user_anon"]`）；**并集合并**（不覆盖——多轮观测累积） |
| `evidence` | string | ❌ | run_id / flow_id / burp_item（观测来源；auth_required 从 unknown 变 yes/no 时**必填**，E_EVIDENCE_REQUIRED） |
| `note` | string | ❌ | 备注（如"302→login"判据） |

**返回**：`data: { host, method, path, auth_required: "yes", roles_seen: ["admin", "user"], roles_added: ["user"] }`。

**幂等**：自然键 `(host, method, path)`——同参重放安全；roles_seen 并集语义使追加角色是新命令（不同参数 → 各自成账，审计可追溯）。

**错误码**：`E_NOT_FOUND`、`E_EVIDENCE_REQUIRED`（unknown→确定值无证据）、`E_SCHEMA`。

**actor**：model（biz-logic 任务标注）/ dashboard（看板标注表单）/ script（`vuln_authz_diff`（02-vuln C11）判定后的角色观测回流 proposal）。

**agent_note**：
> 标注接口鉴权（auth_required: yes/no/unknown）与访问角色（roles_seen 并集累积）——越权矩阵的数据源。auth_required 从 unknown 变为确定值必须带证据（run_id/flow_id）。biz-logic 任务梳理接口图谱后应批量回填，多角色命中的接口是越权测试优先面（endpoint_matrix 查询）。

#### 1.3.5 `endpoint_classify_auth` —— 登录态判定落列（21 号方案 §5.1）

**语义**：传一次无凭据探测的响应特征，域内纯函数（`sec-rules-hypothesis.classifyAuthState`）分类 `public` / `login_required` / `unknown` 落 `auth_state` 列——**系统知道哪个接口要登录**的判定器。判定确定性执行、证据不足显式 `unknown` 不猜；主动探测须过 exec 守卫链（program `rules.max_risk`/QPS 覆盖，否则走 tool-intrusive 审批）。

**参数 schema**：

| 参数 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `host` / `path` | string | ✅ | 已登记端点（E_NOT_FOUND） |
| `method` | string | ❌ | 默认 `GET` |
| `response` | object | ✅ | `{status, redirect_location, body_simhash, login_simhash, has_business_data}`（全可选键；additionalProperties=false） |
| `run_id` | string | ✅ | 判定证据链（探测 run） |

**判定规则**：401/403 → login_required；3xx → Location 命中登录页词表（login/sso/passport/cas…）→ login_required，否则 unknown；200 → 响应体 simhash 与登录页海明距 ≤6 → login_required，含业务数据（非模板页）→ public，证据不足 → unknown。

**返回**：`data: { host, method, path, auth_state, confidence, reasons }`；事件 `endpoint.auth_classified`（from/to/confidence/run_id/program_id——ledger 域订阅记覆盖账本 auth 面）。

#### 1.3.6 `endpoint_annotate_semantics` —— 业务语义标注（21 号方案 §5.2）

**语义**：标注「应该不应该登录」（`should_auth`）——未授权访问漏洞「应该登录却没拦」的业务前提。三层设计：**不传 should_auth = 自动建议**（路径词表 admin/pay/order/user… + 响应含他人数据特征，只产假说）；**dashboard 传 should_auth = 人工裁定**（审计带 operator，最高权威）；model/script 显式标注**必须带 note 理由**（semanticsRuling 不变量，防模型替人做业务裁定）。**人工裁定 > 自动建议**：repo 层拒绝自动建议覆盖 `dashboard:*` 来源（`kept_human_ruling:true`）。反向标注 `should_auth=no`（「本就该公开」）防误报批量产生。`should_auth=yes ∧ auth_state=public` 是未授权假设（污点路由表）的硬前提。

**事件**：`endpoint.semantics_annotated`（from/to/source/applied/operator）。`endpoint.registered` 订阅（onEndpointRegistered）在端点入库时自动跑一次自动建议（弱联动 best-effort）。

### 1.4 查询逐个详述（纯读）

统一分页信封 `{ rows, total, limit, offset }`（**只适用于返回 `rows` 的列表/聚合查询**：`endpoint_list` / `endpoint_hosts` / `endpoint_matrix`）；limit 默认 50 上限 500；**行数 = total 断言进契约测试**。`queue_status` / `endpoint_surface_scan` 不走该信封，各自返回自身的 `data` 结构（见下）。

**可见域谓词**：

| 谓词 | 语义 | 默认 |
|---|---|---|
| `program` | program_id 过滤 | 全部 |
| `auth` | auth_required 过滤 | 全部（`yes`/`no`/`unknown`/`none`=未标注 NULL） |

#### `endpoint_list`

| 参数 | 默认 | 说明 |
|---|---|---|
| `host` | `''` | 精确 |
| `path_like` | `''` | 模糊 |
| `method` | `''` | 精确（大写化） |
| `program_id` | `''` | 谓词 |
| `auth_required` | `''` | `yes/no/unknown/none`（none = NULL——未标注清单） |
| `auth_state` | `''` | `public/login_required/role_required/unknown/none`（登录态判定过滤） |
| `should_auth` | `''` | `yes/no/unknown/none`（业务语义过滤） |
| `sort` | `last_seen` | `last_seen / host / status / path` |
| `dir` / `limit` / `offset` | desc/50/0 | — |

返回行：`host, method, path, status, source, program_id, params, auth_required, roles_seen, auth_state, should_auth, should_auth_source, last_seen`（v4 列表不带 params/auth 列——v5 补齐，供接口行内直读鉴权状态；21 号方案补登录态/语义列）。

#### `endpoint_auth_summary`（登录态分布聚合，21 号方案 §4.4/§5）

参数：`program_id` / `host`。返回 `{ total, by_state: {public, login_required, role_required, unknown, unmarked}, by_should_auth: {yes, no, unknown, unmarked}, human_ruled, login_required_hosts, marked_ratio }`——覆盖账本登录面与登录盲区摘要（ledger_login_blindspot）的分母；`marked_ratio` 即「端点登录态标注率 ≥90%」验收指标的数据源。

#### `endpoint_hosts`（按主机分组——看板接口 tab 主视图）

参数：`path_like` / `program_id` / `limit` / `offset`。返回 `{ rows: [{host, program_id, n, methods, last_seen}], total }`（v4 endpointHosts 平移；路径搜索命中后按主机聚合，平铺千行无浏览价值）。

#### `endpoint_matrix`（越权矩阵聚合）

**聚合查询（独立命名，不与列表混参数）**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `program_id` | string | `''` | 谓词 |
| `host` | string | `''` | 单主机聚焦（空 = 全项目按 host 聚合） |
| `min_roles` | integer | `2` | 只保留 roles_seen ≥ N 的主机行（0 = 不过滤） |

返回（每 host 一行）：

```json
{ "rows": [{
    "host": "oa.example.com", "total": 214,
    "auth": { "yes": 87, "no": 41, "unknown": 86 },
    "roles": ["admin", "user", "guest"],
    "multi_role_endpoints": 23,
    "no_auth_endpoints": 41,
    "priority_hint": "auth=no × 41 且多角色端点 23——越权与未授权访问优先面"
  }], "total": 65 }
```

`priority_hint` 为域内固定规则拼接（`no_auth_endpoints > 0` / `multi_role_endpoints ≥ min_roles` 的组合文案），不调模型——聚合只读、判定口径可测试。

#### `queue_status`（参数队列现状）

参数：`program`（❌，空 = 全部项目汇总）。返回：

```json
{ "programs": [{
    "program": "bytedance", "queue_lines": 913, "seen_lines": 913,
    "queue_path": "data/pipeline/bytedance/param-queue.txt",
    "last_enqueued_at": 1756080000000, "last_consumed_at": null }],
  "total_queue_lines": 940 }
```

`last_consumed_at: null` 即"从未消化"——v4 现状三项目全部如此，v5 上线后此字段成为参数面纪律的健康指标。

#### `endpoint_surface_scan`（敏感参数/路径回扫，v4 toolSurfaceScan 收编）

参数：`program`（必填）/ `q`（可选，敏感关键词，默认内置词表：`token/key/secret/password/passwd/pwd/access_key/cookie/authorization` 等）。纯读：扫描 `endpoints` 表（路径/参数）与 `param-queue.txt` 中命中敏感关键词的 URL/参数，返回 `{program, total, hits: [{url, keyword, source}]}`——**hits 形状是 `{url, keyword, source}`**（`source` ∈ `endpoints` / `endpoints.params` / `param-queue`），不是 `host/method/path/param/keyword`；且 `endpoints` 侧**只取 `program_id` 过滤后按 `last_seen` 排序的前 500 行**（500 为硬编码上限，超出部分不扫）。**脱敏检查用途**——发现敏感参数面是越权/未授权访问的排查线索，不回写、不改数据。归本域（操作对象是接口面/参数数据，与 endpoint_queue_surface 同族；v4 在 sec-pipeline，11-ledger §3.1 #9 记录归属裁决）。

### 1.5 事件

#### `endpoint.registered`

```json
{ "host": "exp.volcengine.com", "method": "GET", "path": "/ark/vision", "program_id": "bytedance", "source": "l2-collect:run_01H" }
```

（仅新行；批量入库时逐新行发布，≤ 行数上限。）

#### `endpoint.queue.enqueued`

```json
{ "program": "bytedance", "new_urls": 217, "pool": 1130, "source": "results/run_01H/endpoints-proposal.tsv" }
```

#### `endpoint.queue.consumed`

```json
{ "program": "bytedance", "consumed": 913, "remaining": 0, "scanner": "dalfox", "run_id": "run_01HY" }
```

#### `endpoint.auth_marked`

```json
{ "host": "oa.example.com", "method": "GET", "path": "/api/user/list",
  "from": { "auth_required": "unknown", "roles_seen": [] },
  "to":   { "auth_required": "yes", "roles_seen": ["admin", "user"] },
  "evidence": "run_01HZ" }
```

订阅方（**未实现/设计预留**）：vuln 域（endpoint.auth_marked → 越权测试候选提示；endpoint.queue.enqueued → param 喂料任务上下文）、ledger 域（endpoint.registered → 接口台账 TSV 联动，见 §2.3）、dashboard（endpoint.queue.consumed → 队列徽章）。当前 endpoint manifest `subscribes` 仅含 `exec.run.completed`（onRunProposal），上述对端在各域 manifest 中**均未声明**；按 00-conventions §六 只允许写对端已声明的订阅，故此处标注为设计预留，待各域实现后回填。

### 1.6 模型工具面投影（工具名 = 命令/查询名）

| 工具名 | 描述全文（manifest agent_note 逐字投影） |
|---|---|
| `endpoint_upsert` | 登记接口端点（host+method+path 主键去重）。l2-collect 产出的 TSV 传 tsv_path 批量入库（≤5000 行）；小批量传 rows（≤500）。鉴权标注（auth_required/roles_seen）走 endpoint_mark_auth，本动词不收。静态资源 URL 自动跳过。 |
| `endpoint_queue_surface` | 参数面入队：从 endpoints TSV 或任意文本提取带参数 URL，全局去重后入 param-queue（dalfox/sqlmap 喂料队列，按项目分文件）。重复 URL 被 seen 集合自动拦截（幂等）。喂完扫描器后用 endpoint_consume_queue 标记消化。 |
| `endpoint_consume_queue` | 标记参数队列已消化：扫描器（dalfox/sqlmap/arjun）取料跑完后调用，把已喂 URL 从 param-queue 移除（seen 保留防重回）。必带 scanner 与 run_id 证据。 |
| `endpoint_mark_auth` | 标注接口鉴权（auth_required: yes/no/unknown）与访问角色（roles_seen 并集累积）——越权矩阵的数据源。auth_required 从 unknown 变为确定值必须带证据（run_id/flow_id）。biz-logic 任务梳理接口图谱后应批量回填，多角色命中的接口是越权测试优先面（endpoint_matrix 查询）。 |
| `endpoint_list` | 检索接口端点：host 精确 + path_like 模糊 + method/program/auth_required 过滤（auth='none' 筛未标注）。 |
| `endpoint_hosts` | 接口按主机分组（路径搜索命中后聚合，看板主视图口径）。 |
| `endpoint_matrix` | 越权矩阵聚合：每主机的鉴权分布（yes/no/unknown）+ 角色并集 + 多角色端点数。no_auth 与多角色并存的主机是越权/未授权访问优先面。 |
| `queue_status` | 参数队列现状：各项目 queue/seen 行数、最近入队/消化时间（last_consumed_at=null 即从未消化——纪律红灯）。 |
| `endpoint_surface_scan` | 敏感参数/路径回扫（v4 toolSurfaceScan 收编）：扫描 endpoints 表与 param-queue 命中敏感关键词的 URL/参数，脱敏检查用途，不回写。 |

### 1.7 看板 RPC 投影

实际 RPC case 只有两个（均为 `dsh-plugin-sec-suite.dashboard-rpc.js` 手写 case，非 `endpoint.*` 投影命名）：

| RPC case（dashboard-rpc） | 对应查询 | 看板用途（接口视图） |
|---|---|---|
| `endpointHosts`（`dashboard-rpc.js:402`） | endpoint_hosts（内部 `busQuery('endpoint','hosts',…)`） | 接口 tab 主视图（按主机分组） |
| `endpoints`（`dashboard-rpc.js:414`） | endpoint_list（内部 `busQuery('endpoint','list',…)`） | 接口表格（补 params/auth 列） |

`endpoint.matrix` / `endpoint.queueStatus` / `endpoint.upsert` / `endpoint.markAuth` 以及 `endpoint.list` / `endpoint.hosts` **均不存在**；v4 的 `endpoints` / `endpointHosts` 两个 case **未被删除、仍在**（只是内部改为走总线查询）。

### 1.8 外部调用示例

**模型调用**（vuln 任务 #19 的 param 喂料 Slice）：

```json
{ "tool": "endpoint_queue_surface",
  "args": { "program": "bytedance", "source": "results/run_01HXYZ/endpoints-proposal.tsv" } }
```

**代码调用**（订阅 handler：l2-collect proposal 自动入库）：

```js
// manifests: subscribes: [{ event: 'exec.run.completed', mode: 'async', handler: 'onRunProposal' }]
async function onRunProposal(evt) {
  const p = evt.payload.parse_proposal
  if (p?.kind === 'endpoints') {                    // l2-collect / katana
    // 5,000 行内一次入库；更大文件 handler 自动按 5,000 分片逐调
    await bus.dispatch('endpoint', 'upsert',
      { tsv_path: p.tsv_path, program_id: evt.payload.program_id },
      { actor: 'script', run_id: evt.payload.run_id })
  }
}
```

**脚本/人工调用**：

```bash
# l2-collect 改造后：产出 proposal 进 runDir（沙箱可写区），不再直写 data/pipeline/
l2-collect.sh bytedance hosts.txt    # → results/run_01H/endpoints-proposal.tsv
# 入库（落库唯一通道；human 应急通道审计高亮）
sec cmd endpoint upsert --tsv-path results/run_01H/endpoints-proposal.tsv --program bytedance --actor human
# 喂料后消化（model 在 vuln 任务内调用）
sec cmd endpoint consume-queue --program bytedance --scanner dalfox --run-id run_01HY
```

---

## 二、内部实现（Internal）

### 2.1 数据模型（逐列，owner = endpoint 域）

**`endpoints` 表**（PK `(host, method, path)`；v4 仅 114 行——TSV 断层，**运行时实测 357 行 / 212 主机**，§3.3 的 TSV 回填未执行，见 §3.3）：

| 列 | 类型 | 写入者（唯一动词） | 定义 |
|---|---|---|---|
| `host` | TEXT NOT NULL | endpoint_upsert | 主机（归一化同 asset 域） |
| `method` | TEXT NOT NULL DEFAULT 'GET' | endpoint_upsert | 大写 HTTP 方法 |
| `path` | TEXT NOT NULL | endpoint_upsert | **含 query**（`/ark/vision?mode=x`——v4 pathOfUrl 语义：pathname+search；参数 URL 判定据此） |
| `status` | TEXT | endpoint_upsert | HTTP 状态码字符串；空不覆盖 |
| `source` | TEXT | endpoint_upsert | `tool:run_id`；触活不覆盖 |
| `first_seen` / `last_seen` | INTEGER NOT NULL | endpoint_upsert | 登记/最近触活 |
| `program_id` | TEXT | endpoint_upsert | 项目归属（INV-3） |
| `params` | TEXT | endpoint_upsert | 参数清单 JSON（对象序列化） |
| `auth_required` | TEXT | **endpoint_mark_auth** | `yes` / `no` / `unknown` / NULL（未标注）——越权矩阵列 |
| `roles_seen` | TEXT | **endpoint_mark_auth** | 角色数组 JSON（并集累积）——越权矩阵列 |
| `auth_state` | TEXT | **endpoint_classify_auth** | `public` / `login_required` / `role_required` / `unknown` / NULL——登录态判定列（21 号方案 §5.1，ensureCol 列演进） |
| `auth_state_evidence` | TEXT | **endpoint_classify_auth** | 判定证据 JSON（reasons/confidence/run_id/probed_at） |
| `should_auth` | TEXT | **endpoint_annotate_semantics** | `yes` / `no` / `unknown` / NULL——业务语义「应该登录」（21 号方案 §5.2） |
| `should_auth_source` | TEXT | **endpoint_annotate_semantics** | 标注来源：`auto` / `model` / `script` / `dashboard:{operator}`（人工裁定 > 自动建议，自动建议不覆盖 dashboard 裁定） |
| `should_auth_at` | INTEGER | **endpoint_annotate_semantics** | 标注时刻 |

**`data/pipeline/{program}/param-queue.txt`**（file 后端；owner = endpoint 域）：

| 项 | 定义 |
|---|---|
| 形态 | 每行一条带参数的完整 URL，UTF-8 文本，按入队批内排序追加 |
| 写入者 | endpoint_queue_surface（追加）/ endpoint_consume_queue（重写删行）——**均 tmp+rename 原子写** |
| 消费方 | dalfox `file <path>` / sqlmap `-m <path>`（只读，外部进程） |
| 现状 | bytedance 0 行 / meituan-src 0 行 / dsh-ops 1 行（运行时实测——前两者已被 consume 消化清空） |

**`data/pipeline/{program}/param-seen.txt`**（file 后端；owner = endpoint 域）：

| 项 | 定义 |
|---|---|
| 形态 | 同上；**只增不减**的全局 seen 集合（入队防重 + 消化后防重回） |
| 写入者 | endpoint_queue_surface（追加） |
| 现状 | bytedance 913 行 / meituan-src 52 行 / dsh-ops 1 行（运行时实测）——**与 queue（0/0/1）不再相同**：seen 只增不减，queue 已被 consume 清空，是消化语义生效的直接证据 |

**索引**：

| 索引 | 状态 | 服务查询 |
|---|---|---|
| PK `(host, method, path)` | 现有 | upsert 冲突合并 / endpoint_list host 精确 |
| `idx_endpoints_host` | 现有 | endpoint_hosts 分组 / matrix 聚合 |
| `idx_endpoints_program (program_id)` | **v5 新增** | program 谓词（运行时 357 行；为 l2 持续增长预留） |
| `idx_endpoints_auth (auth_required)` | **v5 新增** | auth 谓词 / matrix 的 auth 分布聚合 |

### 2.2 状态机与不变量

**对象状态机**（endpoints 行无独立状态列——存在性 + 鉴权标注两个维度）：

```
[不存在] ──endpoint_upsert──▶ [已登记(auth=NULL)] ──endpoint_mark_auth──▶ [auth=unknown]
                                   │                                        │
                                   └────endpoint_mark_auth─────────────────┴──▶ [auth=yes|no]
（已登记行重复 upsert = 触活，不换状态；auth 确定值可再标注 roles 追加，auth_required 本身可被新证据修正——
  yes/no 之间互转必须带 evidence，审计 before/after 可追溯）
```

**队列状态机**（param-queue.txt，隐式两态）：

```
[不在队列] ──endpoint_queue_surface(fresh)──▶ [排队中] ──endpoint_consume_queue──▶ [已消化]
     ▲                                                                            │
     └────────────── 不可回退：seen 保留，已消化 URL 永不再入队 ────────────────────┘
```

**不变量清单**（设计层 INV-1..9 与 manifest 网关 invariant 名称对应）：

manifest 实际声明的 invariants 键只有 6 个：`upsertMode` / `batchLimit` / `queueSourceExists` / `consumeEvidence` / `endpointExists` / `authEvidence`。INV-1（鉴权列只经 mark_auth）是**结构性闸门**（endpoint_upsert schema 不含该列）、INV-2（队列消费幂等）由**总线幂等三级键**负责、INV-3（scope）是 handler 内 `scopeCheckResult` 自查、INV-7 是安全基线——四者均非 gateway invariant 键。

| # | 不变量 | manifest invariant | 失败码 |
|---|---|---|---|
| INV-1 | `auth_required`/`roles_seen` 只经 endpoint_mark_auth 写入——结构性：endpoint_upsert schema 不含（TSV 的 auth_required 列读入即弃） | （结构性，非 gateway invariant） | E_SCHEMA |
| INV-2 | **队列消费幂等**：seen 集合域内维护——同 URL 重复入队被 seen 拦截（fresh=0 幂等）；同 (program, run_id) 重复消化返回首次结果；已消化 URL 不可重回队列 | （总线幂等键 `auto`/`natural`，非 gateway invariant） | 重放安全（无错误码）；`E_IDEMPOTENT_CONFLICT` 仅同 key 异参 |
| INV-3 | 带 program_id 的行，host 必须命中该 program scope（handler 内 `scopeCheckResult` 读 scope.yml 自查，与 asset 域同口径；scope 域查询上线前的过渡） | （handler 自查，非 gateway invariant） | E_INVARIANT |
| INV-4 | 批量上限：rows ≤500 / tsv ≤5,000（进 schema） | `upsertMode` + `batchLimit` | E_SCHEMA / E_ENDPOINT_BATCH_TOO_LARGE |
| INV-5 | mark_auth 的目标端点必须已登记（先 upsert 后标注） | `endpointExists` | E_NOT_FOUND |
| INV-6 | auth_required 从 unknown → yes/no 必带 evidence（**证据即参数**：鉴权判定是越权测试的准入结论） | `authEvidence` | E_EVIDENCE_REQUIRED |
| INV-7 | 队列文件只经域命令变更（tmp+rename 原子写）；run_cli 沙箱对两个文件不可写（setup.sh owns×sandbox 交叉断言） | （安全基线，非运行时码） | （安全基线，非运行时码） |
| INV-8 | queue_surface 的 source 文件必须存在 | `queueSourceExists` | E_NOT_FOUND |
| INV-9 | consume_queue 的 run_id 证据目录 `results/<run_id>/` 必须存在 | `consumeEvidence` | E_EVIDENCE_REQUIRED |

### 2.3 事务与联动

- **表事务**：endpoint_upsert（含 TSV 批量）单事务 BEGIN IMMEDIATE；mark_auth 单行事务。**文件操作不进 SQLite 事务**——queue_surface / consume_queue 的文件重写靠 tmp+rename 原子性，命令内"读-算-写"顺序串行（同进程网关单入口 + 多进程靠 rename 原子兜底；同项目并发入队的丢行窗口由幂等重放覆盖——契约测试有双进程入队用例，断言最终 seen ≥ 各自 fresh 并集）。
- **订阅联动**（exec.run.completed，mode: async 弱联动）：`kind='endpoints'` proposal → endpoint_upsert（handler 按 5,000 分片）；katana 直跑（原 parser: lines → ingestText）同样产 endpoints proposal。失败 audit 记 `subscriber_failed` + 事件 jsonl 可重放。
- **ledger 联动**：v4 的 `endpoints-{program}.tsv` 台账文件归 ledger 域 owns——ledger 订阅 `endpoint.registered` 追加台账（跨域写经事件，本域不碰该文件）。本域 `endpoint_queue_surface` 的 source 参数**只读**该文件（或任意文本），不写。
- **失败语义**：文件后端 IO 失败 → `E_BACKEND_UNAVAILABLE`（retryable）；表与文件不在同一事务（混布固有），consume_queue 文件重写失败则命令整体失败（文件未损——rename 原子），重试安全。

### 2.4 后端适配器

**repository 接口**（表原语 + 文件原语两组）：

```js
/** ---- 表（sqlite-local） ---- */
getEndpoint(host, method, path) → row|null
insertEndpoint(row) → { created }
touchEndpoint(host, method, path, { status, params, program_id }, ts)
updateEndpointAuth(host, method, path, { auth_required, roles_seen }, ts)
listEndpointsWhere(filters, order, limit, offset) → rows      // 与 count 同一 where 构造器
countEndpointsWhere(filters) → n
hostsAggregate(filters, limit, offset) → { rows, total }      // 按 host 分组
matrixAggregate(filters, minRoles) → rows                     // 越权矩阵
/** ---- 队列文件（file） ---- */
readQueue(program) / readSeen(program) → string[]
appendQueueAtomic(program, urls)                              // 读+合并+tmp+rename
appendSeenAtomic(program, urls)
rewriteQueueAtomic(program, remainingUrls)                    // 消化删行
queueStat(program) → { queue_lines, seen_lines, last_enqueued_at, last_consumed_at }
```

**能力矩阵**：

| 命令/查询 | sqlite-local | http-remote（外部 API 清单系统设想，Phase 4+） | file |
|---|---|---|---|
| endpoint_upsert | full | **partial**：远端按 (host,method,path) 映射 API 路由清单；params JSON 需按远端 schema 转换，TSV 批量走远端 bulk 端点（≤5,000 对齐） | **unsupported**（表语义，E_CAPABILITY_UNSUPPORTED） |
| endpoint_queue_surface / consume_queue / queue_status | full（file 组件恒挂） | **unsupported**：param-queue 是本地喂料文件语义，远端无对应——E_CAPABILITY_UNSUPPORTED，hint"队列恒本地，表数据可同步远端" | full（本命令的归属后端） |
| endpoint_mark_auth | full | **full**（设想：远端 API 清单系统恰好以鉴权标注为一等字段） | unsupported |
| endpoint_list / hosts / matrix | full | **partial**：matrix 聚合远端不支持 → 本地拉平铺行本地聚合 | unsupported |

**混布设想**：sqlite-local（表 + 队列文件）主 + http-remote 镜像（endpoint.registered / auth_marked 推送外部 API 清单系统）——biz-logic 团队在外部系统看到的接口面与本域一致。**切换**：表后端一行配置；file 组件不可切（队列恒本地）。

### 2.5 缓存与失效

| 缓存 | 内容 | TTL | 失效 |
|---|---|---|---|
| `_hostsCache`（及任何 hosts 缓存） | **未实现**——后端无 `_hostsCache`，`invalidateHosts()` 是 noop（预留）；hosts 聚合每次实时查询 | — | — |
| queue_status | **不缓存**（文件 stat 即时读，开销可忽略；消化红灯必须实时） | — | — |
| matrix | 不缓存（biz-logic 低频调用） | — | — |

### 2.6 性能与容量

| 指标 | 现状（运行时实测） | 迁移后 | 预期增长 |
|---|---|---|---|
| endpoints 表 | 357 行 / 212 主机（v4 基线 114 行 / 65 主机；bytedance 42 / meituan-src 45 / vulhub 27） | TSV 回填未执行（§3.3 未落地） | l2-collect 每批新增百级~千级；单项目 ~1 万行量级 |
| param-queue | bytedance 0 / meituan-src 0 / dsh-ops 1（共 1，前两者已消化清空） | 同（文件原地收编） | 入队-消化平衡后稳态在数百行；**无消化则单调涨**（v5 consume 语义根治） |
| param-seen | bytedance 913 / meituan-src 52 / dsh-ops 1（与 queue 不再相同） | 同 | 单调增长，千行/项目量级，文本 IO 无压力 |

**查询代价**：运行时 357 行全表聚合（hosts/matrix）<10ms（**无缓存**，后端 `invalidateHosts` 为 noop）；`idx_endpoints_program` / `idx_endpoints_auth` 覆盖谓词。**文件 IO**：千行文本读写 <5ms；原子 rename 同量级。**TSV 批量**：5,000 行解析 + 逐行 upsert 单事务 <200ms（SQLite 预编译语句批量绑定）。

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

> **历史留档（v4→v5 迁移期）**：本节行级映射记录迁移时的 v4 代码位置；相关 v4 文件此后已删除或重命名（见 [进度历史归档](archive/progress-history.md)），行号可能失效，现行实现以域 manifest 与 backend 为准。

| v4.x 现状（文件:行） | 内容 | v5 去向 |
|---|---|---|
| `dsh-plugin-sec-suite.asset-db.js:293-307` upsertEndpoint | INSERT ON CONFLICT + auth 列 COALESCE | `commands/upsert.js`——**auth_required/roles_seen 的 COALESCE 两段废除**（剥离到 mark_auth），另加静态资源过滤与 TSV 批量 |
| `asset-db.js:406-430` queryEndpoints/countEndpoints/endpointHosts + `:524-531` endpointWhere | 谓词/聚合 | `queries/list.js` + `queries/hosts.js` + backend 原语（补 method/auth 谓词、分页信封、limit 500） |
| `dsh-plugin-sec-suite.asset-graph.js:102-136` endpoint_add/endpoint_query 工具（**已删除**，2026-09-19 旧版清理） | 手写 schema | ToolProjector 投影（别名层已于 2026-09-19 移除，见 §3.2） |
| `dsh-plugin-sec-pipeline.js:404-443` toolSurfaceQueue（surface_queue 工具）（**已删除**——文件现为 16 行无操作壳） | seen/queue 双 appendFileSync + 提取逻辑 | `commands/queue_surface.js`——提取正则与 TSV 解析**原样平移**，appendFileSync 改 tmp+rename 原子；param-seen/param-queue 文件 owner 收编本域 |
| `dsh-plugin-sec-pipeline.js:447-457` 注册表（**已删除**——文件现为 16 行无操作壳） | 8 工具注册 | surface_queue 行删除（endpoint 域投影接管），其余 7 工具归 ledger 域（11-ledger 文档） |
| `data-seed/scripts/surface-consume.py` | 旧脚本版（已在退役观察期） | **保留**（文档旧称"彻底删除"有误——文件仍存在且已随 data-seed 部署；surface_queue 工具的 v4 前身；v5 的 endpoint_consume_queue 是新语义非其平移） |
| `data-seed/scripts/l2-collect.sh:11-14` 直写 `data/pipeline/{program}/endpoints-{program}.tsv` | TSV 追加 + 批内去重 | **proposal 化未实现**：脚本仍直写 TSV（运行时实测）；设计目标是写 `results/<run_id>/endpoints-proposal.tsv`（沙箱可写区），manifest `store: proposal`；`data/pipeline/` 下台账文件改由 ledger 域订阅 endpoint.registered 维护 |
| `l2-collect.sh:37-74` 归一化 python 段 | 去静态/去重/提参数 | 保留在脚本（首滤）；域内 endpoint_upsert 再滤一道（双保险） |
| `data-seed/tools.d/l2-collect.yaml`（parser: lines / store: asset-graph） | parser 直写 | `parser` 改 proposal（kind=endpoints），`store: proposal` |
| `asset-db.js:1723-1744` ingestText（endpoint 部分） | regex 兜底登记 | exec 域 proposal（kind=endpoints）→ 本域 handler |

### 3.2 兼容别名与观察期
> **状态：别名层已移除（2026-09-19）**。`data/bus.aliases.yaml` 为空注册表（别名机制保留为通用能力，当前 0 条目）；本域旧工具名不再注册/投影/分派，调用方已迁语义动词（见 [进度历史归档](archive/progress-history.md) 与 [01-bus §3.2](01-bus.md)）。下表为历史映射留档。

| 旧名 | 新名 | 语义差异处理 |
|---|---|---|
| `endpoint_add` | `endpoint_upsert` | 旧工具的 auth_required/roles_seen 参数被别名层**丢弃**，信封附 warning"鉴权标注已忽略，请用 endpoint_mark_auth" + 审计 deprecated_use |
| `endpoint_query` | `endpoint_list` | 参数一一对应（host/path_like/program_id），补分页信封 |
| `surface_queue` | `endpoint_queue_surface` | 参数一一对应（program/source）；工具改名，prompt 引用脚本化改写 |
| `fp_query` 等 asset 域别名 | 见 03-asset.md §3.2 | — |

> **历史留档**：观察期曾按宪法 §十五执行——7 天 audit 零使用后删别名；discipline-audit 曾增设"悬空工具引用"断言。别名层已于 2026-09-19 移除，上表映射仅供回溯，不再代表现行机制。

### 3.3 数据迁移脚本要点

1. **表不迁**：sqlite-local 接管 `endpoints` 现表（114 行原地保留）。
2. **TSV 断层回填**（一次性数据修复，幂等可重跑）：`data/pipeline/bytedance/endpoints-bytedance.tsv`（6,593 数据行）经 `endpoint_upsert --tsv-path` 分两批（≤5,000 + 余量）入库，program_id=bytedance；行级 (host,method,path) 自然键使重跑安全。**该回填未执行**——运行时表仅 357 行 / 212 主机（§2.1）；设计预期回填后 ~6,700 行，与台账对账（行数 = total 断言）。
3. **队列文件收编**：`param-queue.txt` / `param-seen.txt` 原地不动（路径不变，owner 变更——sec-pipeline 工具的直写路径随 §3.1 下线）；文件权限核对（silkspool 可写、沙箱不可写）。
4. **ensureCol 增列**：无新列（auth_required/roles_seen/params 已有）；只增索引（§2.1）。
5. **基线快照**：VACUUM INTO 先行 + dry-run。
6. **验收**：契约测试矩阵过（含 INV-2 双进程入队幂等用例、TSV 5,001 行超限拒绝、mark_auth 无证据拒绝）；queue_status 的基线截图留档（设计基线为三项目 `last_consumed_at=null`；运行时 bytedance/meituan-src 队列已消化清空、`last_consumed_at` 不再为 null）。

---

## 四、开放问题

1. **queue 的 db 化**：param-queue 恒 file 后端（dalfox/sqlmap 直接读文件、零适配），代价是无事务、无行级消费审计——若未来需要"哪个 URL 被哪次 run 消化了"的精确账目，是否加一张 `queue_consumption` 索引表（sqlite）与文件并存？
2. **endpoint_queue_surface 的 db 模式**：当前 source 只接受文件；是否增加 `source: 'db'` 模式（从 endpoint_list 查询结果提取带参数 URL 入队）？障碍是 endpoints 表不存 scheme（http/https 不定），需按探活 attrs 推断——待 asset 域 attrs 稳定后评估。
3. **matrix 的 priority_hint 规则**：越权优先面的判定口径目前是域内固定文案（no_auth × 多角色），是否引入敏感路径词表（admin/upload/export…）加权？口径必须可测试，若引入需同步 eval 用例。
4. **path 含 query 与去重粒度**：PK 是 (host, method, path) 且 path 含 query——同一接口不同参数值会增殖多行（`?id=1` 与 `?id=2`）；l2 归一化只去重完整 URL。是否在 upsert 时按"参数名集合"归一（query 值剥离）？v4 行为保留（观测保真），归一化方案待实测行数增长后定。
5. **http-remote 对接系统选型**：外部 API 清单系统（设想）的 (host,method,path) 主键兼容性、鉴权字段命名、bulk 端点限额——Phase 4 与 asset 域 CMDB 对接一并调研。
6. **roles_seen 的角色词表**：当前自由字符串（admin/user/guest…），跨项目口径不一——是否由 authz 域统一角色注册表（credentials 的 role 字段已有雏形）供本域引用校验？
7. **consume 的自动化**：dalfox/sqlmap 经 run_cli 跑完后由模型显式调 consume_queue（当前设计）；是否在 exec.run.completed handler 里对 scanner ∈ {dalfox, sqlmap} 的 run 自动消化当次喂料（依赖 exec 域 proposal 携带喂料清单）？

## 五、2026-09-12 深度审查结论

| 维度 | 结论 |
|---|---|
| 逻辑/功能 | 25/25 契约通过；endpoint 登记与鉴权标注状态入口分离，param queue 原子写。 |
| 性能 | upsert ≤5000 行；surface_scan 会扫描 endpoints path/params 与 param-queue，当前万级以内可用，后续需加专用索引/词表预过滤。 |
| 静默错误 | parser 投影失败仅返回 `partial:true`，没有逐项错误；与 asset 同为可观测性缺口。 |
| 文档漂移 | 已修正 `endpoint.queue.enqueued` / `endpoint.queue.consumed` 事件名。 |
| hook 判定 | parser proposal 经事件由本域 `endpoint_upsert` 落库，不直写，合格。 |
| 独立升级 | 支持单域替换；须回归 endpoint、exec parser、vuln 越权提示与 ledger 联动。 |

> 2026-09-22 22 号方案回填：`endpoint_list` actor 白名单补 `reactor`——ledger 域覆盖账本/缺口队列经 reactor 跨域只读端点面（登录态/参数/漏洞类缺口判定）。只读，不扩写权。
