# 03 · asset 域设计（资产 / 指纹 / 分级——"挖什么、先挖谁"的唯一事实源）

> 版本：v5.0-draft-1 ｜ 状态：草案 ｜ 契约版本：asset@1（repository-v1）
> 依赖：[`00-conventions.md`](00-conventions.md)（宪法，冲突以它为准）、[`01-bus.md`](01-bus.md)（总线：网关/事件/幂等/审计）
> owns（单写者）：`assets` 表、`fingerprints` 表（含全部列级演进）
> 不 owns：`endpoints`（endpoint 域）、`findings`（vuln 域）、`programs`/scope（authz 域）
> 订阅：`exec.run.completed`（httpx / l2 parser proposal 回灌）；被订阅：vuln（fp.recorded → intel N-day 候选）、task/exec（asset_deep_queue 取派单队列）、ledger（asset.graded 台账联动）、dashboard（overview/stats）

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| cordis 服务名 | `secDomain.asset`（`ctx.provide('secDomain.asset', service)`） |
| 域插件包 | `@silksec/sec-domain-asset`（commands/ queries/ backend/ test/ 结构对齐归档 §2.3） |
| 后端插件包 | `@silksec/sec-backend-asset-sqlite`（默认）/ `@silksec/sec-backend-asset-http`（Phase 4 预留） |
| bundle 配置 | `sec_domain_asset_backend: sqlite-local`（一行切换，见宪法 §十二.5） |
| 事件日志 | `data/events/asset.jsonl` |
| profile 挂载矩阵 | **web + headless 双面都挂**（worker 派单/分级/登记都需要；asset 域没有"仅宿主面"的动词，调度器不直接写本域——task 域只读队列） |

挂载矩阵（profile × actor → 实际可用的动词，负向保障第一层——不在表内的组合**根本不向模型注册工具**）：

| profile | model 可用 | dashboard 可用 | script 可用 |
|---|---|---|---|
| web（宿主面） | asset_upsert / asset_upsert_bulk / asset_grade / fp_record / fp_record_bulk + 全部查询 | 同 model + 看 RPC 投影 | asset_upsert_bulk / asset_grade / fp_record_bulk（parser proposal 落库） |
| headless（worker 面） | 同 web 的 model 列 | —（无 UI） | 同上 |

`human`（CLI 应急通道）：只读查询 + `--actor human` 显式写（审计高亮）；`webhook`/`scheduler`/`approval`：本域无对应动词（白名单为空）。

### 1.2 命令总表

| 动词 | 语义（状态机入口） | actor 白名单 | 幂等键 | 事件 |
|---|---|---|---|---|
| `asset_upsert` | 登记新资产 / 触活既有资产（刷 last_seen） | model, script, dashboard | 自然键 `asset:upsert:{host}\|{type}` | asset.registered（仅新行） |
| `asset_upsert_bulk` | 批量登记（httpx parser proposal 回灌） | model, script | 自然键逐行 + 文件指纹 `asset:upsert:bulk:{sha256}` | asset.registered × 新行数（≤ 批量行数） |
| `asset_grade` | 分级落库：score 派生 level + accept/biz 标注（单资产或 proposal 批量） | model, script, dashboard | 见 §1.3.3 | asset.graded × 实际变更行 |
| `asset_state` | 生命周期流转：new/changed/stable/dead（signal→state 映射域私有） | model, script, dashboard | 自动指纹 `(domain,verb,核心参数)` | asset.state.changed（状态实际变化才发） |
| `fp_record` | 指纹登记 / 版本升级（host+tech 自然键） | model, script, dashboard | 自然键 `asset:fp:{host}\|{tech}` | fp.recorded（新登记或版本变化） |
| `fp_record_bulk` | 批量指纹登记（httpx tech 数组） | model, script | 逐行自然键 | fp.recorded × 行数 |

**禁用词自查**：无 `update`/`set`/`save`/`modify`；每个动词都是登记或状态机入口。

**结构性闸门（最重要的一条对外承诺）**：`score` / `level` / `accept` / `biz` / `owner` 五个评级列**只出现在 `asset_grade` 的参数表里**；`state` 列只出现在 `asset_state` 的（派生）结果里。其余动词 schema `additionalProperties: false`，传评级字段直接 `E_SCHEMA`——"level 只能经 asset_grade 写入"从 v4.x 的 schema 惯例升级为**网关断言**（v4.x `asset_add` 工具带 level/score 参数靠调用纪律不传，是本域要消灭的病灶）。

### 1.3 命令逐个详述

#### 1.3.1 `asset_upsert` —— 登记与触活

**语义**：把一个主机（域名/IP/存活 web 站点/服务）登记进资产图谱；已存在则只刷 `last_seen` 并就地补全空的 `source`/`program_id`（不覆盖非空值）。**评级列一律不可传**。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `host` | string | ✅ | — | 非空；域内归一化：去 scheme/端口/路径、小写、去尾部 `.`（复用 v4 `hostOf` 语义）；IPv6 去方括号 |
| `type` | string | ❌ | `'host'` | enum `domain` / `ip` / `web` / `service` / `host` |
| `source` | string | ❞ | `''` | 来源标识（工具名:run_id / manual）；空 = 不覆盖既有值 |
| `attrs` | object | ❌ | `null` | 自由 JSON（httpx 的 title/webserver/status/tech 等）；整包覆盖 |
| `program_id` | string | ❌ | `null` | 项目归属；**INV-3 前置校验**（见下） |

**返回信封**（成功）：

```json
{
  "ok": true, "domain": "asset", "cmd": "upsert",
  "data": { "host": "admin.example.com", "type": "web", "created": true, "program_id": "bytedance" },
  "event_ids": ["evt_01J..."],
  "idempotency_key": "asset:upsert:admin.example.com|web",
  "replay": false
}
```

- `created: false`（触活）时不发事件（`event_ids: []`），audit 仍落一条（before/after 含 last_seen 变化）。
- `root` 冗余列（域名族/网段聚合键）由域内从 host 计算（v4 `hostRoot` 平移），调用方不传。

**错误码**：

| code | 触发 | hint 文案 |
|---|---|---|
| `E_SCHEMA` | host 空 / type 越枚举 / 传了 score/level/accept/biz/state | "评级字段（score/level/accept/biz）只能经 asset_grade 写入，state 只能经 asset_state 流转；本动词只登记资产存在性" |
| `E_INVARIANT` | program_id 非空但 host 不在该 program 的 scope 域模式/CIDR 内（INV-3） | "资产 {host} 不在项目 {program_id} 授权范围内——域外参考站请不带 program_id 登记（保持 level NULL，不进主动队列），或先经审批扩 scope" |
| `E_CONFLICT` | SQLITE_BUSY 超时（retryable） | "并发写冲突，稍后重试" |

