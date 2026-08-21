# SilkSecAgent（DSH + pi）网络安全辅助平台 · 整合优化方案 v5

> **合规声明**：本平台仅用于**授权范围内**的漏洞发现（SRC 众测 / HW 防守自查 / 自有资产安全评估）。所有目标经 `scope.yml` 白名单 fail-closed 硬校验，风险分级 + 人工断点 + 全量审计。本文档只做**能力、流程、数据与管理的架构设计**，不含任何具体攻击手法、漏洞利用或 exploit 代码。
>
> **v5 定位**：本文档是三份材料的**合流与收敛**——
> 1. [dsh-pi-secagent-plan.md](dsh-pi-secagent-plan.md)（v3）：P0–P5 落地历程与踩坑经验，是**权威历史记录**；
> 2. [dsh-pi-secagent-plan-v4.md](dsh-pi-secagent-plan-v4.md)（v4）：脊柱/补血/管理/自学习的优化设计；
> 3. [dsh-secagent-security-audit-2026-08-21.md](dsh-secagent-security-audit-2026-08-21.md)：运行时 + 源码审计，判定**「文档声称的防护强度 > 代码实际强度」**。
>
> v5 只做四件事：**① 把三份文档合并成一份可执行的主计划；② 明确两条能力主线（使用体验 / 发现漏洞的能力）的「现状 → 目标 → 差距」；③ 给出分阶段优化计划；④ 给出可落地的执行步骤（含文件与命令）**。不推倒重来，全部增量、可回滚、数据无损。

---

## 0. 一句话诊断

SilkSecAgent 已是一台**跑得通的引擎**：scope-guard fail-closed、token 压缩 1146x、692 资产 / 57 漏洞真实在库、靶场多引擎已跑通、美团/字节 SRC 实战各跑一轮。但它有两个短板：

1. **无脊柱**——所有工作散落在「一次会话 + 一张扁平黑板」里，回答不了「某项目现在什么进度」「这条漏洞属于哪个项目哪个任务」「接下来该扫什么」。
2. **文档强于代码**——安全审计确认 §十「代码层硬约束」10 条中 **4 条未落地、2 条部分落地**（无沙箱 / 无解析后校验 / 无出口白名单 / 无注入防护 / 无保留期），而 rc.7 其实**自带这些轮子（dsh-sandbox / dsh-output-retention 等），只是没装上车**。

**结论**：优化重心不是再造引擎，而是**给引擎装脊柱（Program→Task→Run）、装神经（事实图谱黑板）、补上漏装的护栏、并界面化**——从「工具执行器」进化为「可管理、能自学、可交付的作战平台」。

---

## 一、现状诚实基线（三份文档合流）

### 1.1 已真实跑通（经审计实测成立，v5 保留不动）

| 能力 | 落点 | 状态 |
|---|---|---|
| `sec-cli-adapter`（run_cli / grep_result / page_result） | [dsh-plugin-sec-suite.js](../bundles/dsh/templates/dsh-plugin-sec-suite.js) | ✅ manifest 驱动、全量落盘 + ≤20 行摘要，压缩比实测 1146x |
| `scope-guard` fail-closed 白名单 + 风险四级 + `audit.jsonl` | 同上 `:212 checkTarget` | ✅ 字面主机/CIDR/后缀匹配，默认拒绝 |
| `asset-graph`（assets/endpoints/findings/blackboard 四表 + WAL） | [asset-db.js](../bundles/dsh/templates/dsh-plugin-sec-suite.asset-db.js) | ✅ 692/279/57/969 真实数据 |
| `experience-hub`（经验卡/知识库/playbook + FTS5 + 向量嵌入） | [experience.js](../bundles/dsh/templates/dsh-plugin-sec-suite.experience.js) | ✅ 语义检索已接 multilingual-e5-small |
| `spawn_worker`（DSH headless 子进程，≤4 并发，只回尾部） | js `:634` | ✅ 批任务上下文隔离 |
| `authz_diff`（双会话重放 + 响应 diff） | js `:519` | ✅ suspected 自动入 finding，scope 门正确（`:519-525`） |
| finding 状态机 + `report_build` | asset-db `:164` | ✅ new→confirmed→submitted→accepted/dup/ignored |
| 代理池（mubeng:8899）/ dsh-bill / auth-gate / model-failover / dsh-browser(fork) | plugins.lock | ✅ 已装并验证 |
| Vulhub 靶场 + `eval-run.js` 回归 / intel-refresh timer | eval/intel | ✅ 首轮 nuclei 3/6 + afrog 补位 struts2 |
| 多供应商路由（pi-ai 底座）+ 两级熔断 | settings.yaml + model-failover | ✅ deepseek-v4-pro/flash 验证 |
| 26 工具 / 22 manifest / 6 Preset / 3 Skill | tools.list / seed-* | ✅ 装齐 |

