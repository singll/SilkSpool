# 12 · report 域设计（报告与提交稿的生成、索引、检索）

> 版本：v5.0 ｜ 状态：定稿 ｜ 契约版本：1
> 依赖：**订阅**：无（纯消费 vuln 域查询，不订阅任何事件）；**被订阅**：`report.built` / `report.draft.generated`（当前零订阅者，预留给 eval/ledger/每日链——弱联动）；**上游查询依赖**：`vuln_list` / `vuln_stats`（02-vuln.md 契约，经 QueryGateway 同步只读）。
> 上位文档：[`00-conventions.md`](00-conventions.md)（冲突以它为准）。

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 域名 | `report` |
| cordis 服务名 | `secDomain.report`（provide）|
| 插件包名 | `@silksec/sec-domain-report` |
| 后端插件包名 | `@silksec/sec-backend-report-sqlite`（索引）/ file（产物文件）混布 |
| profile 挂载 | web + headless 均挂载（模型生成报告、看板查看都要用）|
| owns（单写者）| `data/reports/`（含 `data/reports/submissions/`）整目录 + `reports` 索引表（sqlite-local）|
| 环境变量 | `SEC_DATA_DIR`（默认 `/opt/silkspool/dsh/data`，reports/ 与 asset-graph.db 均在其下）|

**owns 边界论证（submissions/ 归属——本文档的关键结论）**：

v4.x 中 `buildReport`（asset-db.js L1592-1664）与 `submissionDraft`（L1818-1865）同在 asset-db.js、同写 `data/reports/` 树，是"一个目录两个语义产物"。v5 归属有三种候选：

| 方案 | 描述 | 评价 |
|---|---|---|
| A（采用）| **report 域 owns `reports/` 全树（含 submissions/）+ 索引**；vuln 域不 own 任何 md 文件 | 文件单写者最干净：一棵目录树一个 owner，沙箱交叉校验（owns × sandbox 白名单）是一条规则；草稿与报告同构（读 vuln 查询 → 渲染 md → 落盘 + 索引），模板/路径校验/frontmatter 逻辑复用 |
| B | vuln 域 owns submissions/，report 域 owns reports/ | 目录树被两个域瓜分，`data/reports/` 的 vault/Obsidian 同步链路要面对两个 owner；草稿渲染逻辑（查重/脱敏证据指针）被迫塞进 vuln 域，域膨胀 |
| C | 整体归 vuln 域 | vuln 域变成"信号状态机 + 文档生成器"双职责，违背"一张状态机 + 一个 owner 为界"的域粒度公理；报告列表/查看（纯读、面向人）与漏洞流转（面向状态机）混在一起 |

**结论：方案 A。** vuln 域保持"信号状态机"纯度（只 owns findings 表 + submissions 状态列），文档产物统一归 report 域。代价是 v4 的 `submission_draft` 工具跨了域——用总线兼容别名解决（§3.2：`submission_draft` 与 `vuln_draft_submission` 均别名到 `report_draft_submission`，走废弃三段式）。vuln 域的 `vuln_submit` 动词只管状态流转（submitted_at/bounty/vendor_status），不产文件——两者以 finding_id 为唯一关联键。

### 1.2 命令（写动词）总表

| 动词 | 一句话语义 | actor 白名单 | 幂等键 | 事件 |
|---|---|---|---|---|
| `report_build` | 按筛选生成漏洞报告 md + 登记索引 | model, dashboard, human | 自动指纹（args 核心 + 北京分钟桶）| `report.built` |
| `report_draft_submission` | 按 finding 生成 SRC 提交草稿 + 查重 | model, dashboard, human | 自然键（finding_id + 北京日期）| `report.draft.generated` |

无其他写动词：**报告产物不可变**（built 即终态，无流转、无 update、无删除动词——删除走人工运维 + `report_index_rebuild` 修复索引，见 §2.5）。这是刻意设计：报告是"生成时刻的快照"，改内容 = 重新生成新报告（新时间戳文件名），不留任何就地改写入口。