**幂等**：自然键 `(host, type)`（表主键）。同 key 同参重放 → 返回首次结果 + `replay: true`；同 key 异参 → `E_IDEMPOTENT_CONFLICT`。

**actor**：model / script / dashboard（xray webhook 不写资产；parser proposal 经订阅 handler 以 actor=script、细粒度身份 run_id dispatch）。

**side_effects**：`rows_touched: assets ≤1`，`events: 0|1`，`files: 无`，`caches: overview 失效`。

**agent_note（工具描述全文，投影零改名）**：
> 登记或触活一个资产（域名/IP/存活 web 站点）。本工具只登记"资产存在"：host + type + 来源；评级（score/level/accept/biz）与生命周期（state）分别走 asset_grade / asset_state。带 program_id 时主机必须在项目授权范围内。重复登记安全（幂等，只刷 last_seen）。

#### 1.3.2 `asset_upsert_bulk` —— 批量登记

**语义**：同一事务内批量登记（BEGIN IMMEDIATE，整批原子）。主要消费方是 exec.run.completed 的 httpx parser proposal（数百主机级）。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `rows` | array | ✅ | — | 1..500 行（批量上限进 schema）；每行 = asset_upsert 的参数对象（同构校验） |
| `proposal_ref` | string | ❌ | `null` | 来源 proposal 标识（run_id / 文件 sha256），随事件与审计携带 |

**返回**：`data: { created: N, touched: M, results: [{host, type, created, error?}] }`（行级结果数组；单行 schema 失败不炸整批——该行标 `error: "E_SCHEMA: ..."`，其余照常提交；**INV-3（scope）失败的行同样行级报错不回滚整批**，因为登记域外资产不带 program_id 是合法的，错在归属声明）。

**幂等**：文件级 `asset:upsert:bulk:{proposal_ref}`（重放同 proposal 返回首次结果）；行级由 (host,type) 自然键兜底。

**事件**：`asset.registered` × 新行数（宪法 §八.5：批量 ≤ 行数，合法）。

**错误码**：`E_SCHEMA`（rows 超 500 / 行结构非法）、`E_INVARIANT`（行级 scope）、`E_CONFLICT`。

**agent_note**：
> 批量登记资产（≤500 行，httpx 探活结果回灌用）。行级结果数组返回，单行失败不影响其余。评级与状态仍分别走 asset_grade / asset_state。

#### 1.3.3 `asset_grade` —— 分级落库（"脚本产 proposal 不落库"公理的样板）

**语义**：把可挖掘性评分（score）落库并派生 SABC 层级，同时可标注 accept/biz。**本域唯一能写 score/level/accept/biz 的动词**。两种模式二选一（网关校验互斥，同传 → `E_SCHEMA`）：

- **proposal 模式**（script 通道，样板设计）：`grade-assets.py` 纯计算产出 JSON 建议清单文件 → 本命令校验后落库；
- **单资产模式**（model/dashboard 通道）：vision_triage 分诊补级、人工/模型调级。

**关键设计：level 永远不是入参**。调用方只给 score；`score → level` 映射是域私有常量（对齐 `rules/src/asset-scoring.md`）：

| score | level |
|---|---|
| ≥ 75 | S |
| 60–74 | A |
| 40–59 | B |
| < 40 | C |

这样"level 只经 asset_grade 写入"进一步收紧为"level 只由 asset_grade 内部派生"——连 asset_grade 的调用方都无法直接指定层级（想给 A 就给 60–74 的 score）。

**参数 schema**（`additionalProperties: false`，两组互斥）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `proposal_path` | string | 模式①必填 | proposal 文件绝对路径（必须在 `results/<run_id>/` 或 `data/proposals/` 下——沙箱可写区，域读取后落库） |
| `host` | string | 模式②必填 | 已登记资产的主机（**INV-4：必须先 asset_upsert 存在**，否则 `E_NOT_FOUND`） |
| `type` | string | 模式②❌ | 默认 `'host'` |
| `score` | integer | 模式②必填 | 0–100 |
| `accept` | string | ❌ | enum `full` / `intrusion-only` / `none`（SRC 收录政策；缺省不动既有值） |
| `biz` | string | ❌ | enum `核心` / `一般` / `未知` |
| `rationale` | string | 模式②必填 | ≥10 字，分级依据（对齐 exp_store justification 纪律） |
| `regrade` | boolean | ❌ | `false`；已分级资产默认拒绝重评（INV-5） |
| `run_id` | string | ❌ | 证据 run（vision_triage 等来源；proposal 模式从文件内取） |
| `owner` | string | ❌ | enum `confirmed` / `suspect` / `third_party`（2026-09-06 裁决新增；缺省不动既有值）。判据口径 `rules/src/asset-scoring.md` |
| `owner_evidence` | string | owner 传入时必填 | ≥10 字归属证据（ICP 备案号/证书 Organization/whois 摘录/favicon 同源依据）——**证据即参数**铁律（宪法 §四.4）：无证据不打 owner 标 |

**proposal 文件格式（样板全文，`silksec/asset-grade-proposal@1`）**：

```json
{
  "schema": "silksec/asset-grade-proposal@1",
  "generated_by": "grade-assets.py v5",
  "generated_at": 1789000000000,
  "run_id": "run_01HXYZ",
  "scoring_rules": "rules/src/asset-scoring.md",
  "scope_file": "data/scope.yml",
  "summary": {
    "candidates": 1785,
    "skipped_out_of_scope": 312,
    "by_level": { "S": 3, "A": 210, "B": 1200, "C": 372 }
  },
  "rows": [
    {
      "host": "admin.example.com",
      "type": "web",
      "score": 78,
      "reasons": ["kw:admin +18", "fp_n=2 +8", "hi_n=1 +25"],
      "accept": null,
      "biz": null
    }
  ]
}
```

**proposal 校验清单**（网关前置不变量，逐条）：