### 1.2 声称未落地（v4 §1.2 与审计 §3 对齐的「低垂果实」）

| 声称 | 代码实况 | 处置 |
|---|---|---|
| manifest `parser`（jsonl/json/csv 结构化） | ❌ 只 regex 抽 URL/host（`ingestText`） | §八 P7 实现 parser 注册表 |
| **nuclei/afrog 结果入 findings 表** | ❌ 只有 xray-webhook / authz_diff 写 finding，**主扫描引擎结果不进漏洞库** | §八 P7 修复（最大缺口） |
| manifest `requires/produces` 能力凑链 | ❌ 字段写了没读 | §八 P7 实现 `plan_chain` |
| `summarize: head_llm` 分级摘要 | ❌ 永远 head-20 行 | §八 P7 + §九自优化 |
| sandbox（bwrap/Landlock）隔离执行 | ❌ bwrap 装了没用（审计 S2，高） | §六 P10 接 dsh-sandbox |
| scope 解析后校验（DNS/重定向/回调） | ❌ 只有字面校验（审计 S1，高） | §六 P10 补后置校验 |
| egress-guard 出口白名单 | ❌ 未装（审计 S3，中） | §六 P10 接入 |
| taintguard 注入防护 | ❌ 未装（审计 S8，低） | §六 P10 接入 |
| 流量加密 + 保留期 + 脱敏 | ❌ 未落地（审计 S7，低） | §六 P10 接 output-retention |
| negative-ledger / chicheng-push | ❌ 未装 | §九 P9 内建 negative-ledger |
| pi-bridge 融合层（v3 §5.2） | ❌ 明确没做，走 DSH headless | §1.3 重定位（不再需要） |

### 1.3 DSH / pi / CyberStrikeAI 定位结论（核实到源码级）

- **DSH**（`deepseek-ai/deepseek-harness`，50 包，Cordis「一切皆插件」）：**主框架**。`goal/plan/todo` 是**会话内自编排构件**（易失），**不是**带独立生命周期的领域实体 → engagement/task/vuln **必须自建持久层**（挂 `ctx.<key>` Cordis service + 我们的 SQLite）。可直接复用：`ctx.jobs` / `ctx.workflowEngine` / `ctx.subagents` / `ctx.sessionQuery` / `ctx.approval` / `ctx.storage` / `ctx.credentials` / `ctx.spillStore` / `ctx.compaction`。
- **pi**（`earendil-works/pi`，10 包）：**不再是「要融合的第二框架」**。上游明示 `dsh-llm-pi-ai` "backed by `@earendil-works/pi-ai`"——**pi-ai 已是 DSH 的 LLM 路由底座**。pi 在 v5 的干净角色：① `pi-ai` = LLM 底座（只声明 provider routes）；② `pi-coding-agent` = 工程师本机写 manifest/Skill 的工具（不进服务器）；③ `pi-agent-core` = 未来多机 worker 的可选运行时（当前 spawn_worker 走 DSH headless，**暂不启用**）。→ 无需自建 pi-bridge，消除双轨维护。
- **CyberStrikeAI**（`Ed1s0nZ/CyberStrikeAI`，已退役，数据保留在 `/opt/silkspool/dsh/data/import-staging/cyberstrikeai/`）：**只借鉴设计，不照搬实现**。四点直接借用：① 一切以 **Project 为作用域**（`project_id` 外键贯穿）；② **事实图谱**（category/body/confidence + 关系边）替代扁平 key:value；③ **orchestrator 三模式派单 + 交接包纪律**（子代理禁再委派）；④ **vulnerabilities 表即报告模板** + 组件触发搜洞触发器。

