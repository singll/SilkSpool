# 基于 DSH + pi 的 AI 网络安全辅助平台方案 v4（优化版）

> **合规声明**：本平台仅用于**授权范围内**的漏洞发现（SRC 众测 / HW 防守自查 / 自有资产安全评估）。所有目标经 `scope.yml` 白名单 fail-closed 硬校验，风险分级 + 人工断点 + 全量审计。本文档只做**能力、流程、数据与管理的架构设计**，不含任何具体攻击手法、漏洞利用或 exploit 代码。
>
> **v4 定位**：v3（[dsh-pi-secagent-plan.md](dsh-pi-secagent-plan.md)）记录了 P0–P5 的落地历程，引擎已真实跑通。v4 是**优化设计**，不推倒重来，聚焦三件事——
> 1. **【重点】资产收集 / 漏洞挖掘 / 自主学习** 三条主线的能力与流程升级；
> 2. **资产管理 / 漏洞管理 / 任务管理** 三大管理面从"缺失/薄弱"到"一等公民"（借鉴 CyberStrikeAI 源码级设计）；
> 3. **使用方便 + 开发方便**：把"声明未实现"的字段补齐，把管理能力界面化，把扩展成本降到"丢一个 YAML"。
>
> **优化依据**（本轮全部核实到源码级）：
> - **本地实况**：通读 `bundles/dsh/` 全部实现 + [安全审计报告](dsh-secagent-security-audit-2026-08-21.md)（区分"已落地"与"纸面声称"）；
> - **CyberStrikeAI**：遍历 `Ed1s0nZ/CyberStrikeAI` 源码（`internal/database/*.go` 建表、`skills/*/SKILL.md`、`agents/*`、`tools/*.yaml`），只借鉴设计、不照搬实现；
> - **DSH / pi 上游核实**：`deepseek-ai/deepseek-harness`（50 包，Cordis 架构）与 `earendil-works/pi`（10 包）均真实存在；关键结论：**DSH 的 `llm-pi-ai` 上游明示 "backed by `@earendil-works/pi-ai`"**——pi 已是 DSH 的 LLM 底座（重定位见 §1.3）。

---

## v4 变更摘要（相对 v3）

| # | 变更 | 动机 |
|---|---|---|
| 1 | 引入 **Program → Task → Run 三级脊柱** + 编排器（§二/§四） | v3 无"任务/项目"领域实体，三大管理无处落脚 |
| 2 | 黑板从 `key:value` 升级为**事实图谱**（category/body/confidence + 关系边，借鉴 CSAI） | 资产关系、攻击链、跨会话共享、token 经济一次到位 |
| 3 | 数据模型增维 `program_id/task_id` + 指纹表 + 接口鉴权建模 + 凭据表（§三） | 资产/漏洞可按项目治理，越权挖掘有图可遍历 |
| 4 | **落地已声明未实现的字段**：`parser`→结构化入 findings、`requires/produces`→能力凑链、`summarize`→分级摘要（§七/§八） | 最大杠杆的低垂果实，nuclei/afrog 结果终于进漏洞库 |
| 5 | finding 升级为**可交付报告模板** + 厂商响应/赏金跟踪 + 跨项目去重（§六） | 漏洞管理闭环到运营 |
| 6 | 自主学习补 **negative-ledger 内建 / 语义去重合并 / 活评测集 / 知识库 RAG rerank**（§九） | v3 环 1–4 有骨架缺血肉 |
| 7 | **pi 重定位**：不再自建 pi-bridge，pi-ai 已是 DSH LLM 底座；pi-agent-core/coding-agent 收敛为"可选离线 worker + 工程师工具作者"（§1.3） | 消除双轨维护，"DSH+pi"名实相符 |
| 8 | **诚实修正 §十**：合规护栏逐条标注 ✅已落地 / ⏳规划 / ❌未接，接入审计优先修复项（§十三） | 安全平台自身不能"文档强于代码" |

---

## 零、一句话诊断与优化主线

**诊断**：SilkSecAgent 已是一台**跑得动的引擎**（scope-guard fail-closed、token 压缩 1146x、692 资产/57 漏洞真实在库），但它是**无脊柱的**——所有工作散落在"一次会话 + 一张扁平黑板"里，无法回答"美团项目现在什么进度""这条漏洞属于哪个项目哪个任务""接下来该扫什么"。CyberStrikeAI 恰恰在这里最强：**一切以 Project 为作用域，四层编排把 run 变成可管理的 engagement**。

**优化主线**：给引擎装上**脊柱（Task 三级模型）**与**神经（事实图谱黑板）**，再把三条重点能力线（收集/挖掘/学习）接到脊柱上，最后把管理面界面化。一句话——**从"工具执行器"进化为"可管理、能自学的作战平台"**。

```
        ┌─────────────── 使用方便（Web UI 看板 / 一键起任务 / HITL 到手机）───────────────┐
        │                                                                                 │
   [ Program 项目 ]───┬── 资产管理（§五）── assets/endpoints/fingerprints/edges/creds       │
   （SRC/HW 作用域）   ├── 漏洞管理（§六）── findings(报告模板)/attack_chain/厂商响应/赏金    │
        │             └── 任务管理（§四）── tasks(队列/依赖/预算/HITL) ◀── 编排器调度        │
        ▼                                                                                 │
   [ Task 任务 ]──▶ 编排器派单 ──▶ Preset 角色（recon/vuln/biz/audit/intranet/review）      │
        │                                    │                                            │
        ▼                                    ▼                                            │
   [ Run 运行 ]  run_cli/spawn_worker/authz_diff/browser_*  ──▶ 全量落盘 results/<id>/     │
        │                                    │                                            │
        └── 证据 ──▶ 事实图谱黑板（§3.3）◀── 自主学习四环（§九）── 经验卡/playbook/评测/情报 ─┘
                     （凭据/存活/已试/攻击链，跨会话共享，只注入索引省 token）
```