| # | 校验 | 失败码 |
|---|---|---|
| P1 | 文件存在且 JSON 可解析 | `E_ASSET_PROPOSAL_INVALID`（hint：先跑 `grade_assets` 纯计算脚本产 proposal） |
| P2 | `schema` 字段 === `"silksec/asset-grade-proposal@1"` | `E_ASSET_PROPOSAL_INVALID` |
| P3 | `rows` 数组 1..2000 行 | `E_ASSET_PROPOSAL_INVALID`（hint：脚本侧 `--split 2000` 分片产出多个 proposal） |
| P4 | 每行 host 非空、score 为 0–100 整数、`reasons` ≥1 条 | `E_ASSET_PROPOSAL_INVALID`（行号进 message） |
| P5 | 行内 (host, type) 无重复 | `E_ASSET_PROPOSAL_DUP_ROW` |
| P6 | `run_id` 引用的 `results/<run_id>/` 目录真实存在（**证据即参数**：分级是驱动主动扫描的准入决策） | `E_EVIDENCE_REQUIRED` |
| P7 | `summary.candidates === rows.length`（防脚本与文件漂移） | `E_ASSET_PROPOSAL_INVALID` |
| P8 | 每行 (host, type) 已在 assets 表（INV-4：先登记后分级） | 行级 `E_NOT_FOUND`（该行跳过并计入 results，不炸整批） |
| P9 | 已有 level 非空的行：默认跳过（计 `skipped_graded`）；`regrade: true` 时覆盖 | 非错误 |

**返回信封**（proposal 模式成功）：

```json
{
  "ok": true, "domain": "asset", "cmd": "grade",
  "data": {
    "mode": "proposal", "proposal_path": "results/run_01HXYZ/grade-proposal.json",
    "graded": 1782, "skipped_graded": 3, "failed": 0,
    "by_level": { "S": 3, "A": 209, "B": 1201, "C": 369 },
    "ungraded_remaining": 55,
    "results": [{ "host": "admin.example.com", "level": "S", "ok": true }]
  },
  "event_ids": ["evt_...", "..."],
  "idempotency_key": "asset:grade:proposal:sha256:9f3a...",
  "replay": false
}
```

**幂等**：proposal 模式 = 自然键 `asset:grade:proposal:sha256:{文件指纹}`（重放整文件返回首次结果——脚本重跑产同内容文件天然免疫）；单资产模式 = 显式键 `asset:grade:{host}|{type}`（同资产同分重放安全）。

**错误码汇总**：

| code | 触发 | hint |
|---|---|---|
| `E_ASSET_ALREADY_GRADED` | 单资产模式对已分级资产且未带 regrade | "资产 {host} 已是 {level} 级；确认要重评请带 regrade: true（会覆盖 score/level 并审计 before/after）" |
| `E_NOT_FOUND` | 单资产模式 host 未登记（INV-4） | "先 asset_upsert 登记，再分级——未登记的资产没有 last_seen/指纹密度可算" |
| `E_EVIDENCE_REQUIRED` | proposal 无有效 run_id / 单资产模式无 rationale | "分级是准入决策，必须可回溯：proposal 需来自真实 run，手工调级需 ≥10 字 rationale" |
| `E_ASSET_PROPOSAL_INVALID` / `E_ASSET_PROPOSAL_DUP_ROW` | 见上表 | 附具体行号与期望格式 |
| `E_SCHEMA` | 两模式同传 / 都缺 / score 越界 | — |

**actor**：model / script / dashboard。**proposal 不自动落库**（有意设计）：`grade-assets.py` 经 run_cli 跑完后，模型在工具摘要里看到 proposal 路径与分级分布，**由模型显式调用 asset_grade 落库**——分级一旦落库即驱动主动扫描队列（deep_queue），保留一个确认点；是否改为调度自动落库见 §四。

**side_effects**：`rows_touched: assets ≤2000`，`events: ≤行数`，`caches: overview 失效`。

**agent_note**：
> 资产分级落库（本域唯一写 score/level/accept/biz 的入口）。两种用法：① grade_assets 脚本产出 proposal 文件后传 proposal_path 批量落库（≤2000 行）；② 单资产传 host+score+rationale（vision_triage 分诊/人工调级）。level 由 score 自动派生（S≥75/A60-74/B40-59/C<40），不可直接指定。已分级资产重评需 regrade: true。

#### 1.3.4 `asset_state` —— 生命周期流转

**语义**：资产状态机（`new / changed / stable / dead`）唯一入口。**调用方传的是"观测信号"而非目标状态**（宪法铁律 1：状态机私有）——signal → 目标 state 的映射表是域私有资产：

| signal | 含义 | 目标 state | 证据要求 |
|---|---|---|---|
| `content_changed` | 内容变化（js-watch bundle hash 变化 / 同名子域证书更新 / 探活内容 diff） | `changed` | evidence 必填 |
| `probe_alive_unchanged` | 探活成功且内容无变化 | `stable` | evidence 必填 |
| `probe_failed` | 探活失败（httpx 无响应/DNS 解析消失） | `dead` | evidence 必填 |
| `revived` | dead 资产重新探活成功（复活） | `changed` | evidence 必填 |

**流转图与网关校验矩阵**（`E_STATE` 拒绝的组合）：

```
                 ┌──────────── probe_alive_unchanged ────────────┐
                 ▼                                              │
  [登记] ──▶ new ──content_changed──▶ changed ◀──content_changed─┤ (自环)
             │                          │                       │
             │ probe_alive_unchanged     │ probe_alive_unchanged │
             ▼                          ▼                       │
           stable ──content_changed──▶ changed                  │
             │            │                                         │
             │ probe_failed│ probe_failed                           │
             ▼            ▼                                         │
            dead ◀────────┘──probe_failed(自环, 幂等)                │
             │                                                    │
             └──revived──▶ changed ────────────────────────────────┘
```

| 当前\signal | content_changed | probe_alive_unchanged | probe_failed | revived |
|---|---|---|---|---|
| new | → changed | → stable | → dead | E_STATE |
| changed | → changed（自环，刷新 changed_at） | → stable | → dead | E_STATE |
| stable | → changed | → stable（自环 no-op） | → dead | E_STATE |
| dead | **E_STATE** | **E_STATE** | → dead（自环 no-op） | → changed |
| NULL（未跟踪） | → changed | → stable | → dead | E_STATE |

**单向性**：`new` 不可被任何流转再进入（它只由 asset_upsert 登记 produces）；`dead` 只能经 `revived` 离开；`dead + content_changed` → `E_STATE`（hint："dead 资产内容变化说明实际复活，先探活确认再以 signal=revived 登记"）。

**参数 schema**：

| 参数 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `host` | string | ✅ | 已登记（否则 E_NOT_FOUND） |
| `type` | string | ❌ | 默认 `'host'` |
| `signal` | string | ✅ | enum 上表四值 |
| `evidence` | string | ✅ | run_id 或 radar 事件 id（**证据即参数**） |
| `note` | string | ❌ | 备注（如 js-watch hash 前后值） |

**返回**：`data: { host, type, from: "stable", to: "changed", changed: true }`；自环 no-op 返回 `changed: false`、不发事件（幂等语义）。

**幂等**：自动指纹（同 host+signal+evidence 重放 → 首次结果）。