### 1.3 命令逐个详述

#### 1.3.1 `report_build`（原 v4 `report_build`，参数面全量 schema 化）

**语义**：读 vuln 域信号面（noise=0 固定，不可参数化——延续 v4 P15 噪声闸门），按筛选聚合渲染 markdown 报告，落盘 `data/reports/report-{program}-{YYYYMMDD-HHmm}.md`，同事务写索引行。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `host_like` | string | 否 | `''` | 长度 ≤200；按 host/url 模糊匹配 |
| `program_id` | string | 否 | `''` | 空=全部项目；非空须存在于 vuln 域 program 维度（经 `scope_program_list` 校验），否则 `E_NOT_FOUND` |
| `since_days` | integer | 否 | `0` | 0-3650；0=全部；>0 时只含 created_at ≥ now−N×86400000 的行 |
| `status` | string | 否 | `''` | enum `['', 'confirmed', 'false_positive', 'submitted', 'accepted', 'dup', 'ignored']`；空=全部 |
| `severity` | string | 否 | `''` | 逗号分隔多选，每项 ∈ `['critical','high','medium','low','info']`；空=全部；重复项去重；全白空格项丢弃 |
| `source` | string | 否 | `''` | 精确匹配 findings.source（如 `xray` / `agent`）|

**返回信封 data**：

```json
{
  "report_id": "rpt_report_20260906-1430",
  "file": "report-meituan-20260906-1430.md",
  "kind": "report",
  "total": 17,
  "by_severity": { "high": 3, "medium": 9, "low": 5 },
  "noise_filtered": 42,
  "sections": [
    { "title": "## meituan（17）", "rows": 17 }
  ],
  "filters": { "host_like": "", "program_id": "meituan", "since_days": 0, "status": "", "severity": "", "source": "" },
  "hint": "报告已落盘，提交 SRC 前必须人工逐条核实"
}
```

**生成规则（实现者照抄，无需决策）**：

1. **数据源**：经 QueryGateway 分页拉取 `vuln_list`（noise 谓词固定 exclude、其余谓词透传上述参数，page limit=500 循环至 total）；单报告行数上限 **10,000**，超限 → `E_REPORT_SOURCE_OVERFLOW`（hint："发现数超上限，请按 program_id 或 severity 拆分构建"）。噪声计数来自 `vuln_stats.findings_noise`。
2. **分节**：按 program_id 分节（每节小标题 `## {program}（N）` + 统计 + 明细表）；无 program_id 的行归「未归属项目」；**单项目或全空时退化为按严重级分组单节**（SEV_ORDER = critical/high/medium/low/info，未知级别排后）；零行时输出 `## 无发现` 单节——全部照抄 v4 L1623-1638 逻辑。
3. **明细表列**：`| # | 级别 | 状态 | 类型 | 标题 | 目标 | 证据 |`；标题/证据首行内的 `|` 转义、证据截 80 字符——照抄 v4 L1640-1644。
4. **文件名**：`report-{nameTag}-{YYYYMMDD-HHmm}.md`，北京时间；nameTag = program_id 经 `[^a-z0-9_-]+`→`-` 清洗截 40 字符，无 program_id 时 `all`；**同分钟内已有同名文件且内容不同 → 追加 `-2`/`-3` 序号**（消除 v4 静默覆盖的隐患）。
5. **frontmatter**（v5 新增，见 §2.1 schema）：随 md 一并写入文件头。

**错误清单**：