---

## 一、现状诚实基线（优化的起点）

### 1.1 已跑通、v4 保留不动的

| 能力 | 落点 | 状态 |
|---|---|---|
| `sec-cli-adapter`（run_cli/grep_result/page_result） | [dsh-plugin-sec-suite.js](../bundles/dsh/templates/dsh-plugin-sec-suite.js) | ✅ manifest 驱动、全量落盘 + ≤20 行摘要，压缩比实测 1146x |
| `scope-guard` fail-closed 白名单 + 风险四级 + `audit.jsonl` | 同上 `:212 checkTarget` | ✅ 字面主机/CIDR/后缀匹配，默认拒绝 |
| `asset-graph`（assets/endpoints/findings/blackboard 四表 + WAL） | [asset-db.js](../bundles/dsh/templates/dsh-plugin-sec-suite.asset-db.js) | ✅ 692/279/57/969 真实数据 |
| `experience-hub`（经验卡/知识库/playbook + FTS5 + 向量嵌入） | [experience.js](../bundles/dsh/templates/dsh-plugin-sec-suite.experience.js) | ✅ 语义检索已接 multilingual-e5-small |
| `spawn_worker`（DSH headless 子进程，≤4 并发，只回尾部） | js `:634` | ✅ 批任务上下文隔离 |
| `authz_diff`（双会话重放 + 响应 diff） | js `:519` | ✅ suspected 自动入 finding |
| finding 状态机 + `report_build` | asset-db `:164` | ✅ new→confirmed→submitted→accepted/dup/ignored |
| 代理池(mubeng:8899) / dsh-bill / auth-gate / model-failover / dsh-browser(fork) | plugins.lock | ✅ 已装并验证 |
| Vulhub 靶场 + `eval-run.js` 回归 / intel-refresh timer | eval/intel | ✅ 首轮 nuclei 3/6 + afrog 补位 |

### 1.2 v3 "声称却未落地" —— v4 的低垂果实

> 这些不是缺轮子，是**轮子造好了没装上车**。优化 ROI 极高。

| v3 声称 | 代码实况 | v4 处理 |
|---|---|---|
| manifest `parser`（jsonl/json/csv）结构化 | ❌ 只 regex 抽 URL/host（`ingestText`） | §七实现 parser 注册表 |
| **nuclei/afrog 结果入 findings 表** | ❌ 只有 xray-webhook / authz_diff 写 finding，**主扫描引擎结果不进漏洞库** | §八修复（最大缺口） |
| manifest `requires/produces` 能力原语凑链 | ❌ 字段写了 `runCli` 完全没读 | §七实现 `plan_chain` |
| `summarize: head_llm` 分级摘要 | ❌ 永远 head-20 行 | §七分级摘要 + §九自优化 |
| pi-bridge 融合层（v3 §5.2） | ❌ 明确没做，走 DSH headless | §1.3 重定位（不再需要） |
| egress-guard / taintguard / negative-ledger / chicheng-push | ❌ plugins.lock 中 PENDING/未装 | §九内建 negative-ledger；§十三接 egress/taint |
| §十"代码层硬约束"10 条 | ❌ 审计确认 4 条未落地 | §十三逐条标真实状态 |

### 1.3 DSH / pi 上游核实结论 —— **重定位 pi**

- **DSH 真实**：`deepseek-ai/deepseek-harness`，50 包，Cordis（Koishi 元框架）架构，"连 agent loop 都是插件"。**关键**：`goal/plan/todo` 经核实是**会话内自编排构件**（goal=挂在 session 上的单一完成目标状态机，todo=会话内易失待办板），**不是**带独立生命周期与跨会话查询的领域实体。→ **engagement/task/vuln 这类领域实体必须自建持久层**（挂 `ctx.<key>` 的 Cordis service + 我们的 SQLite），这正是 v4 §三的做法，也符合 v3 §七"数据外置"原则。
- **可直接复用的 DSH 底座**：`ctx.jobs`（后台作业）、`ctx.workflowEngine`（JS 脚本编排 agent/pipeline/parallel）、`ctx.subagents`（subagent seam，第三方注册 transport provider）、`ctx.sessionQuery`（FTS 检索 trajectory）、`ctx.approval`（审批 seam，无 answerer 时 fail-closed）、`ctx.storage/credentials/spillStore/compaction`、`dsh-tool-cordis`（运行时自挂载插件=§5.4 自优化通道）。
- **pi 真实且已是 DSH 的一部分**：`earendil-works/pi`，10 包。**`@deepseek-ai/dsh` 的 `llm-pi-ai` 包上游明示 "backed by `@earendil-works/pi-ai`"** —— **pi-ai 就是 DSH 的多供应商 LLM 路由底座**。所以"DSH + pi"在 LLM 层是上游既成事实，我们**无需也不应**再自建 pi-bridge。
  - **pi 在 v4 的干净角色**（消除 v3 的双轨/倒挂顾虑）：
    1. **pi-ai** = DSH LLM 底座（上游已接，我们只在 `settings.yaml` 声明 provider routes）；
    2. **pi-coding-agent** = **工程师本机工具**（写/调 manifest、Preset、Skill 的终端 agent，人的入口，不进服务器运行时）；
    3. **pi-agent-core** = **可选的离线/多机 worker 运行时**（未来资源紧张要把 worker 迁到另一台机时，用它编译独立二进制；当前 spawn_worker 走 DSH headless 已够，**暂不启用**）。
  - 结论：**主体 DSH 不变，pi 从"要融合的第二框架"降为"上游已内建的 LLM 底座 + 两个可选工具"**。文档标题保留"DSH + pi"是名实相符的。

---