### 1.4 数据规模现状（可复现基线）

资产 692 / 接口 279 / finding 57 / 黑板 969；美团 SRC 首跑 14 存活、新发现 2（id 58-59）；字节 185 资产/10 漏洞/566 黑板事实已导入；靶场基线 nuclei 3/6 + afrog 补位（drupal CVE-2018-7600 为已知引擎覆盖缺口，保留为长期回归项）。

---

## 二、两个核心能力目标（本次确定）

优化的一切取舍，围绕两条主线：**使用体验** 与 **发现漏洞的能力**。

### 2.1 目标一：使用体验（UX）

> **北极星指标**：从「新拿到一个 SRC 项目」到「看到第一份可审核的报告」，全程 ≤ 3 次人工点击/一条命令；所有需要人工判断的环节，都能在手机上收到通知并一键放行。

| 维度 | 现状 | 目标（P7–P9 达成） |
|---|---|---|
| **启动** | 手工在会话里拼工具链 | 一句话：`对 X 项目做资产收集/漏洞挖掘` → 编排器自动凑链 + 派单 |
| **进度可见** | 无看板，会话里翻 | 三视图看板（task / asset / finding），项目进度/风险/盲区一眼可见 |
| **盲区可见** | 无 | 覆盖盲区仪表盘：从未扫描 / >30 天未扫描按 `last_seen` 顶到最前 |
| **报告** | `report_build(host_like)` 只能按主机过滤 | `report_build(program)` 项目级 markdown，提交前强制人工审 |
| **判定打标** | 手工改状态 | 每个 finding 旁「确认/误报/风险接受」一键 = 一条评测用例 + 一条负样本（零摩擦） |
| **HITL 到手机** | 人在电脑前才能过门 | `ctx.approval` + chicheng-push：intrusive/提交类阻塞推手机，随时放行 |
| **对工程师** | 加工具要改代码 | 加工具=丢 YAML；加解析=写一个 parse 函数；加角色=一个 mkpreset；加纪律=一个 Skill md |

### 2.2 目标二：发现漏洞的能力

> **北极星指标**：四类漏洞发现能力（见下表）从「能跑」到「能系统性覆盖 + 有证据 + 有评测」，并让**主扫描引擎的每条命中都进入漏洞库**（当前最大漏斗缺口）。

**能力四象限（现状 → 目标）**：

| 象限 | 现状 | 目标 | 关键差距 |
|---|---|---|---|
| **A 技术栈漏洞**（模板/POC 扫描） | nuclei/afrog/xray 三引擎已跑，但**命中不进 findings 表** | parser→findings + 三级漏斗，命中结构化入库存证，规则层挡 60%+ 误报 | 最大缺口（§八 P7） |
| **B 越权/业务逻辑** | `authz_diff` 单发可用，但**接口图谱无鉴权建模**，无法批量 | 接口 `params/auth_required/roles_seen` 建模 → 按角色矩阵批量跑 authz_diff | 缺接口鉴权建模 + 批量流水线（§八 P8） |
| **C 代码审计/供应链** | semgrep/codeql/gitleaks/osv 已装，但与本机目标耦合、scope 无 target_param | 代码审计走独立 Preset + 结果入 finding（vuln_type/endpoint_ref 报告字段） | 中等（§八 P7-P8） |
| **D 情报驱动** | intel-refresh timer 刷模板，**无指纹触发搜洞** | 指纹表 → component-vuln-intel 触发器：识别组件→查 N-day→生成验证任务（强制 tentative） | 缺指纹表 + 触发器（§九 P9） |

**能力深度分层（每层有明确验收）**：