| code | 触发 | hint 文案 |
|---|---|---|
| `E_SCHEMA` | 参数类型/枚举/长度不符 | message 指明字段与期望 |
| `E_NOT_FOUND` | program_id 不存在 | "program 不存在，先查 scope_program_list" |
| `E_REPORT_SOURCE_OVERFLOW` | 匹配行数 > 10,000 | "发现数超上限，请按 program_id 或 severity 拆分构建" |
| `E_REPORT_NOT_SIGNAL`（不会触发，防御位）| 数据源谓词被错误打开 | — |
| `E_BACKEND_UNAVAILABLE` | sqlite 不可达 / reports/ 不可写 | "检查 SEC_DATA_DIR 与磁盘；sqlite-local 后端 busy_timeout 5s 后重试" |
| `E_CONFLICT` | 索引写 SQLITE_BUSY | retryable=true |

**幂等**：自动指纹 = sha1(`args 核心字段` + 北京分钟桶)。同分钟同参重放 → 命中幂等表返回首次结果 + `replay: true`（文件已存在不重写）；同分钟异参 → 指纹不同，正常生成新文件（文件名序号防冲突）。模型/看板也可显式传 `idempotency_key`。

**actor**：`model`（worker/宿主会话工具调用）、`dashboard`（携带 auth-gate operator）、`human`（CLI 应急）。禁止 `script`/`webhook`/`scheduler`——报告是人工审校前的产物，机器不自动生成（每日链自动报告是开放问题 §四）。

**RoE（manifest `agent_note`，写给模型）**：报告**只列信号面**（noise=0），噪声仅给一行计数——候选不进报告，先 `vuln_confirm`；报告是**生成时刻的快照**，不是实时视图；生成 ≠ 可提交，外发前必须人工逐条核实；同参数重复构建幂等（同分钟内不产生重复文件）。

**side_effects 声明**：`[files: data/reports/*.md, rows_touched: reports 索引表 1 行, events: report.built, caches: 索引即时更新]`

#### 1.3.2 `report_draft_submission`（原 v4 `submission_draft` / 归档稿 `vuln_draft_submission`）

**语义**：读单条 finding（vuln_get），渲染 SRC 平台提交草稿（漏洞类型/等级自评/复现步骤/证据/修复建议/同目标同类型查重列表），落盘 `data/reports/submissions/draft-finding-{id}-{北京日期}.md` + 索引行。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `finding_id` | integer | 是 | — | >0；必须存在且 noise=0（信号面）；**status ∈ {confirmed, submitted}**（INV-R6）|
| `platform` | string | 否 | `''` | ≤64 字符，如 `美团SRC`；空则草稿留填写占位 |
| `regenerate` | boolean | 否 | `false` | true=同日已有草稿时强制重写（刷新查重与字段）；false=幂等命中返回现有文件 |

**返回信封 data**：

```json
{
  "report_id": "rpt_submission_draft_finding_341_20260906",
  "file": "submissions/draft-finding-341-2026-09-06.md",
  "kind": "submission_draft",
  "finding_id": 341,
  "dup_candidates": [ { "id": 288, "title": "...", "severity": "high", "status": "submitted", "host": "a.meituan.com" } ],
  "hint": "人工审校后提交；提交成功用 vuln_submit 回流状态"
}
```

**生成规则**：查重 = `vuln_list`（同 host 或同 vuln_type、noise=0、排除自身、created_at 倒序 limit 10）——照抄 v4 L1823-1827；草稿模板七段（平台/类型/等级自评/目标 → 漏洞描述 → 复现步骤 → 证据(截 2000 字) → 修复建议 → 提交前查重结果 → 数据指针）照抄 v4 L1829-1859，末行数据指针追加 frontmatter。

**错误清单**：

| code | 触发 | hint 文案 |
|---|---|---|
| `E_SCHEMA` | finding_id 缺失/非整数 | — |
| `E_NOT_FOUND` | finding 不存在 | "finding 不存在，先 vuln_list 核对 id" |
| `E_REPORT_NOT_SIGNAL` | finding 为候选（noise=1）| "候选不生成提交草稿——先补全证据并 vuln_confirm，或 vuln_reject 出池" |
| `E_CONFLICT` | 同日草稿被并发重写 | retryable=true |