**actor**：model（recon 任务消化雷达后登记状态变化）、script（订阅 handler 的 httpx 探活 proposal 自动派生 probe_alive_unchanged / probe_failed）、dashboard。

**agent_note**：
> 资产生命周期流转（new/changed/stable/dead）。传观测信号（content_changed / probe_alive_unchanged / probe_failed / revived）+ 证据 run_id，不传目标状态——状态机由域校验。变化雷达（radar_read）命中后应尽快登记 changed（新内容黄金窗口优先测）；探活失败登记 dead 自动出深挖队列。

#### 1.3.5 `fp_record` —— 指纹登记

**语义**：登记技术栈指纹（host + tech 自然键）。新登记或 version 变化 → 发事件；同版本重报只刷 last_seen（不发事件）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `host` | string | ✅ | — | 非空（归一化同 asset_upsert） |
| `tech` | string | ✅ | — | 非空，如 `ruoyi` / `spring` / `weblogic`；建议小写 |
| `version` | string | ❌ | `''` | 空不覆盖既有版本 |
| `source` | string | ❌ | `''` | `tool:run_id` 形态 |
| `program_id` | string | ❌ | `null` | 同 INV-3（域外指纹允许不带） |

**返回**：`data: { host, tech, version, created: false, version_from: "2.8" }`。

**幂等**：自然键 `asset:fp:{host}|{tech}`。

**错误码**：`E_SCHEMA` / `E_INVARIANT`（scope）/ `E_NOT_FOUND`——**指纹不要求 host 先在 assets 表**（v4 行为：fpAdd 独立可写；v5 保留——httpx tech 偶尔先于资产行到达 proposal 分支，强制 INV-4 反而丢数据。指纹是读模型，弱一致可接受）。注：此决策与 INV-4（分级要求先登记）不对称是有意的——分级是决策、指纹是观测。

**agent_note**：
> 登记指纹（技术栈+版本，host+tech 去重）。指纹命中是 N-day 检索的触发器（intel_hunt 订阅 fp.recorded 自动建候选任务）。httpx 探活的 tech 数组会经 parser proposal 自动登记，无需手动。

#### 1.3.6 `fp_record_bulk`

参数：`rows`（1..500，每行 = fp_record 参数）、`proposal_ref`。语义/校验/事件同 fp_record 逐行展开，行级结果数组。幂等 = `asset:fp:bulk:{proposal_ref}` + 逐行自然键。actor：model / script。

### 1.4 查询逐个详述（读投影，纯读无副作用）

统一分页信封 `{ rows, total, limit, offset }`；`limit` 默认 50、**上限 500**（宪法 §七.2；v4.x 上限 200 一并提升）；`sort` 白名单列 + `dir=asc|desc`；**行数 = total 断言进契约测试**（同一 where 构造器）。

**可见域谓词**（本域适用项与默认值）：

| 谓词 | 语义 | 默认 |
|---|---|---|
| `program` | 项目归属（program_id 过滤） | 全部（不过滤） |
| `state` | 生命周期 | 全部（**asset_deep_queue 例外：默认排除 dead**） |
| `level` | 分级（含 `none` = 未分级） | 全部 |

#### `asset_list`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host_like` | string | `''` | host 模糊 |
| `type` | string | `''` | 精确 |
| `program_id` | string | `''` | 谓词 |
| `level` | string | `''` | `S/A/B/C/none`（none = level IS NULL——P15 待分级筛选语义平移） |
| `level_in` | string | `''` | 逗号多级，如 `"S,A,B"` |
| `accept` | string | `''` | 精确 |
| `state` | string | `''` | 精确 |
| `sort` | enum | `last_seen` | `last_seen / host / type / program_id / score` |
| `dir` / `limit` / `offset` | — | desc/50/0 | — |

返回行字段：`host, type, source, program_id, last_seen, score, level, accept, biz, state`。

#### `asset_get`（单主机钻取）

参数：`host`（必填）、`type`（❌）。返回多类型资产行 + **跨域只读聚合**：`fingerprints`（本域 fp_query）、`endpoint_total`（endpoint 域查询）、`findings_by_severity`（vuln 域查询，noise=0 口径）、`siblings`（同 root 前 20）。跨域读经 QueryGateway 注入的查询接口（只读允许跨域，禁止跨域**写**）。目标不存在 → `E_NOT_FOUND`。

#### `asset_family`（域名族 / 网段聚合）

参数：`root`（必填，如 `example.com` 或 `1.2.3.0/24`）。返回 `{ root, hosts: [≤200 行，按 score desc, last_seen desc] }`。root 由 `asset_overview` 的族行展开传入（域内 root 冗余列直查）。

#### `asset_overview`（总览聚合）

无参数。返回 `{ total, family_count, by_level, by_state, by_accept, families: [≤300 族行 {root, kind: domain|subnet, host_count, endpoint_count, finding_count, max_score, top_level, last_seen}] }`。缓存 25s TTL + 写命令失效（§2.5）。

#### `fp_query`

参数：`host`（精确）、`tech`（LIKE 模糊）、`program_id`、`limit`（默认 50 上限 500）、`offset`。返回行：`program_id, host, tech, version, source, last_seen`。**v5 修正**：v4 fpQuery 无 offset/total——补齐统一分页信封。

#### `asset_deep_queue`（深挖队列——资产准入纪律的查询化）

**固化查询**：`level IN ('S','A','B') AND (accept IS NULL OR accept != 'none') AND (state IS NULL OR state != 'dead') ORDER BY score DESC, last_seen DESC`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `program_id` | string | `''` | 谓词（默认全部项目） |
| `limit` / `offset` | int | 50 / 0 | 派单取 top-N |

返回：`{ rows, total, limit, offset }`，行含 `host, type, score, level, accept, biz, state, last_seen`。

**这是 v4.x "资产准入纪律"（level_in=S,A,B + accept≠none + sort=score desc 写在 asset_query 工具描述里靠模型自觉拼参数）的查询化**：exec/task 域派单与 vuln 任务取队列一律调本查询，不再各自拼 where——未分级（NULL）与 C 级**物理上取不到**。深挖队列纪律的完整口径见 `rules/src/asset-scoring.md`（owner=confirmed 条款见 §四 开放问题）。

### 1.5 事件

事件信封对齐宪法 §八.2（id/domain/name/ts/actor/cause/payload）；payload 只含 ID 与判据快照。

#### `asset.registered`

```json
{ "host": "admin.example.com", "type": "web", "program_id": "bytedance", "source": "httpx:run_01H", "root": "example.com" }
```

#### `asset.graded`