## 二、优化主脑：Program → Task → Run 三级脊柱（借鉴 CSAI 四层编排）

### 2.1 为什么"无脊柱"撑不起三大管理

CSAI 源码里 `assets / vulnerabilities / project_facts / batch_task_queues` **全部带 `project_id` 外键**，项目是黑板/资产/漏洞的共享作用域，会话绑定项目后 Agent 查询被**强制限制在项目内**。我们的 asset-graph.db **完全没有项目维度**，于是：
- 资产/漏洞混在一起，无法按 SRC 项目治理、无法算项目风险；
- 没有"任务"实体，无法排队/编排/追踪进度/控预算；
- `report_build` 只能按 `host_like` 过滤，出不了"项目级报告"。

### 2.2 四层编排模型（CSAI 借鉴 → DSH 落点）

| 层 | CSAI 载体 | v4 载体 | 职责 |
|---|---|---|---|
| **Program 项目** | `projects` 表（scope_json/status/pinned） | 新增 `programs` 表（真相源仍是 `scope.yml`，此表是运行态镜像 + 统计锚点） | 顶层作用域，一切归属；风险聚合 |
| **Task 任务** | `batch_task_queues` + `batch_tasks`（FIFO+cron+并发） | 新增 `tasks` 表（+ 队列/优先级/依赖/预算/HITL 阻塞） | 可管理的工作单元，编排器的调度对象 |
| **Run 运行** | `conversations` 表 | 现有 `results/<run_id>/` + DSH session | 一次工具执行/一段会话，向上关联 task |
| **Plan-Task DAG** | Eino plantask（blocks/blockedBy，磁盘 JSON） | **复用 DSH `todo`**（会话内待办板，天然易失） | Agent 单次会话内的自编排，不持久化 |

> **决策**：跨会话的 engagement/task **自建**（`tasks` 表，§3.1）；会话内的步骤 TODO **复用 DSH `todo`**（不自建，省事）。两者分工对齐 CSAI 的"batch_task（持久）vs plantask（会话内）"边界。

### 2.3 编排器与角色调度（借鉴 CSAI 三模式 + 交接包纪律）

CSAI 的多角色调度**不是 13 个角色互相喊话**，而是 **orchestrator 主代理**用三种模式派单：
- **Deep**：主代理用 `task` 工具把子目标委派给专项子代理，**子代理禁止再调 `task`**（防嵌套污染）；
- **Plan-Execute**：Planner → Executor → Replanner 闭环；
- **Supervisor**：`transfer` 做专家路由。

**v4 编排器**（`orchestrator` 新 Preset + 一个调度 worker）：

```
编排器（DSH 主会话，Deep 模式）
  1. task_next(program)         ← 从任务队列拉最高优先级 queued 任务
  2. 按 task.phase 选 Preset     ← recon→侦察 / vuln→挖掘 / biz-logic→越权 / ...
  3. spawn_worker(交接包)        ← 复用 DSH subagent seam；worker 只看交接包，看不到父上下文
  4. worker 跑确定性流水线 → 证据入事实图谱 → task_update(status)
  5. 完成后按产出自动 enqueue 后继任务（recon 完成 → 每个 live host 簇 enqueue 一个 vuln 任务）
  6. intrusive/提交类任务 → task_update(status=blocked) + 推手机审批（HITL）
```

**交接包纪律（CSAI 强设计点，直接照搬）**：每次派 worker，`task` 描述必须自带"已完成什么 / 本轮只做什么 / 目标标识+范围+成功标准 / 产出格式"，派单前做**目标完整性校验**，任一必填缺失**禁止委派**——这是 v3 "worker 是黑盒"批评的正解。

---

## 三、数据模型 v2（三大管理的地基）

> 全部落在现有 `asset-graph.db`（node:sqlite + WAL），在 [asset-db.js](../bundles/dsh/templates/dsh-plugin-sec-suite.asset-db.js) 的 `getDb()` 建表段追加。**平滑迁移**见 §3.6。

### 3.1 新增 programs / tasks 表

```sql
-- 项目（真相源=scope.yml；此表为运行态镜像+统计锚点，setup 时从 scope.yml 同步）
CREATE TABLE IF NOT EXISTS programs (
  id          TEXT PRIMARY KEY,        -- = scope.yml program.name
  platform    TEXT,                    -- 众测平台（字节/美团/HackerOne...）
  status      TEXT NOT NULL DEFAULT 'active',   -- active/paused/closed
  max_risk    TEXT,                    -- 镜像 scope.yml rules.max_risk
  fixed_egress_ip INTEGER DEFAULT 0,
  created_at  INTEGER, updated_at INTEGER
);

-- 任务（缺失的脊柱）
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id   TEXT NOT NULL,
  parent_id    INTEGER,                -- 依赖/子任务（DAG）
  phase        TEXT,                   -- recon/vuln/biz-logic/code-audit/intranet/review
  objective    TEXT NOT NULL,          -- 一句话目标
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued/running/blocked/done/failed/cancelled
  priority     INTEGER NOT NULL DEFAULT 5,       -- 0 最高（v4 补 CSAI 缺失的优先级）
  assignee     TEXT,                   -- preset 角色 / worker / human
  budget_tokens  INTEGER,              -- token 预算上限（超限降级）
  spent_tokens   INTEGER DEFAULT 0,    -- 关联 dsh-bill 归因
  session_id   TEXT,                   -- 关联 DSH 会话（trajectory 回放）
  blocked_reason TEXT,                 -- HITL 阻塞原因
  result       TEXT,                   -- 收尾摘要
  created_at   INTEGER, updated_at INTEGER, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(program_id, status, priority);
```

### 3.2 现有表增维（program_id / task_id）

```sql
ALTER TABLE assets    ADD COLUMN program_id TEXT;
ALTER TABLE endpoints ADD COLUMN program_id TEXT;
ALTER TABLE findings  ADD COLUMN program_id TEXT;
ALTER TABLE findings  ADD COLUMN task_id    INTEGER;
```