**幂等**：自然键 = `report:draft_submission:{finding_id}:{北京日期}`。同键同参重放 → 返回现有文件 + `replay: true`（**不重写**，即使 finding 字段此后变了——审计可见）；`regenerate: true` 时绕过幂等命中、覆盖重写（regenerate 进指纹，视为新键）。

**actor**：`model`、`dashboard`、`human`（同 report_build；机器不自动产草稿）。

**RoE**：**仅信号面 finding 可生成**（候选先过 vuln_confirm）；查重结果**提交前必看**（防平台判重）；草稿生成后 finding 字段更新不会自动同步——需 `regenerate: true` 刷新；提交成功的回流动作是 vuln 域的 `vuln_submit`，不在本域。

**side_effects 声明**：`[files: data/reports/submissions/*.md, rows_touched: reports 索引表 1 行, events: report.draft.generated, caches: 索引即时更新]`

### 1.4 查询（读投影）逐个详述

#### 1.4.1 `report_list`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `program` | string | 否 | `''` | 精确匹配 program（`all` 视为空——兼容 v4 看板语义）|
| `q` | string | 否 | `''` | 关键字，匹配 文件名/标题/program（小写包含）|
| `kind` | string | 否 | `''` | enum `['', 'report', 'submission_draft']` |
| `date_from` / `date_to` | string | 否 | `''` | 北京日期 `YYYY-MM-DD` 闭区间，按 frontmatter date 过滤 |
| `limit` | integer | 否 | 50 | 上限 500 |
| `offset` | integer | 否 | 0 | |
| `sort` | string | 否 | `generated_at` | 白名单 `['generated_at', 'program', 'total']`；`dir` ∈ asc/desc，默认 desc（generated_at）/asc（其余）|

返回统一分页信封 `{ rows, total, limit, offset }`；row = 索引行投影：`{report_id, kind, file, program, title, date, total, by_severity, noise_filtered, actor, generated_at}`。**行数 = total 断言**（同一 where 构造器）。默认排除孤儿行（文件缺失的索引行——查询时惰性清理，见 §2.5）。

#### 1.4.2 `report_read`（看板 Modal 查看器后端）

| 参数 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `file` | string | 是 | 相对 reports/ 的路径；`path.resolve` 后必须以 `data/reports/` 为前缀（防穿越，照抄 v4 L613-621 纪律）；`.md` 后缀 |

返回 `{file, content, size, truncated}`；content > 300,000 字符截断 + `truncated: true`（v4 上限沿用）。错误：`E_NOT_FOUND`（文件不存在，hint "先 report_list 核对文件名"）。纯读，不审计（human 直调除外——总线统一规则）。

### 1.5 事件

| 事件名 | 触发命令 | payload schema |
|---|---|---|
| `report.built` | report_build | `{report_id, file, program, total, by_severity, filters, actor}` |
| `report.draft.generated` | report_draft_submission | `{report_id, file, finding_id, dup_candidates_count, actor}` |

payload 只含标识与判据快照，**不含报告正文**（§八.1）；事件落 `data/events/report.jsonl`。当前零订阅者——eval 域（假阳性消融回流）与 ledger 域（每日链报告产物登记）是预留消费者，届时声明弱联动（async）。

### 1.6 模型工具面投影（工具名 + 描述全文）

ToolProjector 自动注册（name=动词名，schema=命令 schema，description=下列全文）：

| 工具名 | 描述全文（manifest agent_note）|
|---|---|
| `report_build` | 生成漏洞报告（markdown）：按项目分节（无项目按严重级分组）+ 明细表（级别/状态/类型/标题/目标/证据），落盘 data/reports/ 并登记索引。可按 severity（逗号多选，如 high,critical）/source/status/host_like/program_id/近 N 天筛选。报告只列信号（noise=0），噪声仅计数；候选先 vuln_confirm 再进报告。提交 SRC 前必须人工逐条核实。 |
| `report_draft_submission` | SRC 提交半自动化：按 finding 生成平台提交草稿（复现步骤/影响/证据/修复建议 markdown）+ 同目标同类型查重检索，落盘 data/reports/submissions/。仅信号面 finding 可生成；查重结果提交前必看；提交成功后用 vuln_submit 回流状态。同日重复生成幂等，regenerate=true 刷新内容。 |
| `report_list` | 报告列表查询：按项目/关键字/日期/类型（report|submission_draft）筛选，返回元数据（program/日期/级别分布/总数），不读正文。 |
| `report_read` | 读单份报告全文：file 为 report_list 返回的相对路径；>300KB 截断。 |