1. **广度（资产面）**：`enscan→subfinder→dnsx→httpx→EHole→katana→LinkFinder` 一键侦察链，公司名进、资产图谱出；
2. **深度（漏洞面）**：三引擎广谱 → 指纹定向 → 越权矩阵 → 代码审计，逐层递进；
3. **智能（证据面）**：验证铁律（confirmed 必挂证据 / 搜索结果≠漏洞 / 验证失败写负结果）+ 三级漏斗 + 经验卡检索；
4. **评测（闭环面）**：Vulhub 6 靶标 + **活评测集**（实战打标自动成用例），按模型档位出「发现率/误报率/打点耗时」周报。

**量化目标（基线已在 §1.4）**：

- 主扫描引擎命中进库率：**0% → 100%**（P7 修复 parser）；
- 靶场发现率：nuclei 3/6 保持 + 用多引擎补位覆盖 struts2（已达成），**drupal 缺口作为长期回归项跟踪**；
- 误报挡除率：规则层 **≥ 60%**（零 token，P7 验证）；
- 越权测试：从单发 → **按角色矩阵批量**（P8，一个 biz-logic 任务覆盖全部鉴权接口）；
- 评测用例：从 6 靶标 → **靶标 + 实战打标自动生长**（P9）。

---

## 三、总体架构（整合版，无变化的核心骨架 + 新增脊柱）

```
Program（SRC/HW 项目，真相源=scope.yml）
   │ 1:N
Task（任务：队列/优先级/依赖/预算/HITL）── 编排器(orchestrator Preset + 调度 worker) 派单
   │ 1:N
Run（run_cli / spawn_worker / authz_diff / browser_*，全量落盘 results/<id>/）
   │ 证据
   └──▶ 事实图谱黑板(facts + fact_edges) ◀── 自主学习四环（经验卡/playbook/评测/情报）
              ▲
   三大管理面：资产管理(§五) / 漏洞管理(§六) / 任务管理(§四)
```

**不变的核心原则**（v3 已验证）：工具调用只有一条路 `sec-cli-adapter → 本机 CLI`；浏览器操作只有一条路 `dsh-browser → 流量总线`；能力全部以 CLI/插件形态接入，**一律不挂 MCP**；数据外置 `/opt/silkspool/dsh/data/`，与 DSH 安装目录分离。

**新增的脊柱**（v4 §二）：Program→Task→Run 三级模型 + 编排器——解决「无任务实体、无法治理」的根因。

---

## 四、优化主线

五条主线，按 ROI 排序（= 实施顺序）：

1. **【最高优先】安全加固**（审计 9 项发现，§六）——先堵「文档强于代码」的误判防护面；
2. **【P7 补血】** parser 注册表 + nuclei→findings + plan_chain + 分级摘要——把「引擎结果进不了库」堵上，最大杠杆；
3. **【P6 脊柱】** programs/tasks 表 + task_* 工具 + program_id 回填 + orchestrator——三大管理的地基；
4. **【P8 管理增强】** 事实图谱 + 指纹/凭据/接口鉴权建模 + finding 报告模板 + 盲区仪表盘——越权系统化 + 项目级报告；
5. **【P9 自学习】** negative-ledger 内建 + 经验卡语义去重 + 活评测集 + RAG rerank + component-vuln-intel——闭环自动生长。

---

## 五、数据模型 v2（三大管理的地基）

> 全部落在现有 `asset-graph.db`（node:sqlite + WAL），在 [asset-db.js](../bundles/dsh/templates/dsh-plugin-sec-suite.asset-db.js) 的 `getDb()` 建表段追加。**平滑迁移**：全部 `ALTER TABLE ADD COLUMN`（可空），不重建表；`backfill-program.js` 用 `checkTarget(host)` 反查回填 `program_id`。

### 5.1 新增 programs / tasks 表

```sql
CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,              -- = scope.yml program.name
  platform TEXT, status TEXT DEFAULT 'active',
  max_risk TEXT, fixed_egress_ip INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id TEXT NOT NULL, parent_id INTEGER,
  phase TEXT,                       -- recon/vuln/biz-logic/code-audit/intranet/review
  objective TEXT NOT NULL,
  status TEXT DEFAULT 'queued',     -- queued/running/blocked/done/failed/cancelled
  priority INTEGER DEFAULT 5,       -- 0 最高
  assignee TEXT, budget_tokens INTEGER, spent_tokens INTEGER DEFAULT 0,
  session_id TEXT, blocked_reason TEXT, result TEXT,
  created_at INTEGER, updated_at INTEGER, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(program_id, status, priority);
```