```json
{
  "host": "admin.example.com", "type": "web",
  "from": { "level": null, "score": null, "accept": null, "biz": null },
  "to":   { "level": "S", "score": 78, "accept": null, "biz": null },
  "mode": "proposal",
  "proposal_sha256": "9f3a...",
  "run_id": "run_01HXYZ"
}
```

#### `asset.state.changed`（状态实际变化才发）

```json
{ "host": "api.example.com", "type": "web", "from": "stable", "to": "changed", "signal": "content_changed", "evidence": "run_01HZZZ" }
```

#### `fp.recorded`

```json
{ "host": "oa.example.com", "tech": "ruoyi", "version": "4.7.2", "version_from": "", "source": "httpx:run_01H", "program_id": "bytedance" }
```

订阅方（供其域文档引用）：vuln 域 intel_hunt（fp.recorded → N-day 候选任务，v4 行为事件化）、task/exec（asset.graded → 派单队列刷新提示）、ledger（asset.graded → 台账联动）、memcore（**不订阅**——资产无 memcore 生命周期，显式排除防误配）。

### 1.6 模型工具面投影（ToolProjector 自动生成，工具名 = 命令/查询名）

| 工具名 | 描述全文（= manifest agent_note，逐字投影） |
|---|---|
| `asset_upsert` | 登记或触活一个资产（域名/IP/存活 web 站点）。本工具只登记"资产存在"：host + type + 来源；评级（score/level/accept/biz）与生命周期（state）分别走 asset_grade / asset_state。带 program_id 时主机必须在项目授权范围内。重复登记安全（幂等，只刷 last_seen）。 |
| `asset_upsert_bulk` | 批量登记资产（≤500 行，httpx 探活结果回灌用）。行级结果数组返回，单行失败不影响其余。评级与状态仍分别走 asset_grade / asset_state。 |
| `asset_grade` | 资产分级落库（本域唯一写 score/level/accept/biz 的入口）。两种用法：① grade_assets 脚本产出 proposal 文件后传 proposal_path 批量落库（≤2000 行）；② 单资产传 host+score+rationale（vision_triage 分诊/人工调级）。level 由 score 自动派生（S≥75/A60-74/B40-59/C<40），不可直接指定。已分级资产重评需 regrade: true。 |
| `asset_state` | 资产生命周期流转（new/changed/stable/dead）。传观测信号（content_changed / probe_alive_unchanged / probe_failed / revived）+ 证据 run_id，不传目标状态——状态机由域校验。变化雷达（radar_read）命中后应尽快登记 changed（新内容黄金窗口优先测）；探活失败登记 dead 自动出深挖队列。 |
| `fp_record` | 登记指纹（技术栈+版本，host+tech 去重）。指纹命中是 N-day 检索的触发器（intel_hunt 订阅 fp.recorded 自动建候选任务）。httpx 探活的 tech 数组会经 parser proposal 自动登记，无需手动。 |
| `fp_record_bulk` | 批量登记指纹（≤500 行）。 |
| `asset_list` | 检索资产图谱：host_like 模糊、type/program_id/level/level_in/accept/state 过滤。level='none' 筛未分级资产（分级前的待办清单）。 |
| `asset_get` | 单主机钻取：多类型资产行 + 指纹 + 接口计数 + 漏洞分级统计 + 同族主机。 |
| `asset_family` | 域名族/网段成员主机清单（root 从 asset_overview 族行取）。 |
| `asset_overview` | 资产总览：评级/状态/收录分布 + 域名族聚合（缓存 25s）。 |
| `fp_query` | 检索指纹（host 精确 / tech 模糊 / program 过滤）。命中技术栈后查 N-day。 |
| `asset_deep_queue` | 深挖队列（固化查询）：level∈{S,A,B} + accept≠none + 非 dead，按 score 降序。**主动扫描/派单取目标一律走本查询**——未分级与 C 级资产取不到，这是资产准入纪律的物理形态。 |

### 1.7 看板 RPC 投影（RpcProjector 自动生成，RPC 名 = `{domain}.{verb}` 点分）

| RPC 名 | 对应 | 看板用途（资产视图） |
|---|---|---|
| `asset.list` | asset_list | 资产表格（分页/筛选，v4 `assets` case 平移） |
| `asset.overview` | asset_overview | 总览大盘 + 域名族聚合（v4 `assetOverview`） |
| `asset.detail` | asset_get | 主机钻取面板（v4 `assetDetail`） |
| `asset.family` | asset_family | 族行展开（v4 `assetFamily`） |
| `asset.grade` | asset_grade（actor=dashboard，带 operator） | 看板手工调级/重评表单 |
| `asset.state` | asset_state（actor=dashboard） | 看板标 dead/复活 |
| `asset.fpQuery` | fp_query | 资产视图指纹子表 |

写操作审计带 `operator`（auth-gate 用户名）。v4 `assets/assetOverview/assetDetail/assetFamily` 四个 case 删除，由投影替代。

### 1.8 外部调用示例

**模型调用**（worker 会话内，工具即命令投影）：

```json
{ "tool": "asset_grade",
  "args": { "proposal_path": "results/run_01HXYZ/grade-proposal.json" } }
```

**代码调用**（其他域/看板壳经总线，actor 从调用面注入——参数里声明 actor 一律被忽略）：

```js
const asset = ctx.inject('secDomain.asset')
// 写：一律经网关（schema→不变量→事务→事件→审计）
await bus.dispatch('asset', 'grade',
  { proposal_path: '/opt/silkspool/dsh/data/results/run_01HXYZ/grade-proposal.json' },
  { actor: 'script', run_id: 'run_01HXYZ' })
// 读：查询网关
const q = await asset.query('deep_queue', { program_id: 'bytedance', limit: 10 })
```

**脚本调用**（grade-assets.py 收编后的两段式——样板）：

```bash
# 第一段：纯计算（run_cli 跑，不落库，manifest store 改为 proposal）
python3 scripts/pipeline/grade-assets.py --proposal results/run_01HXYZ/grade-proposal.json
# 第二段：落库唯一通道 = 域命令（human 应急通道，审计高亮）
sec cmd asset grade --proposal-path results/run_01HXYZ/grade-proposal.json --actor human
```

**订阅 handler 调用**（exec.run.completed → asset 域，async 弱联动）：

```js
// manifests: subscribes: [{ event: 'exec.run.completed', mode: 'async', handler: 'onRunProposal' }]
async function onRunProposal(evt) {
  const p = evt.payload.parse_proposal
  if (p?.kind === 'assets') {                       // httpx 探活
    await bus.dispatch('asset', 'upsert_bulk', { rows: p.assets, proposal_ref: evt.payload.run_id },
      { actor: 'script', run_id: evt.payload.run_id })
    await bus.dispatch('asset', 'fp_record_bulk', { rows: p.fingerprints, proposal_ref: evt.payload.run_id },
      { actor: 'script', run_id: evt.payload.run_id })
    for (const s of p.state_signals || [])           // 探活结果派生状态信号
      await bus.dispatch('asset', 'state', { host: s.host, type: s.type, signal: s.signal, evidence: evt.payload.run_id },
        { actor: 'script', run_id: evt.payload.run_id })
  }
  // 注意：p.kind === 'grade' 的 proposal 不在此自动落库（分级保留确认点，见 §1.3.3）
}
```