### 1.7 看板 RPC 投影

| RPC 名 | 来源 | 说明 |
|---|---|---|
| `report.build` | 命令 report_build | actor=dashboard + operator 注入；返回追加 `content`（读回正文供 Modal 展示——壳层增强，域信封不变）|
| `report.list` | 查询 report_list | |
| `report.read` | 查询 report_read | |

v4 看板 `reports` case 的**文件名解析元数据逻辑整体废弃**（report-{program}-{date} 正则 + mtime 回退 + 首行标题嗅探）——由索引替代；`programs` 分组字段由索引 `program` 列直出。

### 1.8 外部调用示例

**模型调用**（worker/宿主会话工具）：

```json
{ "name": "report_build",
  "arguments": { "program_id": "meituan", "severity": "high,critical", "since_days": 30, "status": "confirmed" } }
```

**代码调用**（域内/跨域只读，经总线）：

```js
const bus = ctx.inject('secDomainBus')
await bus.dispatch('report', 'build', {
  programId: 'meituan', severity: 'high,critical', sinceDays: 30,
}, { actor: 'model', session_id: sess })
const list = await bus.query('report', 'list', { program: 'meituan', limit: 20 })
```

**脚本调用**（人工应急通道）：

```bash
sec domain call report build --actor human \
  --args '{"program_id":"meituan","severity":"high,critical"}'
```

---

## 二、内部实现（Internal）

### 2.1 数据模型

**目录与文件（owns）**：

```
data/reports/
  report-{program|all}-{YYYYMMDD-HHmm}[-N].md      # 漏洞报告（不可变产物）
  submissions/
    draft-finding-{id}-{YYYY-MM-DD}.md             # SRC 提交草稿
```

**frontmatter（权威元数据，写进每个新产物文件头）**：

```yaml
---
report_id: rpt_report_20260906-1430      # rpt_{kind}_{时间戳} / rpt_submission_draft_finding_{id}_{date}
kind: report                             # report | submission_draft
program: meituan                         # 空 = all
title: SilkSecAgent 漏洞报告
generated_at: 1789000000000              # UTC epoch ms（存储口径）
date: 2026-09-06                         # 北京日期（文件名口径，台账/报告文件名规则）
filters: { host_like: "", program_id: "meituan", since_days: 30, status: "confirmed", severity: "high,critical", source: "" }
counts: { total: 17, by_severity: { high: 3, medium: 9, low: 5 }, noise_filtered: 42 }
actor: model
session_id: sess_...
---
```

**索引表 `reports`（sqlite-local，asset-graph.db 内新表，owner=report 域，其他域禁写）**：

| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| report_id | TEXT UNIQUE NOT NULL | |
| kind | TEXT NOT NULL | report / submission_draft |
| file | TEXT UNIQUE NOT NULL | 相对 data/reports/ 路径 |
| program | TEXT | 空=all |
| title | TEXT | |
| generated_at | INTEGER NOT NULL | UTC ms |
| date | TEXT NOT NULL | 北京日期 YYYY-MM-DD |
| filters | TEXT | JSON |
| total | INTEGER | |
| by_severity | TEXT | JSON |
| noise_filtered | INTEGER | |
| actor | TEXT | |
| session_id | TEXT | |
| content_sha | TEXT | 产物 sha1（一致性校验用）|