> 所有写入路径（`upsertAsset/upsertEndpoint/addFinding/ingestText`）增加可选 `program_id`；`run_cli` 执行时从 `scope-guard` 命中的 `program.name` **自动回填**（`checkTarget` 已返回 `program`，只需透传）——**零人工成本给数据打上项目归属**。

### 3.3 黑板升级为**事实图谱**（借鉴 CSAI，一石多鸟）

现有 `blackboard(key,value)` 太扁。升级为 CSAI 式**事实图谱 + 关系边**——它同时是**资产关系层、攻击链层、跨会话共享层、token 经济层**：

```sql
CREATE TABLE IF NOT EXISTS facts (
  program_id  TEXT NOT NULL,
  fact_key    TEXT NOT NULL,           -- 格式 category/slug，如 auth/cred-admin
  category    TEXT,                    -- auth/target/note/finding/chain/exploit/asset
  summary     TEXT,                    -- 一行索引（注入 prompt）
  body        TEXT,                    -- 完整可复现上下文（按需 get，不注入）
  confidence  TEXT DEFAULT 'tentative',-- confirmed/tentative/deprecated
  pinned      INTEGER DEFAULT 0,
  related_finding_id INTEGER,
  source      TEXT, updated_at INTEGER,
  PRIMARY KEY (program_id, fact_key)   -- 同 key 覆盖更新（upsert 语义）
);
CREATE TABLE IF NOT EXISTS fact_edges (
  program_id  TEXT NOT NULL,
  src_key     TEXT NOT NULL, dst_key TEXT NOT NULL,
  edge_type   TEXT NOT NULL,           -- resolves_to/hosts/exposes/depends_on/leads_to/enables/exploits
  confidence  TEXT,
  PRIMARY KEY (program_id, src_key, dst_key, edge_type)
);
```

**关键机制（照搬 CSAI，token + 防幻觉双赢）**：
- **只把索引注入 system prompt**（fact_key + summary + 关系边 + 攻击路径概览，带预算），**body 按需 `fact_get(key)` 拉取**——摘要不够禁止臆造；
- **边渗透边记录**：每确认一条认知立即 upsert，不等会话结束（防上下文压缩丢细节）；
- **约定落点**：凭据→`auth/*`、存活/目标→`target/*`、已试死路→`note/*`（负结果）、发现→`finding/*`/`chain/*`。

> 现有 `blackboard_set/get` 保留为**兼容薄封装**（写入 `facts` 的 `note/` 分类），新增 `fact_upsert / fact_get / fact_search / fact_link / fact_graph`（见 §五/§九）。

### 3.4 指纹表 / 凭据表 / 接口鉴权建模

```sql
-- 指纹/技术栈（component-vuln-intel 的可搜索地基，v3 只塞在 attrs JSON 里搜不了）
CREATE TABLE IF NOT EXISTS fingerprints (
  program_id TEXT, host TEXT, tech TEXT, version TEXT, source TEXT, last_seen INTEGER,
  PRIMARY KEY (host, tech)
);
-- 凭据（只存引用，绝不存明文；对齐 credentials 包/env）
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT, host TEXT,
  cred_type TEXT, ref TEXT,             -- ref 指向 ctx.credentials / env 变量名
  role TEXT, note TEXT, created_at INTEGER
);
-- 接口鉴权建模（越权挖掘刚需，v3 §四声称却没建）
ALTER TABLE endpoints ADD COLUMN params        TEXT;   -- JSON 参数清单
ALTER TABLE endpoints ADD COLUMN auth_required TEXT;   -- yes/no/unknown
ALTER TABLE endpoints ADD COLUMN roles_seen    TEXT;   -- JSON: 哪些角色访问过（越权矩阵）
```

### 3.5 findings 升级为**可交付报告模板**（借鉴 CSAI vulnerabilities 表）

CSAI 的 `vulnerabilities` 字段本身就是一份报告模板。我们的 findings 太薄，补齐：

```sql
ALTER TABLE findings ADD COLUMN vuln_type          TEXT;   -- IDOR/SQLi/XSS/RCE/未授权...
ALTER TABLE findings ADD COLUMN cwe                TEXT;
ALTER TABLE findings ADD COLUMN endpoint_ref       TEXT;   -- 关联接口（host+method+path）
ALTER TABLE findings ADD COLUMN preconditions      TEXT;   -- 前提
ALTER TABLE findings ADD COLUMN reproduction_steps TEXT;   -- 复现步骤
ALTER TABLE findings ADD COLUMN impact             TEXT;
ALTER TABLE findings ADD COLUMN recommendation     TEXT;
ALTER TABLE findings ADD COLUMN submitted_at       INTEGER;
ALTER TABLE findings ADD COLUMN vendor_status      TEXT;   -- triaged/accepted/duplicate/na/resolved
ALTER TABLE findings ADD COLUMN bounty             REAL;   -- 赏金记账
```

### 3.6 平滑迁移（不破坏现有 692 资产 / 57 漏洞）

- 全部用 `ALTER TABLE ADD COLUMN`（可空），存量行取 NULL，不重建表；
- 一次性 `backfill-program.js`：遍历存量 assets/findings，用 `scope-guard` 的 `checkTarget(host)` 反查 `program`，回填 `program_id`（命中不了的归入 `program_id='_legacy'`）；
- 建表语句幂等（`IF NOT EXISTS`），随 `sec-suite-plugin-setup.sh` 走，re-setup 安全。

---

## 四、任务管理（TASK — 全新）

### 4.1 任务生命周期状态机