### 5.2 现有表增维（program_id / task_id）

```sql
ALTER TABLE assets    ADD COLUMN program_id TEXT;
ALTER TABLE endpoints ADD COLUMN program_id TEXT;
ALTER TABLE findings  ADD COLUMN program_id TEXT;
ALTER TABLE findings  ADD COLUMN task_id    INTEGER;
```

> 所有写入路径（`upsertAsset/upsertEndpoint/addFinding/ingestText`）增加可选 `program_id`；`run_cli` 从 `checkTarget` 命中的 `program.name` **自动回填**（`:224` 已返回 `program`，只需透传）——零人工成本给数据打项目归属。

### 5.3 黑板升级为事实图谱（facts + fact_edges）

```sql
CREATE TABLE IF NOT EXISTS facts (
  program_id TEXT NOT NULL, fact_key TEXT NOT NULL,   -- 格式 category/slug
  category TEXT,                    -- auth/target/note/finding/chain/exploit/asset
  summary TEXT,                     -- 一行索引（注入 prompt）
  body TEXT,                        -- 完整可复现上下文（按需 fact_get，不注入）
  confidence TEXT DEFAULT 'tentative',
  pinned INTEGER DEFAULT 0, related_finding_id INTEGER, source TEXT, updated_at INTEGER,
  PRIMARY KEY (program_id, fact_key)
);
CREATE TABLE IF NOT EXISTS fact_edges (
  program_id TEXT NOT NULL, src_key TEXT NOT NULL, dst_key TEXT NOT NULL,
  edge_type TEXT NOT NULL,          -- resolves_to/hosts/exposes/depends_on/leads_to/enables/exploits
  confidence TEXT,
  PRIMARY KEY (program_id, src_key, dst_key, edge_type)
);
```

**关键机制**：只把索引（fact_key + summary + 关系边）注入 prompt，**body 按需拉取**；边渗透边记录；约定落点 凭据→`auth/*`、目标→`target/*`、死路→`note/*`。现有 `blackboard_set/get` 保留为**兼容薄封装**（写 `note/` 分类）。

### 5.4 指纹 / 凭据 / 接口鉴权 / finding 报告模板

```sql
CREATE TABLE IF NOT EXISTS fingerprints (
  program_id TEXT, host TEXT, tech TEXT, version TEXT, source TEXT, last_seen INTEGER,
  PRIMARY KEY (host, tech)
);
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT, host TEXT,
  cred_type TEXT, ref TEXT,         -- ref 指向 ctx.credentials / env 变量名，绝不存明文
  role TEXT, note TEXT, created_at INTEGER
);
ALTER TABLE endpoints ADD COLUMN params TEXT;
ALTER TABLE endpoints ADD COLUMN auth_required TEXT;   -- yes/no/unknown
ALTER TABLE endpoints ADD COLUMN roles_seen TEXT;      -- JSON 角色矩阵
ALTER TABLE findings ADD COLUMN vuln_type TEXT;        -- IDOR/SQLi/XSS/RCE/未授权...
ALTER TABLE findings ADD COLUMN cwe TEXT;
ALTER TABLE findings ADD COLUMN endpoint_ref TEXT;
ALTER TABLE findings ADD COLUMN preconditions TEXT;
ALTER TABLE findings ADD COLUMN reproduction_steps TEXT;
ALTER TABLE findings ADD COLUMN impact TEXT;
ALTER TABLE findings ADD COLUMN recommendation TEXT;
ALTER TABLE findings ADD COLUMN submitted_at INTEGER;
ALTER TABLE findings ADD COLUMN vendor_status TEXT;    -- triaged/accepted/duplicate/na/resolved
ALTER TABLE findings ADD COLUMN bounty REAL;
```

---