索引：`(generated_at)`、`(program, generated_at)`、`(kind)`。

**索引 vs frontmatter 的取舍论证**：v4 的病是"从文件名倒推元数据"（program/date 靠正则、标题靠嗅探、severity/source 根本没有——筛选只能靠文件名）。候选有三：① 纯 frontmatter（列表要开文件头扫描）② 纯 sqlite（双写漂移风险——索引坏了就是 v4 同款病）③ **sqlite 索引 + frontmatter 权威**。采用 ③：**frontmatter 是唯一权威元数据源**（文件自描述、vault/Obsidian 同步链路可见、永远可重建索引）；**索引是可随时丢弃重建的加速层**（列表/筛选/分页 O(log n) 而非全目录扫描）。索引损坏的后果是"慢"（触发重建）而不是"错"——把 v4"元数据靠猜"的病根换成"缓存可重建"的结构保证。

### 2.2 状态机与不变量

**状态机**：产物无流转——`built`（生成）即终态。域内唯一"状态"是索引行的存在性，由 heal 逻辑维护（§2.5）。

**不变量清单（网关前置校验 + 后置断言）**：

| # | 不变量 | 失败错误码 |
|---|---|---|
| INV-R1 | 索引行存在 ⇒ 对应文件存在且 content_sha 一致（list/read 时惰性校验）| 读路径静默 heal；写路径 E_REPORT_INDEX_INCONSISTENT（内部）|
| INV-R2 | 新产物文件名符合 `report-…-{YYYYMMDD-HHmm}[-N].md` / `draft-finding-{id}-{YYYY-MM-DD}.md` 模式 | E_INTERNAL（不应出现）|
| INV-R3 | 新产物 frontmatter 必含 report_id/kind/program/generated_at/date/counts | 写前自检，缺失即 bug |
| INV-R4 | 报告数据源固定 noise=0 信号面（谓词在域内硬编码，不经参数）| — |
| INV-R5 | report_read 的 file 解析后必须在 data/reports/ 前缀内 | E_SCHEMA（hint："非法路径"）|
| INV-R6 | 提交草稿仅针对 status ∈ {confirmed, submitted} 的信号面 finding（v4 无此限制属纪律缺口，v5 收紧；由 02-vuln 域 INV-8 迁入本域）| E_INVARIANT（hint："提交草稿只针对已确认发现。先完成验证规程并 vuln_confirm 附证据"）|
| INV-R6 | report_draft_submission 目标必须是信号面 finding | E_REPORT_NOT_SIGNAL |

### 2.3 事务与联动

**写事务边界**（一个命令一个事务）：

1. 生成内容（纯内存渲染，读 vuln 查询在事务外——跨域读不进本域事务）；
2. 写文件：`tmp + rename` 原子落盘（file 后端纪律）；
3. BEGIN IMMEDIATE → INSERT reports 索引行 → COMMIT（busy_timeout 5s，超时 E_CONFLICT）；
4. 事务提交成功 → 发事件（report.built / report.draft.generated）；文件已写但索引失败 → 留下"无索引孤儿文件"，下次 list 时由 heal 回填（读 frontmatter 建行）——**文件先行的顺序保证任何时刻磁盘上都有完整产物，索引只是迟到**。

**联动**：无同步订阅者、无强联动。跨域读（vuln_list/vuln_stats/vuln_get）走 QueryGateway 同步调用，失败即命令失败（E_BACKEND_UNAVAILABLE，retryable）——报告宁可不生成也不生成残缺快照。

`program_exists` 是例外：scope 域不可达或返回异常时软校验放行，仅在 scope 正常返回列表时拒绝不存在项目。这是为了报告可用性保留的降级，但缺少 degraded 标记；生成结果目前无法区分“scope 校验通过”与“scope 校验未执行”。

### 2.4 后端适配器

repository 接口（JSDoc，方法名=原语）：