```
        ┌──────────── 编排器 task_next 认领 ────────────┐
 queued ──▶ running ──▶ done                            │
   │           │                                        │
   │           ├──▶ blocked ──(HITL 审批通过)──▶ running │
   │           └──▶ failed ──(重排/换路)──────────────────┘
   └──▶ cancelled
```

- `blocked`：intrusive 操作 / 越权支付类请求 / 疑似 0day POC / **提交 SRC 前**（写死人工）→ 推手机审批（`ctx.approval` + chicheng-push）；
- `failed`：worker 异常或验证不通过 → 编排器可换路（对齐 CSAI"拒绝→换路"触发器）或降级排队人工。

### 4.2 队列 / 优先级 / 依赖 / 预算

- **优先级**（v4 补 CSAI 缺失）：`priority` 0 最高；情报驱动的高价值任务（新上 SRC 项目、指纹命中 N-day）自动置顶（§九环4）；
- **依赖**：`parent_id` 构 DAG，`task_next` 只返回无未完成父任务的 `queued`；
- **预算**：`budget_tokens` 硬上限，`spent_tokens` 关联 dsh-bill 归因，超限 `task_update(status=blocked, reason=budget)`——落地 v3 §5.1"预算硬上限"承诺；
- **并发**：编排器同时在跑的 worker ≤4（复用 spawn_worker 上限），队列 FIFO + 优先级。

### 4.3 任务工具集（新增，挂 agent 面）

```
task_create(program, phase, objective, priority?, budget_tokens?, parent_id?) → {id}
task_update(id, status, note?, blocked_reason?)          # 追加进 result 证据链
task_list(program?, status?, phase?)                      # 看板数据源
task_next(program)                                        # 编排器认领：最高优先级可执行 queued
task_stats(program)                                       # 进度总览（各 phase/status 计数 + 预算消耗）
```

> **复用 vs 自建的边界**：任务的**持久化/查询/编排**用 `tasks` 表（自建，跨会话）；任务在**单次会话内的步骤拆解**用 DSH `todo`（复用，易失）；任务的**后台执行**挂 `ctx.jobs`（复用，进度/取消/超时 UI 可见）；任务的**周期触发**用 DSH `schedule`（会话内）+ `silksec-intel.timer`（系统级，补 schedule 的 session-local 短板）。

---

## 五、资产管理（ASSET — 增强）

### 5.1 服务级去重 + 动态风险（借鉴 CSAI）

- **去重键升级**：CSAI 用 `dedup_key = target|port|protocol`（`target = domain ?? ip ?? lower(host)`）——**服务级**去重（同主机 `80/http` 与 `443/https` 是两个资产）。我们现有 PK 是 `(host,type)`，粒度偏粗；v4 在 `attrs` 落 `port/protocol` 并以三元组去重（`httpx -json` 的 parser 直接产出，见 §七）。
- **动态风险**：新增派生字段 `risk_score = MAX(该资产未关闭 finding 的 severity 权重)`（critical=5…info=1），`risk_level` 映射；从未扫描 = `unassessed`。由 `finding_add/update` 触发重算——**攻击面治理的成熟做法**。

### 5.2 关系边 + 接口鉴权建模（越权刚需）

- 关系边用 §3.3 的 `fact_edges`（`domain --resolves_to--> ip --hosts--> web --exposes--> endpoint`），资产图谱可**遍历**而非扁平列表；
- 接口按 §3.4 建模 `params / auth_required / roles_seen`——**越权挖掘的本质是对接口图谱按角色矩阵穷举遍历**，没这层建模 AI 无从下手（§八用它系统化跑 authz_diff）。

### 5.3 资产工具增强

```
asset_query(program?, host_like?, type?, risk_level?, never_scanned?)   # 补 program/风险/盲区过滤
asset_graph(host)         # 返回该资产的关系子图（借 fact_edges 遍历）— 新增
fp_add / fp_query(host?, tech?, version?)                                # 指纹表 — 新增
cred_add / cred_query(program, host?)   # 只存引用 — 新增
endpoint_add 增 params/auth_required/roles_seen 字段
```

### 5.4 覆盖盲区仪表盘（使用方便，借鉴 CSAI UX）

Web UI 资产视图：7/30/90 天新增/停用趋势、漏洞发现趋势、**扫描覆盖率**、**从未扫描/>30 天未扫描**筛选器（按 `last_seen` 升序把盲区顶到最前）、协议 Top8。→ 让"还有哪些资产没测"一眼可见。

---

## 六、漏洞管理（VULN — 增强）

### 6.1 报告模板 + 跨项目/跨时间去重

- finding 按 §3.5 补全报告模板字段，`report_build` 支持**按 program/task 出项目级报告**（不再只 host_like）；
- **去重升级**：现有指纹 `sha1(host|title|url)` 对 title 措辞敏感。v4 叠加**跨项目历史指纹库**（`vuln_type + host + endpoint_ref` 归一化哈希）+ **提交前与历史 accepted/dup 比对**（落地 v3 §5.7"防 dup 提交"）；语义近似的候选走人工确认。

### 6.2 攻击链图谱 + 提升为项目事实（借鉴 CSAI）

- 会话级攻击链用 `fact_edges` 的 `leads_to/enables/exploits` 边记录（node=fact，edge=能力跃迁）；
- 复盘时把成立的攻击链**提升为项目级 confirmed 事实**（CSAI `promote_project` 思路），支持跨会话复用与"逐步回放"。

### 6.3 状态流转 + 厂商响应 + 告警

- 状态机沿用 new→confirmed→submitted→accepted/dup/ignored，叠加 `vendor_status`（triaged/accepted/duplicate/na/resolved）+ `bounty`；
- **告警订阅**（借鉴 CSAI）：`min_severity` 阈值订阅 → 新 critical/high finding 经 chicheng-push 推手机；
- **月度 ROI 报表**：`漏洞数 / token 成本 / 赏金`（dsh-bill 数据 × findings），落地 v3 §P5 运营指标。