## 六、安全加固（整合审计 §2/§3，最高优先）

> **铁律：合规护栏「未落地就标未落地」，绝不让使用者高估防护面。** 下表逐条标真实状态 + 修复动作（对齐审计 S1–S9）。

| # | 护栏 | 真实状态 | 动作 |
|---|---|---|---|
| 1 | scope 白名单字面硬校验 | ✅ 已落地 | 保持 |
| 1b | scope 解析后校验（DNS/重定向/回调） | ❌ 审计 S1（高） | active+ 目标补 DNS 解析后 IP 复核 + 跳转落点校验 |
| 2 | 风险四级 | ✅ 已落地 | 保持 |
| 2b | sandbox（bwrap/Landlock）隔离 | ❌ 审计 S2（高，bwrap 装了没用） | `run_cli` 接 `dsh-sandbox`/bwrap，active/intrusive 强制 |
| 3 | 全量审计 run_id 可回放 | ✅ 已落地 | 补 `audit.jsonl` rotation |
| 4 | 出口 mubeng + egress-guard 白名单 | ⚠️ mubeng✅ / egress❌（S3） | 接 egress-guard，兜住 S1/S3 |
| 5 | Web UI auth-gate | ✅ 已落地（但见 S6） | 公网入口挪 Authelia forward-auth（审计 S6） |
| 6 | 注入防护 taintguard | ❌ 审计 S8 | kb_import/浏览器返回过污点标记 |
| 7 | 流量归档加密+保留期+脱敏 | ❌ 审计 S7 | 接 `dsh-output-retention` |
| 8 | 插件供应链先扫后装+pin+hash | ⚠️ 安装期✅ / 运行期❌（S9） | egress 白名单纳入插件外联 |
| 9 | 仅限授权测试 | ✅ fail-closed 支撑 | 保持 |
| + | `.env` 权限 644→600 | ❌ 审计 S5 | manifest/setup 固化 600（分钟级） |
| + | scope 无 target_param 且 risk≥active | ❌ 审计 S3 结构脆弱 | `runCli` 增守卫：拒绝或强制人工放行 |
| + | 标量参数类型校验 | ❌ 审计 S4 | 禁止空白/元字符，隔离参数与命令结构 |

**修复优先级**（沿用审计 §5）：
- **立即（分钟级）**：`chmod 600 .env` 并固化；`systemctl reset-failed cyberstrikeai.service`；清 `sentinel.lease`；文档标真实状态。
- **短期（小时级）**：`runCli` 增「无 target_param 且 risk≥active → 拒绝」守卫；标量参数类型校验；`dsh-upgrade.sh` 冒烟从 liveness 升级为「passive run_cli + 越界 deny 断言 + DB count」。
- **中期（工程投入）**：run_cli 接 dsh-sandbox；接 egress-guard + taintguard；scope-guard 补解析后校验；auth-gate 挪 Authelia；flows/results 接 output-retention。

---

## 七、优化计划（分阶段总览）

| 阶段 | 交付物 | 验收 |
|---|---|---|
| **P6 脊柱** | programs/tasks 表 + task_* 工具（create/update/list/next/stats）+ program_id 回填迁移 + orchestrator Preset | 「对 X 项目起 recon 任务」跑通，看板出进度；存量 692 资产回填项目归属 |
| **P7 补血** | parser 注册表 + nuclei/afrog→findings + plan_chain 凑链 + 分级摘要 + 三级漏斗规则层 | nuclei 命中自动进漏洞库并去重；公司名→资产链一键；规则层挡 60%+（dsh-bill 量化） |
| **P8 管理增强** | 事实图谱黑板 + 指纹/凭据/接口鉴权建模 + finding 报告模板 + 覆盖盲区仪表盘 + 越权矩阵流水线 | 越权按角色矩阵批量跑；项目级报告出；资产风险自动算 |
| **P9 自学习强化** | negative-ledger 内建 + 经验卡语义去重 + 活评测集 + RAG rerank + component-vuln-intel 触发 | 证伪路径拦重复；实战打标自动成评测；指纹命中自动生成验证任务 |
| **P10 合规补齐** | sandbox / egress-guard / taintguard / output-retention / 解析后校验 | §六对照表全绿；审计 S1/S2/S3/S7/S8/S9 关闭 |