```js
listReportRows(where)        // 索引分页查询
insertReportRow(row)         // 索引插入（事务内）
deleteReportRow(reportId)    // heal 用
readReportFile(relPath)      // 受控读（前缀校验）
writeReportFileAtomic(relPath, content)  // tmp+rename
statReportFile(relPath)      // mtime/size/sha
```

**能力矩阵**：

| 命令/查询 | sqlite-local（默认）| file（纯文件）| http-remote |
|---|---|---|---|
| report_build | full | partial（索引退化为 frontmatter 扫描，list 性能降级声明）| unsupported（Phase 4 后评估：报告推送外部归档系统）|
| report_draft_submission | full | partial（同上）| unsupported |
| report_list | full（索引查询）| partial（全目录扫描 + 头部解析）| unsupported |
| report_read | full | full | unsupported |

### 2.5 缓存与失效

- **索引 = 缓存，frontmatter = 真相**：写命令同事务更新；list 时逐行校验 `content_sha`（开销：sha1 单文件 <1ms，≤500 行阈值内全量校验，超过抽样 10%）。
- **heal 规则**：索引有行无文件/不匹配 → 删行 + audit（kind=heal）；文件存在无索引行（人工放入/历史存量）→ 读 frontmatter 补行；frontmatter 缺失（v4 存量）→ 文件名正则 + mtime + 首行标题回退提取（复用 v4 reports case 的解析逻辑作为**迁移兜底**，不进主路径）。
- `report_index_rebuild`：human actor 的运维命令（CLI 直调，不进模型工具面）——全量扫描重建索引，幂等可重跑。
- report_read 无缓存（每次读盘，300KB 上限控制开销）。

### 2.6 性能与容量

| 项 | 现状/预期 |
|---|---|
| 存量报告 | 数十份量级（v4 reports case limit 200 即够用）|
| 增长预估 | 人工触发为主，≤ 数份/天；年千份级 |
| 索引查询 | 毫秒级（generated_at 索引）|
| report_build 数据源 | findings 全量 noise=0 行（当前数百级）；分页拉取 500/页 |
| 单报告上限 | 10,000 行（E_REPORT_SOURCE_OVERFLOW 防爆）|
| 文件大小 | 报告 <100KB；report_read 300KB 截断 |

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

| v4.x 位置 | 内容 | v5 去向 |
|---|---|---|
| `dsh-plugin-sec-suite.asset-db.js` L1592-1664 | `buildReport()`（SQL 拼装/分节/表格渲染/文件名）| `@silksec/sec-domain-report` `commands/report_build.js` 逻辑平移：SQL 段改为经 QueryGateway 调 vuln_list；分节/表格/文件名规则照抄；新增 frontmatter + 索引 + 分钟序号 |
| 同上 L1818-1865 | `submissionDraft()`（查重/七段模板）| `commands/draft_submission.js`：查重改 vuln_list 调用，模板照抄 |
| `dsh-plugin-sec-suite.asset-graph.js` L292-310 | `report_build` 工具注册（手写 schema）| ToolProjector 自动投影（schema 单一来源 = manifest）|
| 同上 L219-231 | `submission_draft` 工具注册 | 投影 + 别名（§3.2）|
| `dsh-plugin-sec-suite.dashboard-rpc.js` L239-249 | `reportBuild` case（读回 content）| RPC 投影 `report.build`；content 读回逻辑移入壳层 dispatch 封装 |
| 同上 L573-612 | `reports` case（文件名正则/mtime 回退/首行嗅探/分组）| **整体废弃** → `report.list` 查询；解析逻辑降级为 §2.5 heal 的存量兜底 |
| 同上 L613-621 | `reportRead` case（前缀校验/300KB 截断）| `report.read` 查询（校验规则照抄）|
| `dsh-plugin-sec-dashboard.client.js` ReportsView（L2142 起）| 按项目分组列表 + Modal 查看器 | 16-dashboard.md：`@silksec/sec-domain-report/dashboard-view.js` 域视图插件 |