---

## 七、【重点 A】资产收集：能力与流程优化

### 7.1 落地 parser 注册表 —— 结构化入图谱（低垂果实）

现状 `ingestText` 只 regex 抽 URL/host，`httpx -json`/`nuclei -jsonl` 的结构化信息全丢。v4 建**parser 注册表**（`parsers/` 目录，函数按 manifest `parser` 字段路由）：

```
parser: jsonl_httpx   → 抽 host/port/protocol/title/webserver/tech → assets(服务级去重) + fingerprints
parser: jsonl_nuclei  → 抽 template-id/severity/matched-at/info → findings（见 §八）
parser: lines_subfinder → 子域 → assets(domain)
parser: csv_ffuf      → 命中路径 → endpoints
parser: excel_enscan  → ICP/APP/邮箱/子公司 → assets + facts(target/*)
```

> **开发方便**：新增一种结构化工具 = 写一个 `parse(text) → {assets,endpoints,findings,fingerprints}` 函数 + manifest 填 `parser: xxx`，**零改动 runCli 主流程**。

### 7.2 落地 capability-primitive-search —— 自动凑链（数据已在）

manifest 里 `requires/produces` 字段**早就写好了**（`subfinder: requires[domains] produces[subdomains]`…），只差算法。借鉴 CSAI STRIPS 式**前提-产出图搜索**，分两层落地：

- **机械凑链（code 版，新增 `plan_chain` 工具）**：把 manifest 的 `produces→requires` 建成图，`plan_chain(have:[company_name], want:findings)` 做 BFS 返回有序工具链：`enscan→subfinder→dnsx→httpx→nuclei`。侦察阶段 Agent 不用手工记工具顺序。
- **创造性凑链（Skill 版，借鉴 CSAI capability-primitive-search）**：低危组合利用（info 泄露→源码→凭据→执行点）留给 Agent 按能力原语等式推理，产出**只记 tentative**，验证后才 confirmed（对齐验证铁律）。

### 7.3 补齐资产收集工具链（引入其他工具）

v3 §4.1 规划 ~60 工具，实际只装 26。v4 按**出洞 ROI**补齐关键缺口：

| 补装工具 | 通道 | 为什么必须 |
|---|---|---|
| **ENScanGo** | bin | **侦察入口**：企业股权穿透→ICP/APP/公众号/邮箱/子公司，整条 recon 链的源头 |
| **LinkFinder / JSFinder** | pip/脚本 | JS 端点/密钥/隐藏接口——SRC 出洞富矿，接 §3.4 接口图谱 |
| **EHole** | bin | 国产指纹（OA/若依/致远等），补 observer_ward，喂 §3.4 指纹表 |
| OneForAll / ksubdomain | pip/go | 泛解析场景子域爆破补强 |
| alterx | go | 子域置换扩面（PD 全家桶补齐） |
| fofa/quake/hunter API 封装 | 自研脚本 | 测绘查询（key 存 credentials 包） |
| jadx / unveilr | bin | APK 反编译 / 小程序解包（ENScanGo 产出的 APP 资产收口） |

### 7.4 一键侦察流水线（使用方便）

`task_create(program, phase=recon, objective="XX集团资产收集")` → 编排器 `plan_chain` 自动凑链 → spawn_worker 跑 `enscan→subfinder→dnsx→httpx→EHole→katana→LinkFinder` → parser 全程结构化入图谱 → 回摘要"新增 N 子域/M 存活/K 接口/指纹分布"。**一条命令，公司名进，资产图谱出。**

---

## 八、【重点 B】漏洞挖掘：能力与流程优化

### 8.1 parser → findings：修复最大漏斗缺口

**当前 nuclei/afrog 结果不进 findings 表**（只有 xray-webhook/authz_diff 写）。这是 v4 最高优先修复：

```
run_cli(nuclei) → parser:jsonl_nuclei → 每条命中 addFinding({
  title: info.name, severity: info.severity, vuln_type: 分类,
  host, url: matched-at, evidence: "run_id:rXXXX template:CVE-XXXX",
  program_id: 自动回填, task_id: 当前任务, status:'new'
}) → 自动去重（§6.1）
```

从此**主扫描引擎的每条命中都结构化进漏洞库**，漏洞管理才有源头活水。

### 8.2 三级漏斗落地（v3 声称的确定性规则层）

v3 §5.1 说"三级过滤挡掉 60%+"，代码里没有。v4 在 parser→findings 之间插**确定性规则层**（零 token）：
- nuclei 模板 `info.severity` + 自带置信度、响应特征（长度/状态/关键字）→ 明显误报（如 info 级模板匹配、蜜罐特征）**直接标 `false_positive` 不进模型**；
- 存疑的 → 小模型（pool-chat-free）复核 → 高危/需判定的 → 大模型。规则层目标挡掉 60%+，指标入 dsh-bill 验证。

### 8.3 component-vuln-intel：指纹 → N-day → 验证任务（借鉴 CSAI 触发器）

指纹表（§3.4）就位后，闭环触发器：
```
fp_add 事件（识别出 若依/Spring/Weblogic + 版本）
  → intel-feeder 查 nuclei 模板库 + CVE/POC（对齐 CSAI 7 步搜洞，结果 tentative）
  → 命中 → task_create(phase=vuln, objective="验证 {tech}@{version} 的 {CVE}", priority=1)
  → 编排器高优派单 → 验证附证据才 confirmed
```
落地 v3 §5.3 环4"组件识别触发搜洞"，且**结果强制 tentative**（防把搜索结果当漏洞，见 §8.5）。

### 8.4 越权系统化（接口图谱遍历 + 角色矩阵）