---

## 二、内部实现（Internal）

### 2.1 数据模型（逐列，owner = asset 域；表名沿用 v4 不迁库）

**`assets` 表**（PK `(host, type)`；81,028 行，2026-09-06 实测）：

| 列 | 类型 | 写入者（唯一动词） | 定义 |
|---|---|---|---|
| `host` | TEXT NOT NULL | asset_upsert | 主机标识（域名小写/IP，归一化后） |
| `type` | TEXT NOT NULL DEFAULT 'host' | asset_upsert | `domain`/`ip`/`web`/`service`/`host` |
| `source` | TEXT | asset_upsert | 首个非空来源（`tool:run_id` / manual）；触活不覆盖 |
| `attrs` | TEXT | asset_upsert | 自由 JSON（httpx title/webserver/status/tech 快照） |
| `first_seen` | INTEGER NOT NULL | asset_upsert | 登记时刻（UTC epoch ms） |
| `last_seen` | INTEGER NOT NULL | asset_upsert | 最近触活 |
| `program_id` | TEXT | asset_upsert | 项目归属（INV-3 校验；null = 域外参考资产） |
| `root` | TEXT | asset_upsert | **冗余列**（域内从 host 派生）：域名取注册域近似（末两标签；.com.cn 等双后缀取三），IP 取 /24 网段——域名族/网段聚合索引（v4.1），8 万行免全量正则 |
| `score` | INTEGER | **asset_grade** | 可挖掘性评分 0–100（SABC 打分表：A 漏洞价值 40 / B 出洞概率 45 / C 时效 15） |
| `level` | TEXT | **asset_grade（派生）** | SABC：S≥75 优先挖穿 / A 60-74 深挖主力 / B 40-59 常规覆盖 / C<40 仅登记 / **NULL=未分级=禁入主动扫描队列（准入门）** |
| `accept` | TEXT | **asset_grade** | SRC 收录政策：`full`（默认，NULL 视同）/ `intrusion-only`（只报入侵类）/ `none`（暂停收录，可算分不驱动挖掘） |
| `biz` | TEXT | **asset_grade** | 业务分级：核心（交易/资金/核心 PII）/ 一般 / 未知 |
| `state` | TEXT | **asset_state** | new / changed / stable / dead（与上轮探活对比） |
| `changed_at` | INTEGER | asset_state | **v5 新增列**（ensureCol 幂等）：最近一次状态流转时刻（changed 自环也刷新） |
| `graded_at` | INTEGER | asset_grade | **v5 新增列**：最近分级时刻（重评刷新） |

**`fingerprints` 表**（PK `(host, tech)`；119 行 / 79 主机）：

| 列 | 类型 | 写入者 | 定义 |
|---|---|---|---|
| `program_id` | TEXT | fp_record | 项目归属 |
| `host` | TEXT | fp_record | 主机 |
| `tech` | TEXT | fp_record | 技术栈标识（ruoyi/spring/weblogic…） |
| `version` | TEXT | fp_record | 版本（空不覆盖；变化发事件） |
| `source` | TEXT | fp_record | `tool:run_id` |
| `last_seen` | INTEGER | fp_record | 最近确认时刻 |

**索引**（现有 + v5 新增）：

| 索引 | 状态 | 服务查询 |
|---|---|---|
| PK `(host, type)` | 现有 | upsert 冲突合并 / asset_get |
| `idx_assets_root` | 现有 | asset_family / overview 族聚合 |
| `idx_fp_host` | 现有 | fp_query / assetDetail 指纹子表 |
| `idx_assets_program (program_id)` | **v5 新增** | program 谓词（deep_queue 按项目派单） |
| `idx_assets_level_score (level, score DESC)` | **v5 新增** | deep_queue 的 `level IN (S,A,B) ORDER BY score DESC` |
| `idx_assets_state (state)` | **v5 新增** | state 谓词 / dead 排除 |

### 2.2 状态机与不变量

**状态机**：见 §1.3.4 流转图与校验矩阵（唯一入口 asset_state；signal→state 映射域私有）。

**manifest invariants 清单**（网关事务前逐条执行；域实现不重复校验）：

| # | 不变量 | 失败码 |
|---|---|---|
| INV-1 | 评级列（score/level/accept/biz）只经 asset_grade 写入；state 只经 asset_state 写入——**结构性实现**：其余动词 schema 不含这些参数（additionalProperties:false） | E_SCHEMA |
| INV-2 | state 流转必须命中 §1.3.4 矩阵；new 不可再进入；dead 只经 revived 离开 | E_STATE |
| INV-3 | asset_upsert/fp_record 带 program_id 时，host 必须命中该 program 的 scope 域模式或授权 CIDR（经 authz 域 `scope_check` 查询，只读跨域） | E_INVARIANT |
| INV-4 | asset_grade 的目标行必须已登记（先 asset_upsert 后 grade）；proposal 行级失败跳过不炸批 | E_NOT_FOUND（行级） |
| INV-5 | 已分级资产重评必须显式 regrade: true | E_ASSET_ALREADY_GRADED |
| INV-6 | score ∈ [0,100] 整数；level 由域私有映射从 score 派生，永不作为参数出现 | E_SCHEMA |

### 2.3 事务与联动

- **一个命令一个事务**：每个动词的全部行变更在 BEGIN IMMEDIATE 内完成（proposal 分级 = 整批 2,000 行一个事务；行级 P8 失败在事务内跳过该行，其余提交）。跨域效果不进事务。
- **事件时序**：事务提交成功后发布 manifest 声明事件（行级事件 ≤ 行数）；失败不发。同步订阅者异常 → audit 记 `subscriber_failed`，不回滚命令（本域无强联动订阅——intel_hunt 候选任务、ledger 台账均为弱联动 async，丢失可经 `sec bus replay --since <ts>` 重放）。
- **缓存失效**：所有写命令成功后调 `invalidateOverview()`（v4 模式保留）。
- **订阅联动**（exec.run.completed，mode: async）：见 §1.8 handler。httpx 探活 proposal 自动登记资产+指纹+状态信号；**grade proposal 不自动落库**（§1.3.3 设计决策）。
- **失败语义**：E_BACKEND_UNAVAILABLE（http 后端）与 E_CONFLICT（busy 超时）retryable=true，信封标注，网关不自动重试（调用方/调度决策）。