### 3.2 兼容别名与观察期

| v4 旧名 | v5 新名 | 说明 |
|---|---|---|
| `report_build` | `report_build` | **同名**（本就是域前缀风格）；参数面不变，仅新增 frontmatter/索引行为 |
| `submission_draft` | `report_draft_submission` | 别名过网关全管线；工具描述加"已废弃，改用 report_draft_submission" |
| `vuln_draft_submission`（归档稿 02-vuln.md 曾列的 vuln 域动词）| `report_draft_submission` | **该动词从 vuln 域契约中删除**（§1.1 结论：vuln 域不 own 报告文件）；02-vuln.md 定稿时同步修正 |

**设计教训（写进评审记录）**：v4.6.1 的 report_build 漂移前科——工具 schema（asset-graph.js 手写）只暴露 host_like/program_id/since_days/status 四参数，而 buildReport 后端（asset-db.js）支持 severity/source，**模型传参静默失效、仅看板 RPC 可用**（2026-09-05 修复，v4.6.1）。v5 根治手段：schema 单一来源（manifest）→ ToolProjector/RpcProjector 双投影物理上消灭两份 schema；契约测试增加"工具参数面 ⊇ 后端参数面"断言。

别名删除走废弃三段式（deprecated 标记 → 7 天 audit 零使用 → 删除）；prompt 体系中 `submission_draft` 引用由脚本化改写（p14-1-tool-refs.py 模式）。

### 3.3 数据迁移脚本要点

`migrations/backfill-report-index.js`（system actor，启动迁移窗口执行）：

1. 扫描 `data/reports/` 全树 `.md`；
2. 对每文件：有 frontmatter → 直接建索引行；无（v4 存量）→ 文件名正则（`report-([a-z0-9_-]+)-(\d{8}-\d{4})`）提取 program/date，失败回退 mtime，标题读首行——**不改写存量文件**（frontmatter 只对新产物强制；`--backfill-frontmatter` 可选开关默认关，避免触碰 vault 同步链路）；
3. 幂等可重跑（ON CONFLICT report_id/file 跳过）；dry-run 模式 + silksec-backup VACUUM INTO 快照先行。

---

## 四、开放问题

1. **每日链自动报告**：O 类调度任务（如"每周一 09:00 生成各项目周报"）是否接入——涉及 `scheduler` actor 放开与报告模板参数化；当前设计禁 scheduler 出于"报告须人工审校"纪律，自动生成可考虑固定 `kind=report, auto=true` 标记分流。
2. **submissions 状态回流**：finding 经 vuln_submit 后，对应草稿是否自动标记"已提交"（索引行加 submitted 状态列？违背产物不可变原则的边界在哪）。
3. **报告模板可配置化**：当前模板硬编码在域内；是否抽出模板文件（类似 vulncards 的 file 后端形态）供人工调整。
4. **http-remote**：外部漏洞平台的报告附件上传（与 vuln 域 http-remote 试点同期评估）。
5. **报告归档**：产物不可变 + 无删除动词——一年后的清理策略（人工运维 or 归档谓词进 report_list）。

## 五、2026-09-12 深度审查结论

| 维度 | 结论 |
|---|---|
| 逻辑/功能 | 11/11 契约通过；报告索引 + frontmatter 权威 + 惰性 heal 语义成立。 |
| 功能缺口 | `program_exists` 在 scope 不可达时软放行且无 degraded 标记，无法区分校验通过与校验未执行。 |
| 性能 | report_build 分页拉全量 findings 后内存过滤，10,000 行硬上限；当前数百级可用，接近上限时需把过滤下沉到 vuln 查询。 |
| 静默错误 | vuln 数据源失败是 fail-closed；noise stats 失败降级为 0，报告仍生成。 |
| hook 判定 | 只读 vuln/scope，写本域文件/索引，无替代功能 hook。 |
| 独立升级 | 支持单域替换；须与 vuln、scope、dashboard 联测。 |