现有 `authz_diff` 是单发。v4 系统化：
```
biz-logic 任务 → endpoint_query(program, auth_required=yes) 拉全部鉴权接口
  → 对每个接口 × 角色矩阵（未登录/普通/管理员）批量 authz_diff（spawn_worker）
  → suspected 入 finding + roles_seen 更新 → 逐条 HITL 放行后人工核实数据归属
```
把"越权=接口图谱按角色穷举"变成可批量执行的确定性流水线。

### 8.5 验证铁律 + 3 触发器 + 负结果落库（借鉴 CSAI，防幻觉硬约束）

CSAI 的"全系统最高规则"直接沉淀为常驻 Skill：
1. **搜索结果 ≠ 漏洞**：情报/PoC 线索只能 tentative，禁止直接 confirmed；
2. **confirmed 必挂证据**：命令输出/HTTP 响应/回连记录（我们已有 evidence 必填，强化到 body）；
3. **禁模糊措辞**：要么确认+证据，要么 tentative，要么不报；
4. **验证失败 → 写负结果事实**（`note/*`，§九 negative-ledger），防重复尝试；
5. **3 触发器**：识别组件→立即搜洞（§8.3）/ 遇 WAF/403→换路不硬刚 / 拿到凭据→立即横向复用。

### 8.6 被动流量总线增强

现状是 xray webhook（:7788）单点。v4 保持 xray 被动审计主力，补：浏览器/人工流量经 fork 的 `@silksec/dsh-browser`（SEC_FLOW_PROXY）入总线 → 接口自动入 §3.4 图谱（含鉴权头）→ 人工浏览序列可蒸馏 `human-verified` 经验卡（§九最高权重）。

---

## 九、【重点 C】自主学习：能力与流程优化

### 9.1 四环闭环强化（以事实图谱为神经中枢）

| 环 | v3 现状 | v4 强化 |
|---|---|---|
| **环1 沉淀** | exp_store 需证据 ✅，但无负知识 | 内建 **negative-ledger**（§9.2）+ 事实图谱边渗透边记录 |
| **环2 增强** | exp_search FTS5+向量 ✅ | 开局同时检索经验卡 + **项目事实图谱索引**注入 Preset |
| **环3 进化** | pb_rank + eval-run.js ✅ 但评测窄 | **活评测集**（§9.4）+ 按模型档位出指标 |
| **环4 情报** | intel-refresh timer ✅ 但无指纹触发 | §8.3 指纹→N-day→高优任务 + SRC 项目动态源 |

### 9.2 negative-ledger 内建（不装社区插件）

社区 `dsh-negative-ledger` 未装。v4 **直接用事实图谱实现**（更省，零供应链风险）：验证失败/前提不满足 → `fact_upsert(note/failed-xxx, confidence=confirmed)`；`plan_chain`/编排器派单前查 `note/*` 负结果，**命中则警告拦截重复尝试**。

### 9.3 经验卡语义去重合并

现状 `exp_cards.scenario` 是 `UNIQUE` 精确串，措辞不同即重复。v4 用已接入的向量嵌入：入库前算 `scenario` embedding，与存量卡余弦相似度 > 阈值（0.85）→ **合并+证据追加**而非新建，对齐 v3 §5.3"去重合并"承诺。

### 9.4 活评测集（feedback → eval case）

v3 说"实战判定回流成为评测用例"，未接。v4：`finding_update(status=confirmed/false_positive)` 时（Web UI 一键打标，`ctx.feedback`）→ **自动追加到 `eval-cases.list`**（目标+期望命中/期望不命中签名）→ eval-run.js 回归时纳入。真评测集自动生长，不再只靠 Vulhub 6 靶标。

### 9.5 摘要策略 / 技能自优化（受控自进化）

- **摘要自优化**：review 角色统计各工具"摘要后还需 grep 原文"比率，高比率工具**建议**改 manifest `summarize` 字段（人确认后生效）；
- **技能草稿自进化**：复盘通用教训 → Agent 起草 Skill 补丁存 `skills/draft/` → Web UI 一键采纳才进正式（**自动进化、人工把关**）；
- **安全网**：Preset/Skill/manifest 变更进**影子 git 仓库**（路径在 data 目录外，防被跟踪），一键回滚。

### 9.6 知识库 RAG 升级（借鉴 CSAI 管道）

现有 kb 是 FTS5+LIKE。借鉴 CSAI RAG 管道升级：`markdown_then_recursive` 分块（512/50）→ 向量嵌入（已有 e5-small）→ **MultiQuery 改写（≤4）→ 向量检索 → Rerank 去重限长 → 注入**。外部知识与实战经验卡**分区存储、检索标来源**（幻觉隔离，v3 纪律保留）。

---

## 十、使用方便（人机工效）

| 能力 | 落地 |
|---|---|
| **三视图看板** | Web UI 加 task / asset / finding 三个列表视图（数据源=task_list/asset_query/finding_query），进度/风险/盲区一眼可见 |
| **一键起任务** | `task_create` + 编排器自动凑链，"对 X 项目做资产收集/漏洞挖掘"一句话启动 |
| **HITL 到手机** | `ctx.approval` + chicheng-push：intrusive/提交类阻塞推手机，人不在电脑前也能过门 |
| **一键报告** | `report_build(program)` 出项目级 markdown，提交前强制人工审 |
| **判定零摩擦打标** | 每个 finding 旁"确认/误报/风险接受"一键（`ctx.feedback`）= 一条评测用例 + 一条负样本 |

## 十一、开发方便（工程工效）