### 2.4 后端适配器

**repository 接口**（`backend/repository.js`，JSDoc；方法名 = 命令/查询所需**原语**，不含 SQL 语义、不含业务校验）：

```js
/** @returns {Promise<AssetRow|null>} */
getAsset(host, type)
/** 新行插入；返回是否 created */
insertAsset(row) → { created }
/** 触活：刷 last_seen，source/program_id 就地补空不覆盖 */
touchAsset(host, type, source, program_id, ts)
/** 分级原语：一次写 score/level/accept/biz/graded_at（调用方已校验 INV-4/5/6） */
updateAssetGrading(host, type, { score, level, accept, biz, graded_at })
/** 状态原语：写 state/changed_at */
updateAssetState(host, type, state, ts)
/** 谓词原语：list 与 count 必须共享同一 where 构造器（契约测试断言） */
listAssetsWhere(filters, order, limit, offset) → rows
countAssetsWhere(filters) → n
/** 聚合原语 */
overviewAggregate() → { total, family_count, by_level, by_state, by_accept, families }
familyMembers(root, limit) → rows
siblingsOfHost(host, root, limit) → rows
/** 指纹 */
getFingerprint(host, tech)
upsertFingerprint(row) → { created, version_from }
listFingerprintsWhere(filters, order, limit, offset) → rows
countFingerprintsWhere(filters) → n
```

**三后端实现要点与能力矩阵**：

| 命令/查询 | sqlite-local | http-remote（外部 CMDB 对接设想，Phase 4+） | file |
|---|---|---|---|
| asset_upsert / _bulk | full | **partial**：远端无 (host,type) upsert 语义时按"create-or-patch"映射；attrs 字段映射按远端 schema 白名单裁剪，裁剪明细进 sync 日志 | **不适用**（unsupported 全量） |
| asset_grade | full | **partial**：建议式落库远端多无对应概念——只同步结果（score/level 映射远端 severity 字段），proposal 校验仍在本地 | 不适用 |
| asset_state | full | **partial**：远端 state 机不同构时只映射 dead/alive | 不适用 |
| fp_record / _bulk | full | **unsupported**（远端无指纹表——E_CAPABILITY_UNSUPPORTED，hint 走 sqlite 混布） | 不适用 |
| asset_list/get/family/overview/fp_query/deep_queue | full | **partial**：family/overview 聚合远端不支持 → **本地计算**（拉平铺行本地聚合）；deep_queue 固化 where 必须本地重写为远端查询再聚合 | 不适用 |
| 事件 | full | 事件由本地域发布（远端镜像经订阅推送，非能力项） | — |

**不适用 file 后端的理由**（记录决策）：assets 是主键冲突合并 + 事务 + 8 万行聚合的关系语义，TSV/YAML 均无法承载；本域无 file 形态产物。**混布设想**：sqlite-local 主库 + http-remote 镜像（订阅 asset.registered/graded 推送 CMDB），同步边界在域内 commands 层，调用方无感。**切换**：bundle 配置一行；sqlite↔sqlite 热切换允许，切 http 需重启宿主面。

### 2.5 缓存与失效

| 缓存 | 内容 | TTL | 失效 |
|---|---|---|---|
| `_ovCache` | asset_overview 全量聚合（v4 模式平移：25s TTL + 写命令即失效 `invalidateOverview()`） | 25s | 任一写命令成功 |
| deep_queue | **不缓存**（派单低频、必须实时反映分级/状态变化） | — | — |
| asset_get/family/list | 不缓存 | — | — |

### 2.6 性能与容量

**现状规模**（2026-09-06 csai 实测，sqlite 直查）：

| 指标 | 值 |
|---|---|
| assets 总行数 | 81,028 |
| 分级分布 | S 338 / A 2,433 / B 48,403 / C 28,017 / **NULL（未分级）1,837** |
| state 分布 | new 10,799 / stable 1,665 / changed 34 / dead 16 / NULL ~68,500 |
| accept 分布 | full 12,494 / intrusion-only 9 / NULL 其余 |
| fingerprints | 119 行 / 79 主机（bytedance 46 / meituan-src 73） |
| root 冗余列 | 已全量回填（NULL 0 行） |

**查询路径与代价**（8 万行实测口径，v4 验证过）：overview 族聚合纯 SQL 走 `root` 冗余列 + `idx_assets_root`，接口/漏洞计数 LEFT JOIN 预聚合子查询，数十 ms / 25s 缓存（看板 30s 轮询安全）；deep_queue 走新 `idx_assets_level_score`，命中行 ~5.1 万（S+A+B），LIMIT top-N 即停，<10ms；family/get 主键/索引直查 <5ms。

**预期增长**：recon 每日新增资产百级（子域枚举+探活），分级 proposal 每批 ≤2,000；年增长 ~3–5 万行，SQLite 单表百万行内无压力。**WAL 参数**沿用 v4（busy_timeout 5s / synchronous NORMAL / wal_autocheckpoint 1000）。**proposal 校验**：2,000 行 JSON 解析 + 逐行 P4-P9 在事务前完成，<100ms。

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

| v4.x 现状（文件:行） | 内容 | v5 去向 |
|---|---|---|
| `dsh-plugin-sec-suite.asset-db.js:274-291` upsertAsset | INSERT ON CONFLICT + 评级 COALESCE 段 | `commands/upsert.js`——**评级 COALESCE 五段（score/level/accept/biz/state）废除**，只留 last_seen/source/program_id 合并 |
| `asset-db.js:376-404` queryAssets/countAssets/assetWhere | 谓词构造（含 level='none' / level_in） | `queries/list.js` + backend `listAssetsWhere`（level_in/accept 谓词平移；limit 200→500） |
| `asset-db.js:449-497` _ovCache/assetOverview | 总览聚合 + 缓存 | `queries/overview.js` + §2.5 缓存 |
| `asset-db.js:437-447` hostRoot | 域名族/网段归族 | 域内 util `lib/root.js`（**继续导出**给 authz 域审批 apex 判定复用，见 §四） |
| `asset-db.js:500-506` assetFamily | 族成员 | `queries/family.js` |
| `asset-db.js:509-522` assetDetail | 单主机钻取 | `queries/get.js`（endpoints/findings 计数改经 vuln/endpoint 域**查询**——跨域只读） |
| `asset-db.js:1431-1439` fpAdd | 指纹 upsert | `commands/fp_record.js`（version 变化检测 + 事件） |
| `asset-db.js:1441-1450` fpQuery | 指纹查询 | `queries/fp_query.js`（补 offset/total） |
| `asset-db.js:1723-1744` ingestText（asset 部分） | regex 兜底抽取登记 | exec 域 proposal（kind=assets）+ 本域订阅 handler |
| `dsh-plugin-sec-suite.asset-graph.js:57-99` asset_add/asset_query 工具 | 手写 zod schema | ToolProjector 投影 + §3.2 别名 |
| `dsh-plugin-sec-suite.asset-graph.js:584-616` fp_add/fp_query 工具 | 同上 | 投影 + 别名 |
| `dsh-plugin-sec-suite.parsers.js:52-76,159-164` parseJsonlHttpx + tech 自动 fpAdd | parser 直写 assets/fp | exec 域产 proposal（assets+fingerprints+state_signals 三段）→ 本域 handler 命令回灌（§1.8） |
| `data-seed/scripts/grade-assets.py:37-147` | **纯计算段**（KW_A/B/C 表 / score_host / level_of / scope 过滤 / 行组装） | **保留**，输出改 `--proposal` JSON（P1-P7 格式） |
| `grade-assets.py:151-157` | **UPDATE 段**（Python sqlite3 直写，绕过全部闸门） | **废除**——落库唯一通道 = asset_grade |
| `data-seed/tools.d/grade-assets.yaml`（store 语义） | store 落库 | manifest `store: proposal`（宪法 §五"脚本产 proposal 不落库"） |