> P6–P10 是 v4 §十四路线的**再排序**：把「安全加固的立即项」提到最前（原 P10 的分钟级项现在就先做），把 P7 补血提前（它是最高 ROI 的能力缺口），P6 脊柱与 P8 管理同属「装脊柱+装神经」，P9 自学习殿后。

---

## 八、执行步骤（可操作清单）

> 每步给出「做什么 / 改哪个文件 / 怎么验收」。P6–P10 顺序执行，每阶段结束可独立验证、可回滚。

### 步骤 0：安全立即项（分钟级，先做）

1. `chmod 600 /opt/silkspool/dsh/.env`；在 [manifest.yaml](../bundles/dsh/templates/manifest.yaml) defaults 与 [setup.sh](../bundles/dsh/templates/setup.sh) 固化 600（否则 re-setup 退回 644）。
2. `spool exec csai "systemctl reset-failed cyberstrikeai.service; rm -f /opt/silkspool/dsh/data/sentinel.lease"`。
3. 本文档 §六对照表即「文档标真实状态」的交付物（已完成）。

### 步骤 1（P6 脊柱）

1. [asset-db.js](../bundles/dsh/templates/dsh-plugin-sec-suite.asset-db.js) `getDb()` 追加 §5.1/§5.2 建表与 ALTER。
2. 新增 `tasks` 工具集（挂 agent 面）：`task_create / task_update / task_list / task_next / task_stats`。
3. `runCli` 透传 `checkTarget` 返回的 `program.name` → `ingestText`/`addFinding` 回填 `program_id`。
4. 新增 `backfill-program.js`：遍历存量 assets/findings，`checkTarget(host)` 反查回填，未命中归 `_legacy`。
5. 新增 `orchestrator` Preset（Deep 模式 + 交接包纪律：目标标识/范围/成功标准/产出格式四必填，缺一禁委派）。
- **验收**：`task_create(program=meituan, phase=recon)` → 编排器 `task_next` 认领 → `spawn_worker` 跑通；`asset_stats` 显示按 program 分布。

### 步骤 2（P7 补血，最高 ROI）

1. 新建 `parsers/` 目录 + parser 注册表（`jsonl_httpx / jsonl_nuclei / lines_subfinder / csv_ffuf / excel_enscan`）。
2. `runCli` 把 `manifest.parser` 路由到注册表，替代 `ingestText` 的纯 regex 抽取；manifest `store` 逻辑不变。
3. **`jsonl_nuclei` → `addFinding`**：每条命中写 `vuln_type/severity/url/evidence(run_id+template-id)/program_id/task_id`，走 `sha1(host|title|url)` 去重。
4. 新增 `plan_chain(have, want)`：读 manifest `requires/produces` 建图，BFS 返回有序工具链。
5. 分级摘要：`summarize: head_llm` 走 pi 小模型蒸馏（`head_n` 之外）；三级漏斗规则层（零 token 挡 60%+）。
- **验收**：`run_cli(nuclei)` 命中自动进 findings 表且去重；`plan_chain([company], findings)` 返回 `enscan→subfinder→dnsx→httpx→nuclei`；token 对比量化报告。

### 步骤 3（P8 管理增强）

1. 落 §5.3 事实图谱 + §5.4 指纹/凭据/接口鉴权表；新增 `fact_upsert / fact_get / fact_search / fact_link / fact_graph / fp_add / fp_query / cred_add / cred_query`。
2. `endpoint_add` 增 `params/auth_required/roles_seen`；`asset_query` 增 `program/risk_level/never_scanned` 过滤；新增 `asset_graph(host)`。
3. `finding_add` 补报告模板字段；`report_build` 支持 `program/task` 维度。
4. 越权矩阵流水线：`biz-logic` 任务 → `endpoint_query(auth_required=yes)` → 逐接口 × 角色矩阵批量 `authz_diff`（spawn_worker）。
5. 覆盖盲区仪表盘（Web UI 资产视图：从未扫描 / >30 天未扫描 / 风险等级）。
- **验收**：一个 biz-logic 任务覆盖全部鉴权接口；`report_build(program)` 出项目级报告；资产风险 `risk_score` 自动算。