| 维度 | 做法 |
|---|---|
| **加工具 = 丢 YAML** | manifest 放 `tools.d/`，tools-manager 装二进制，**零代码**（现已如此，保持） |
| **加结构化解析 = 写一个 parse 函数** | parser 注册表（§7.1），manifest 填 `parser:` 字段路由 |
| **加角色 = 一个 mkpreset** | [seed-presets.sh](../bundles/dsh/templates/seed-presets.sh) 幂等函数 |
| **加纪律 = 一个 Skill md** | 用户级技能目录热加载，草稿走 `skills/draft/` |
| **插件模块化** | 800 行的 sec-suite 按域拆（cli-adapter / asset-graph / experience / task / parsers），降认知负荷 |
| **shim 隔离升级** | 自研插件对 Cordis API 收敛到 `@sec/dsh-shim`，DSH 大版本只改 shim（v3 §七保留） |

## 十二、引入的其他工具（v4 增补清单）

- **资产收集**：ENScanGo（侦察入口）、LinkFinder/JSFinder（JS 端点）、EHole（国产指纹）、OneForAll/ksubdomain/alterx、fofa/quake/hunter API、jadx/unveilr；
- **漏洞挖掘**：按需补 dalfox 已装外的 SSTImap/commix/crlfuzz（指纹触发）；
- **平台底座**：`dsh-rate-limiter`（token bucket 防 429，上游已确认存在）、`dsh-context`（/context 面板，观测上下文占用）；
- **合规必接（审计要求，§十三）**：egress-guard（出口白名单）、taintguard（污点追踪）、output-retention（保留期）——rc.7 已有底座，装上即可。

> 引入纪律不变（v3 §6.2）：先扫后装 + pin + hash 进 git；答不上"替代了什么"的不装；优先纯 Node 插件（csai 无 Docker）。

## 十三、合规护栏（诚实修正 v3 §十 + 接入审计优先修复）

> 安全平台自身**不能"文档强于代码"**。逐条标真实状态：

| # | 护栏 | 真实状态 | v4 动作 |
|---|---|---|---|
| 1 | scope 白名单**字面**硬校验 | ✅ 已落地 | 保持 |
| 1b | scope **解析后**校验（DNS/重定向/回调） | ❌ 未接（审计 S1） | active+ 目标补 DNS 解析后 IP 复核 |
| 2 | 风险四级 | ✅ 已落地 | 保持 |
| 2b | sandbox（bwrap/Landlock）隔离执行 | ❌ 装了 bwrap 没用（审计 S2） | run_cli 接 `dsh-sandbox`，active/intrusive 强制 |
| 3 | 全量审计 run_id 可回放 | ✅ 已落地 | 补 audit.jsonl rotation |
| 4 | 出口 mubeng + **egress-guard 白名单** | ⚠️ mubeng✅ / egress-guard❌ | 接 egress-guard（兜住 S1/S3） |
| 5 | Web UI auth-gate | ✅ 已落地 | 公网入口挪 Authelia forward-auth（审计 S6） |
| 6 | 注入防护 taintguard | ❌ 未装（审计 S8） | kb_import/浏览器返回过污点标记 |
| 7 | 流量归档加密+保留期+脱敏 | ❌ 未落地（审计 S7） | 接 `dsh-output-retention` |
| 8 | 插件供应链先扫后装+pin+hash | ⚠️ 安装期✅/运行期❌ | egress 白名单纳入插件外联 |
| 9 | 仅限授权测试 | ✅ fail-closed 支撑 | 保持 |
| + | `.env` 权限 644→600 | ❌ 审计 S5 | manifest/setup 固化 600（分钟级） |

**修复优先级**（审计给出）：立即（chmod 600 .env / 文档标真实状态）→ 短期（无 target_param 且 risk≥active 拒绝 / 参数类型校验）→ 中期（sandbox / egress-guard / taintguard / 解析后校验 / output-retention）。

## 十四、实施路线图 v4（增量，不推倒 P0–P5）

| 阶段 | 交付物 | 验收 |
|---|---|---|
| **P6 脊柱** | programs/tasks 表 + task_* 工具 + program_id 回填迁移 + orchestrator Preset | "对 X 项目起 recon 任务"跑通，看板出进度；存量 692 资产回填项目归属 |
| **P7 补血（低垂果实）** | parser 注册表 + nuclei/afrog→findings + plan_chain 凑链 + 分级摘要 | nuclei 命中自动进漏洞库并去重；公司名→资产链一键；token 对比量化 |
| **P8 管理增强** | 事实图谱黑板 + 指纹/凭据/接口鉴权建模 + finding 报告模板 + 覆盖盲区仪表盘 | 越权按角色矩阵批量跑；项目级报告出；资产风险自动算 |
| **P9 自学习强化** | negative-ledger 内建 + 经验卡语义去重 + 活评测集 + RAG rerank + component-vuln-intel 触发 | 证伪路径拦重复；实战打标自动成评测；指纹命中自动生成验证任务 |
| **P10 合规补齐** | sandbox / egress-guard / taintguard / output-retention / 解析后校验 | §十三对照表全绿；审计 S1/S2/S7/S8 关闭 |

## 十五、风险与取舍

- **优先补血再扩张**：P7 的 parser→findings 是最高 ROI，先把"引擎结果进不了库"堵上，再谈补工具；
- **自建 vs 复用边界清晰**：领域实体（program/task/finding/fact）自建持久层，编排/审批/检索/LLM 复用 DSH+pi 底座，DSH 大版本只冲击 shim；
- **事实图谱注入预算**：只注入索引、body 按需拉——既省 token 又防臆造，但需监控索引膨胀（超预算自动列 fact_search）；
- **自进化人工把关**：摘要/技能自优化一律"自动起草、人工采纳"，影子 git 可回滚，防系统跑偏；
- **诚实红线**：合规护栏"未落地就标未落地"，绝不让使用者高估防护面——这是安全平台的职业底线。

---

*本文档为 v3 的优化设计后继，v3 的 P0–P5 落地历程与踩坑经验仍是权威历史记录。v4 聚焦"脊柱 + 补血 + 管理 + 自学习"，全部增量、可回滚、数据无损。*