### 3.2 兼容别名与观察期

总线别名表（同过网关全管线，不绕校验；别名使用全程审计 `deprecated_use`）：

| 旧名 | 新名 | 语义差异处理 |
|---|---|---|
| `asset_add` | `asset_upsert` | 旧工具的 level/score/accept/biz/state 参数被别名层**丢弃**，信封附 `warning: "评级字段已忽略，请用 asset_grade / asset_state"` + 审计 deprecated_use（不静默丢数据——prompt 改写期模型能看见） |
| `asset_query` | `asset_list` | 参数名一一对应（host_like/level/level_in/accept/program_id） |
| `asset_stats` | `asset_overview` | 同义 |
| `fp_add` | `fp_record` | 同构 |
| `fp_query` | `fp_query` | 同名（域前缀恰好一致），零成本 |

观察期：一个调度周期（7 天，audit 零使用为验收）→ 删除别名；prompt 引用（persona/objective/skills/technique-index）由脚本化改写（复用 p14-1-tool-refs.py 模式），改写后 discipline-audit 增"悬空工具引用"断言。

### 3.3 数据迁移脚本要点

1. **不迁库不改表名**：sqlite-local 直接接管 `assets`/`fingerprints` 现表（宪法 §六 取舍）。
2. **ensureCol 增列**（幂等，启动时）：`assets.changed_at INTEGER` / `assets.graded_at INTEGER`——存量行留 NULL（首次流转/重评时填）。`root` 已全量回填，无需处理。
3. **无僵尸数据修复**：asset 域不存在 vuln 域式的状态-可见性断裂病（grade-assets.py 直写是**通道**问题不是数据问题）；1,837 行未分级是合法状态（域外/待分诊），不回填。
4. **基线快照**：切换前 `silksec-backup` VACUUM INTO 快照先行；迁移脚本 dry-run 模式 + 幂等可重跑。
5. **验收**：契约测试矩阵（宪法 §十三：happy path / schema 拒绝 / 不变量反例 / 状态机反例 / actor 拒绝 / 幂等重放 / 并发 / 事件载荷）三后端跑同一套（http/file 按 §2.4 能力矩阵跳过 unsupported 并断言 fail-closed）后才允许切流；`asset_deep_queue` 的 total 与手工 SQL 对账一次。

---

## 四、开放问题

1. ~~**owner 列缺失**~~ **已裁决（2026-09-06 用户批准：增列 + 分两步固化）**：
   - **Phase 2 落地**：`ensureCol` 增 `owner TEXT NULL`（enum `confirmed` / `suspect` / `third_party`）；`asset_grade` 增加 `owner` + `owner_evidence` 参数（见 §1.3.3 参数表增补）——判据口径 `rules/src/asset-scoring.md`（confirmed = ICP 备案/证书 Organization/whois 强证据；suspect = 仅 favicon/同 C 段弱证据→挂起；第三方 SaaS/CDN → third_party 排除）。
   - **第一步（只记录不固化）**：deep_queue 不加 owner 条件——新分级必带 owner 标注，存量按接触回填（每次 asset_grade / 雷达命中 / 深挖前取队时补判）。
   - **第二步（固化条件打开）**：`confirmed+third_party 覆盖 ≥60% 深挖候选集（S+A+B 且 accept≠none 行）`后，把 `owner='confirmed'` 加进 deep_queue 固化 where。固化当日队列显著缩小属预期（SaaS/CDN 本就不该挖，正是纪律本意）。
   - 报表口径：asset_stats 增加 owner 分布计数，回填进度看板可见。
2. **雷达事件自动触发 asset_state**：当前设计由模型消化 radar 后手工登记 state 变化；ledger 域契约定稿后是否由 asset 域直接订阅 `ledger.radar.*` 事件自动 dispatch（signal 映射：新子域→changed、js hash 变化→content_changed）？
3. **grade proposal 自动落库**：分级保留模型确认点（§1.3.3），代价是 recon 任务忘调 asset_grade 时未分级资产堆积——是否对调度任务（#16/#17 recon）的 objective 固化"grade_assets → asset_grade"两步链，或允许 script actor 在特定 manifest 下自动落库？
4. **hostRoot 的归属**：域名注册域近似算法被 authz 域（scope-wildcard 审批 apex 判定）复用——保留跨域导出，还是 authz 域自带副本（复制漂移风险 vs 域自治）？
5. **http-remote CMDB 字段映射**：外部资产系统（设想）的 host/type/attrs 字段差异、severity 映射（SABC→远端等级）需在 Phase 4 试点时定稿；能力矩阵的 partial 差异清单届时具化。
6. **B 级占比过高**：score 基线 40（未知业务子域起步 B 下沿）导致 B 48,403 / C 28,017 的分布，深挖队列 S+A+B 命中 ~5.1 万行——评分基线是否调参（或在 deep_queue 增加 score 下限参数）？
7. **proposal 上限 2,000 vs 单事务时长**：2,000 行 UPDATE 单事务实测 <100ms，但若未来 proposal 行数上限提高，是否改为分片多事务（牺牲整批原子性换吞吐）需实测后定。

---

## 附：修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v5.0-draft-1 | 2026-09-06 | 初稿（依据归档 v5 方案 §4.2 种子 + v4.x 源码/运行态取证展开为实现级设计） |