### 步骤 4（P9 自学习强化）

1. negative-ledger 内建：验证失败 → `fact_upsert(note/failed-*, confirmed)`；`plan_chain`/编排器派单前查 `note/*` 拦截。
2. 经验卡语义去重：入库前算 embedding，cosine > 0.85 → 合并+证据追加。
3. 活评测集：`finding_update(confirmed/false_positive)` 时自动追加 `eval-cases.list`（目标+期望命中/不命中签名）。
4. kb RAG 升级：分块 → 向量 → MultiQuery(≤4) → 检索 → Rerank 去重限长。
5. component-vuln-intel：`fp_add` 事件 → 查 nuclei 模板/CVE/POC → `task_create(phase=vuln, priority=1)`（结果强制 tentative）。
- **验收**：证伪路径拦重复；实战打标自动成评测；指纹命中自动生成验证任务。

### 步骤 5（P10 合规补齐）

1. `run_cli` 接 `dsh-sandbox`/bwrap（只读挂 bin、绑定 runDir、`--unshare-*`），active/intrusive 强制。
2. 接 `egress-guard`（网络层白名单，兜 S1/S3）+ `taintguard`（S8）+ `dsh-output-retention`（S7）。
3. scope-guard 补 DNS 解析后 IP 复核 + 跳转落点校验（S1）。
4. auth-gate 挪 Authelia forward-auth / Caddy 层加 IP 白名单 + fail2ban（S6）。
5. `runCli` 增「无 target_param 且 risk≥active → 拒绝」守卫（S3）+ 标量参数类型校验（S4）。
- **验收**：§六对照表全绿；审计 S1/S2/S3/S4/S7/S8/S9 关闭。

---

## 九、验收标准（汇总，跨阶段）

| 能力 | 验收指标 |
|---|---|
| 使用体验 | 新项目 → 首份可审报告 ≤ 3 次点击/一条命令；盲区一眼可见；HITL 推手机 |
| 漏洞发现 | 主扫描引擎命中进库 100%；靶场发现率保持并跟踪 drupal 缺口；越权按角色矩阵批量；规则层挡 60%+ |
| 管理 | 项目/任务/漏洞可按 program 治理；项目级报告可出；资产风险自动算 |
| 自学习 | 证伪路径拦截；实战打标自动成评测用例；指纹命中自动生成验证任务 |
| 合规 | §六对照表全绿；「文档=代码」不再虚标 |

---

## 十、风险与取舍

- **优先补血再扩张**：P7 的 parser→findings 是最高 ROI，先把「引擎结果进不了库」堵上，再谈补工具；
- **自建 vs 复用边界清晰**：领域实体（program/task/finding/fact）自建持久层，编排/审批/检索/LLM 复用 DSH+pi 底座，DSH 大版本只冲击 shim（最坏 1–2 天重构，数据无损）；
- **事实图谱注入预算**：只注入索引、body 按需拉——既省 token 又防臆造，需监控索引膨胀（超预算自动列 fact_search）；
- **自进化人工把关**：摘要/技能自优化一律「自动起草、人工采纳」，影子 git 可回滚，防系统跑偏；
- **诚实红线**：合规护栏「未落地就标未落地」，安全平台自身不能「文档强于代码」——这是职业底线；
- **单机资源上限**：8C/16G，扫描并发由 manifest 上限 + jobs 队列约束，必要时 worker 迁机（pi-agent-core 备选运行时）。

---

*本文档为 v3 落地历史 + v4 优化设计 + 安全审计真相的合流主计划。v3 的 P0–P5 历程与踩坑仍是权威历史；v4 的详细设计（编排器交接包、事实图谱注入、RAG 管道等）仍是实施蓝本；审计报告仍是合规修复的核对清单。v5 只负责「合流 + 定主线 + 排顺序 + 给步骤」，全部增量、可回滚、数据无损。*
