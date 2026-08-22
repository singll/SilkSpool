# SilkSecAgent（DSH + pi）网络安全辅助平台 · 主计划 v6（合流终版 + 校准 + 新迭代）

> **合规声明**：本平台仅用于**授权范围内**的漏洞发现（SRC 众测 / HW 防守自查 / 自有资产安全评估）。所有目标经 `scope.yml` 白名单 fail-closed 硬校验，风险分级 + 人工断点 + 全量审计。本文档只做**能力、流程、数据与管理的架构设计**，不含任何具体攻击手法、漏洞利用或 exploit 代码。
>
> **v6 定位**：本文档是三份文档的**合流终版**，原文档不再单独保留（git 历史可查）：
> 1. `dsh-pi-secagent-plan.md`（v3）：P0–P5 落地历程与踩坑，压缩为**附录 A（权威历史）**；
> 2. `dsh-secagent-security-audit-2026-08-21.md`：运行时 + 源码审计，保留为**附录 B（合规核对清单，含修复状态）**；
> 3. `dsh-pi-secagent-plan-v5.md`（v5）：优化主计划，其 P6–P10 **已全部落地**（2026-08-21/22 提交），正文吸收并校准。
>
> v6 做三件事：**① 以 2026-08-22 实测数据校准「文档=代码」；② 吸收五个新需求（定时任务 / 跳转 / 工作区融合 / 事实迁移 / 强关联）形成 P11 迭代方案；③ 保持增量、可回滚、数据无损。**

---

## 0. 一句话诊断（2026-08-22 校准）

SilkSecAgent 已从「跑得通的引擎」进化为「有脊柱、有眼睛的平台」：P6 脊柱（programs/tasks 表 + task 工具）、P7 补血（parser 注册表 + nuclei→findings + plan_chain）、P8 管理增强（事实图谱 + 指纹/凭据 + 报告模板）、P9 自学习（negative-ledger/活评测/语义去重/intel_hunt）、P10 合规补齐（bwrap 沙箱/S1 解析后校验/参数注入防护/retention）**全部落地**，看板全局入口四视图已上线（丝之歌主题）。但它有五个新短板（对应本次五个需求）：

1. **任务无定时**——tasks 表 0 行、无调度字段，DSH 自带 `dsh-schedule` 装了没组合；对话里说「定时跑」**不会**出现在看板任务里（§五给出直接回答与方案）。
2. **无跳转**——看板行与会话之间没有链接，run→session 映射不存在（工具执行未捕获 `exec.agent.id`）。
3. **双项目体系**——看板的 Program（scope.yml 镜像）与 DSH 自带 Workspace（`ctx.workspaceRegistry`，已有美团SRC/字节SRC 两个）是两套，未融合。
4. **事实黑板空转**——facts/fact_edges 表 + fact_* 工具 + 看板事实视图都已上线**但 0 行**；970 条旧事实（含字节 566 条）仍躺在遗留 blackboard 表里只读展示。
5. **归属未收口**——287 资产 / 26 漏洞 / 235 接口挂在 `_legacy`（含字节 117 资产，因 scope.yml 无 bytedance 程序），与工作区未绑定。

**结论**：P11 迭代 = **装日历（定时任务）、装桥梁（工作区融合 + 跳转）、搬家（事实迁移 + 存量重关联）**，全部增量、不推倒重来。

---

## 一、现状诚实基线（2026-08-22 实测校准）

> 校准方式：spool exec 实测 csai 运行时（SQLite 计数 / systemctl / 文件权限 / profile 组合）+ 源码通读 + rc.7 包级核实。

### 1.1 能力矩阵（真实状态，✅=已落地并验证）

| 能力 | 落点 | 状态 |
|---|---|---|
| `sec-cli-adapter`（run_cli / grep_result / page_result） | [dsh-plugin-sec-suite.js](../bundles/dsh/templates/dsh-plugin-sec-suite.js) | ✅ manifest 驱动、全量落盘 + ≤20 行摘要，压缩比实测 1146x |
| `scope-guard` fail-closed + 风险四级 + `audit.jsonl` | 同上 | ✅ 字面/CIDR/后缀匹配默认拒绝；**S1 解析后校验已补**（active+ 目标 DNS 解析落内网/保留段且未授权 → 拒绝） |
| **bwrap 沙箱**（审计 S2） | 同上 `SANDBOX_DISABLED` 段 | ✅ run_cli 已接 bwrap 白名单隔离（`--unshare-all --share-net`），可 `SEC_NO_SANDBOX=1` 兜底 |
| **S3/S4 守卫** | 同上 | ✅ 无 target_param 且 risk≥active → 拒绝；标量参数注入防护 |
| `asset-graph`（assets/endpoints/findings/blackboard） | [asset-db.js](../bundles/dsh/templates/dsh-plugin-sec-suite.asset-db.js) | ✅ 四表 + WAL |
| **P6 脊柱**：programs/tasks 表 + task_create/update/list/next/stats + program_list + program_id 自动回填 + orchestrator Preset | asset-db / [asset-graph.js](../bundles/dsh/templates/dsh-plugin-sec-suite.asset-graph.js) | ✅ 表与工具在；**tasks 0 行（尚无活水）** |
| **P7 补血**：parser 注册表（jsonl_httpx/jsonl_nuclei/lines_subfinder/csv_ffuf/excel_enscan）+ nuclei/afrog→findings 去重 + plan_chain 凑链 | [parsers.js](../bundles/dsh/templates/dsh-plugin-sec-suite.parsers.js) / sec-suite | ✅ 主扫描引擎命中进库率 0%→100% 的最大漏斗已堵 |
| **P8 管理增强**：facts/fact_edges/fingerprints/credentials 表 + fact_upsert/get/search/link + fp_add/cred_add + 接口鉴权建模 + finding 报告模板 + report_build(program) | asset-db / asset-graph | ✅ 表与工具在；**facts/fingerprints/credentials 均 0 行（未迁移/未启用）** |
| **P9 自学习**：neg_check（note/* 证伪拦截）+ 经验卡语义去重（cosine>0.85 合并）+ 活评测（打标→eval-live.jsonl）+ kb 语义召回 + intel_hunt（指纹→N-day 模板） | experience.js / sec-suite | ✅ |
| **P10 合规**：retention.sh + silksec-retention.timer（flows/results 30 天、audit 50MB 轮转，timer enabled 实测）；kb_import 注入扫描 + 污点标记（taintguard 等价） | retention.sh / experience.js | ✅ |
| `experience-hub`（经验卡/知识库/playbook + FTS5 + multilingual-e5-small 向量） | [experience.js](../bundles/dsh/templates/dsh-plugin-sec-suite.experience.js) | ✅ |
| `spawn_worker`（DSH headless 子进程，≤4 并发，只回尾部） | sec-suite | ✅ cwd=results/<run_id>/（**P11 改为工作区路径，见 §五**） |
| `authz_diff`（双会话重放 + diff，scope 门正确） | sec-suite | ✅ |
| 看板（Dashboard）：全局入口 sidebar.footer.action → Modal 四视图（漏洞/资产/事实/任务），服务端分页/搜索/筛选 + 30s 轮询，打标 + 事实纠正双写，丝之歌主题 | [sec-dashboard.client.js](../bundles/dsh/templates/dsh-plugin-sec-dashboard.client.js) + sec-suite `/silksec-dashboard` RPC | ✅ 已上线；**无跳转、无工作区维度（P11 补）** |
| 代理池（mubeng:8899）/ dsh-bill / auth-gate / model-failover / dsh-browser(fork) / 主题 | plugins.lock / profile | ✅ |
| Vulhub 靶场 + eval-run.js 回归 / intel-refresh timer | eval/intel | ✅ |
| 多供应商路由（pi-ai 底座）+ 两级熔断 | settings.yaml + model-failover | ✅ |
| **定时任务** | — | ❌ 无（tasks 无调度字段；dsh-schedule 未组合）→ §五 |
| **run→session 映射 / 看板跳转** | — | ❌ 无 → §六 |
| **egress-guard 网络层出口白名单**（审计 S3 兜底 / S9 运行期） | plugins.lock PENDING | ❌ 未装（P11 尾项或 P12） |
| **chicheng-push 手机推送**（HITL 到手机） | plugins.lock PENDING | ❌ 未装 |
| **auth-gate 挪 Authelia forward-auth**（审计 S6） | — | ❌ 未做（公网仅密码认证） |

### 1.2 数据规模实测（2026-08-22，可复现）

| 表 | 行数 | 分布 |
|---|---|---|
| assets | 692 | meituan-src 399 / `_legacy` 287（含字节 117）/ vulhub 6 |
| endpoints | 279 | `_legacy` 235 / vulhub 27 / meituan-src 17 |
| findings | 59 | meituan-src 33 / `_legacy` 26（含字节 1） |
| blackboard（遗留） | **970** | `import:*` 967（美团SRC 401 / 字节SRC 566）+ alive 2 + note 1 |
| **facts / fact_edges** | **0 / 0** | 表已建、工具已上、视图已有——**空转，待迁移（§七）** |
| programs | 2 | vulhub / meituan-src（**无 bytedance，scope.yml 未登记**） |
| tasks | **0** | 表已建、工具已上——**无活水** |
| fingerprints / credentials | 0 / 0 | 表已建（P9 intel_hunt 上线后有活水来源） |
| DSH workspaces | 2 | 美团SRC（path `/home/silkspool/美团SRC`，3 会话）/ 字节SRC（path `/home/silkspool/字节SRC`，1 会话），另有 results//tmp 下的 headless 会话未分组 |

### 1.3 DSH rc.7 原生能力组合实况（核实到包级）

| 能力包 | 组合状态 | 对 P11 的意义 |
|---|---|---|
| `dsh-workspace`（`ctx.workspaceRegistry`：create/list/resolveByPath/attachSession，按会话 header cwd 归组） | ✅ **已组合**（dsh-web-app 依赖），数据在 `data/storages/workspace.json` | 工作区融合的数据源，host 面直接可用（§四） |
| `dsh-client-ui-workspace` + 客户端 `workspaces`/`sessions` 服务 | ✅ 已组合 | 看板 client 可 `inject: ['slots','sessions']`，`ctx.sessions.open(id)` 跳会话（官方 workflow-run 面板同款机制，§六） |
| `dsh-jobs` / `dsh-jobs-local` / `dsh-tool-jobs`（`ctx.jobs` 后台作业注册表，SessionId 属主隔离） | ✅ 已组合（dsh-base） | 调度执行可登记为 job，UI/审计可见（§五） |
| `dsh-schedule`（agent 作用域持久提醒：schedule_create/list/delete；after/at/every_seconds≥300s） | ⚠️ **pnpm store 有包但未组合进任何 profile** | 语义是「会话内提醒」（session-local 投递，冷会话不触发），**不适合做任务调度载体**；可作会话提醒可选补齐（§五.4） |
| `dsh-session-query-sqlite`（trajectory FTS） | ✅ 已组合（dsh-base） | 复盘/检索底座（已在用） |
| 工具执行上下文 `ToolRunContext extends ToolExecution`（`exec.agent: Agent`，`Agent.id === SessionId`） | ✅ rc.7 已具备 | run→session 映射的捕获点（§六.2） |

### 1.4 DSH / pi / CyberStrikeAI 定位结论（v5 保留，不变）

- **DSH**：主框架。领域实体（program/task/finding/fact）自建持久层（SQLite），编排/审批/检索/LLM/UI/工作区复用 DSH 底座。
- **pi**：`pi-ai` = LLM 路由底座（已是 DSH 的 `dsh-llm-pi-ai`）；`pi-coding-agent` = 工程师本机工具；`pi-agent-core` = 未来多机 worker 备选（当前 spawn_worker 走 DSH headless）。无 pi-bridge，无双轨。
- **CyberStrikeAI**（已退役，数据在 `data/import-staging/cyberstrikeai/`）：只借鉴设计——Project 作用域、事实图谱、orchestrator 交接包纪律、vulnerabilities 即报告模板。其前端看板体验已由我们自建 DSH 看板复刻。

### 1.5 合规护栏真实状态对照（审计 S1–S9 校准，详见附录 B）

| # | 护栏 | 状态（2026-08-22） |
|---|---|---|
| 1 | scope 字面校验 | ✅ |
| 1b | scope 解析后校验（S1） | ✅ 已补（DNS 解析落内网/保留段且未授权 → 拒绝） |
| 2 | 风险四级 | ✅ |
| 2b | bwrap 沙箱（S2） | ✅ run_cli 已接 |
| 3 | 全量审计可回放 | ✅（+ audit 50MB 轮转） |
| 4 | 出口 mubeng ✅ / egress-guard 白名单 | ⚠️ egress-guard 仍 PENDING |
| 5 | auth-gate | ✅ 生效；**S6 公网仅密码认证未改**（Authelia 未接） |
| 6 | 注入防护（S8） | ✅ 等价落地（kb_import 注入扫描 + 污点标记） |
| 7 | 流量保留期/轮转（S7） | ✅ retention.timer enabled（flows/results 30 天） |
| 8 | 供应链先扫后装+pin+hash | ⚠️ 安装期✅ / 运行期❌（待 egress-guard） |
| 9 | 仅限授权测试 | ✅ fail-closed |
| + | `.env` 600（S5） | ✅ 实测 `-rw-------` |
| + | S3 守卫 / S4 参数校验 | ✅ 已落地 |

---

## 二、两个核心能力目标（不变，v5 保留）

**目标一：使用体验**——北极星：新 SRC 项目 → 首份可审报告 ≤ 3 次点击/一条命令；人工判断环节可手机放行。P11 新增：**对话里说「定时跑」立即在看板可见可管；看板万物可跳回来源会话；项目=工作区单一概念**。

**目标二：发现漏洞的能力**——四类象限（A 技术栈扫描 / B 越权业务逻辑 / C 代码审计供应链 / D 情报驱动）+ 四层深度（广度/深度/智能/评测）。P7 已堵最大漏斗（主引擎命中进库）；P11 不做新引擎，做**治理与数据收口**。

---

## 三、总体架构（v6 更新：工作区融合 + 调度器）

```
Workspace（DSH 工作区：目录 + 会话组 + 文件，UI/会话面）
   │ 1:1 映射（programs.workspace_id）
Program（SRC/HW 授权项目，真相源=scope.yml，scope-guard 硬校验）
   │ 1:N
Task（任务：队列/优先级/依赖/预算/HITL + 【P11】定时调度 schedule_*）
   │ 1:N                    ▲ 调度循环（sec-suite host，SQLite 事务认领，60s tick）
Run（run_cli / spawn_worker(cwd=workspace) / authz_diff，全量落盘 results/<id>/，
   │  【P11】记 session_id——「谁跑出来的」可回溯）
   │ 证据
   └──▶ 事实图谱黑板（facts + fact_edges，【P11】承接 970 条遗留 blackboard 迁移）
              ▲
   看板（全局 Modal）── 漏洞 / 资产 / 事实 / 任务四视图
        【P11】行级跳链 ctx.sessions.open(session_id)，详情一律在会话里看
```

**不变的核心原则**：工具调用只有一条路 `sec-cli-adapter → 本机 CLI`；浏览器只有一条路 `dsh-browser → 流量总线`；能力一律 CLI/插件接入、**不挂 MCP**；数据外置 `/opt/silkspool/dsh/data/`；写路径复用同一份 assetDb 校验 + 一条 audit.jsonl。

---

## 四、工作区融合：Program ↔ Workspace（需求 3/5）

### 4.1 核心决定

> **「项目」从此只有一个用户可感概念：DSH 工作区（Workspace）。** Program 降级为 scope-guard 的授权真相与数据外键，看板不再单列「项目」视图/区块，以工作区为呈现主体。

| 层 | 实体 | 职责 | 真相源 |
|---|---|---|---|
| 用户可感 | **Workspace**（DSH 自带） | 目录 + 会话组 + 文件；开会话、存报告、沉淀上下文都在这里 | `ctx.workspaceRegistry`（`data/storages/workspace.json`） |
| 授权与数据 | **Program**（scope.yml） | fail-closed 白名单、风险上限、代理策略；资产/漏洞/事实/任务的外键 | `scope.yml` → programs 表镜像 |

- **映射关系 1:1**：`programs` 表加 `workspace_id` / `workspace_path`。配对规则：显式映射表优先，标题模糊匹配兜底（美团SRC↔meituan-src、字节SRC↔bytedance），人工可改。
- **fail-closed 不变**：新建 DSH 工作区 ≠ 自动授权。授权仍需在 scope.yml 显式登记 program；无 program 绑定的工作区在 scope-guard 眼中依然是「全拒绝」。
- **看板里的「项目」去掉**：任务视图的「项目」区块改为「工作区」区块（数据源 workspaceRegistry，program 显示为徽章）；KPI「项目」卡改为「工作区」；各视图的 program 筛选器改为工作区筛选器（底层仍过滤 program_id）。
- **强关联但可未关联（需求 5）**：绑定键**仍是单一 `program_id`**（经 program↔workspace 映射即得工作区，不加第二外键，防双轨漂移）。`program_id IS NULL` = 「未关联」展示组，合法存在（临时探索/未定归属的数据）；`_legacy` 在 P11 存量重关联后逐步清零，清零后剩余的才算真正「未关联」。

### 4.2 数据模型变更（全部 ALTER ADD COLUMN 可空，幂等，不重建表）

```sql
ALTER TABLE programs ADD COLUMN workspace_id   TEXT;   -- DSH workspace UUID
ALTER TABLE programs ADD COLUMN workspace_path TEXT;   -- 镜像，免查 registry
-- tasks 调度字段见 §五.2；findings/tasks 的 session_id 见 §六.2
```

### 4.3 存量重关联（一次性，幂等脚本）

1. **字节补授权（步骤 0，需用户确认）**：scope.yml 登记 `bytedance` program。域名清单从存量资产反查候选：`*.douyin.com / *.bytedance.com / *.volcengine.com / *.dypay.douyin.com …`（以 sqlite 实测 host 列表为准，**逐域核对字节 SRC 授权范围后登记**——这是合规红线，不自动补）。
2. 重启/sec-suite 重载 → `syncPrograms()` 镜像入库 → 显式映射绑定 字节SRC workspace ↔ bytedance、美团SRC workspace ↔ meituan-src。
3. 重跑 `backfill-program.js`：`_legacy` 的 117 字节资产 / 1 漏洞 / 566 黑板事实（经 §七迁移后作用于 facts）按 checkTarget 归位 bytedance；美团残余同理归位。

---

## 五、定时任务（需求 1）

### 5.1 直接回答：当前不行

对话里说「定时跑 X」**不会**出现在看板任务里，三个原因：① tasks 表无调度字段，task_create 不接收时间参数；② DSH 自带 `dsh-schedule`（schedule_create/list/delete）**未组合进任何 profile**，agent 根本没有定时工具；③ 即使组合 dsh-schedule，它的语义是「**会话内提醒**」（durable reminder 以 user-role 消息投递到**原会话**，冷会话不触发、不写 tasks 表），看板依然看不到。

### 5.2 方案：sec-suite 内建持久调度器（任务=定时任务）

**设计定调**：Task 即调度单元。普通任务 = 无调度的 Task；定时任务 = 带调度字段的 Task。同一张表、同一个看板视图、同一套状态机。

```sql
ALTER TABLE tasks ADD COLUMN schedule_kind TEXT;        -- NULL=普通 / once / interval
ALTER TABLE tasks ADD COLUMN run_at INTEGER;            -- once：到期时间戳
ALTER TABLE tasks ADD COLUMN every_seconds INTEGER;     -- interval：间隔（≥300，对齐 dsh-schedule 下限）
ALTER TABLE tasks ADD COLUMN next_run_at INTEGER;       -- 调度循环扫描键
ALTER TABLE tasks ADD COLUMN last_run_at INTEGER;
ALTER TABLE tasks ADD COLUMN last_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(schedule_kind, next_run_at);
```

- **工具**：`task_create` 增加可选 `schedule` 参数（`{kind:'once', at}` / `{kind:'interval', every_seconds}`）；新增 `task_schedule`（改调度/暂停/恢复）、`task_run_now`（立即触发一次，不动调度节律）。
- **调度循环**（sec-suite host 面）：`setInterval(60s)` 扫描 `next_run_at <= now` 的 queued 任务 → **SQLite 事务原子认领**（`UPDATE … SET status='running' WHERE id=? AND status='queued'`，防重启发疯重复派单）→ 复用 spawn_worker 机器跑 objective。
- **执行落点（关键改动）**：worker 子进程 **cwd 设为 program 绑定的工作区路径**（当前是 results/<run_id>/）→ headless 会话 header cwd = workspace path → `workspaceRegistry.attachSession` 自动归组 → **定时任务的执行会话天然挂在工作区下，看板可跳转（§六）**。
- **收尾**：worker 退出 → 更新 last_run_at/last_run_id/result 尾部摘要 → interval 任务计算下一次 next_run_at（**错过不补跑**，latest-only，对齐 dsh-schedule 语义）→ status 回 queued；once 任务 done 后不再调度。
- **边界与纪律**：DSH 服务停则停跑，重启后调度循环从 SQLite 恢复（过期的 interval 只补触发最近一次）；**intrusive 级 objective 禁止 interval**（人工断点铁律不变）；worker 并发仍 ≤4，到期撞车按 priority 排队。

### 5.3 对话路径（「说一句话就进看板」）

更新 orchestrator Preset + sec 相关 Skill 纪律，写死一条：

> 用户意图含「定时/每隔/每天/每小时/定期/复扫节奏」→ **必须** `task_create(program_id, objective, schedule=…)`（归属当前工作区映射的 program），**不得**只在会话里口头答应。创建即见看板。

Agent 默认从当前会话 cwd → workspaceRegistry → program 映射**自动带出 program_id**，用户不说项目也不丢归属。

### 5.4 dsh-schedule 的定位（可选，不挡路）

dsh-schedule 可在后续作为「**会话内提醒**」补齐（组合进 web profile 即可用），用于「半小时后提醒我确认某结果」这类人向提醒；**任务调度不走它**（session-local 投递 + 冷会话不触发 + 不写 tasks，三条都不满足看板可见性）。

---

## 六、看板 v2：万物可跳，详情在会话（需求 2）

### 6.1 run→session 映射（一切跳链的地基）

- rc.7 工具执行回调签名是 `execute(args, exec: ToolRunContext)`，`exec.agent.id === SessionId`。**现状我们的 handler 只吃第一个参数，没捕获**。
- 改动：`runCli / spawnWorker / authz_diff` 的 execute 改收 `(args, exec)`，把 `exec?.agent?.id` 写进：① `results/<run_id>/meta.json` 加 `session_id`；② audit.jsonl 同记；③ findings 加列 `session_id`（addFinding 透传当前 run 的会话）；④ tasks.session_id 执行时回填（列已存在，一直空着）。
- 存量：meta.json 无 session_id 的老 run 不强求回填（当时未记录，无法复原），新数据 100% 带。

### 6.2 看板跳链（client 面）

- 插件 `inject` 从 `['slots']` 扩为 `['slots', 'sessions']`；跳转用 `ctx.sessions.open(sessionId)`——**官方 workflow-run 面板跳子会话的同款机制**，rc.7 已验证存在。
- 落点：
  - 漏洞/资产/事实/任务各行：有 session_id 的显示「来源会话」链，点击跳该会话；任务行同时显示 last_run_id 对应会话。
  - 工作区区块：点击工作区 → 列出其会话（新 RPC `sessions`，从 workspaceRegistry.sessionIds + sessionPersistence 头部投影 title/updatedAt）→ 点会话跳转。
  - 无 session 的行（导入数据/老数据）显示「—」，不造假链。
- **信息架构纪律**：看板行只放摘要 + 跳链；**详细内容（完整证据/报告/日志/对话过程）一律在会话里看**——看板不内嵌长详情，避免全局/会话双面职责漂移。

### 6.3 Host 面新 RPC（`/silksec-dashboard` 增量）

| 端点 | 数据 | 说明 |
|---|---|---|
| `workspaces` | `ctx.workspaceRegistry.list()` + 每个 workspace 绑定的 program/资产数/漏洞数/会话数 | 工作区区块数据源 |
| `sessions` | 按 workspace 过滤的会话清单（id/title/updatedAt） | 跳链前的选择列表 |
| 现有 findings/assets/facts/tasks | 增返回 `session_id`、`workspace_id` | 行级跳链字段 |

---

## 七、事实迁移：blackboard → facts（需求 4）

### 7.1 可用性结论

**事实黑板可用，直接导。** 依据：facts/fact_edges 表已建（v5 §5.3 schema 原样落地）；fact_upsert/fact_get/fact_search/fact_link 工具已上线；看板事实视图 + `/silksec-dashboard` 的 facts RPC + factCorrect/factDeprecate 写通道已上线。缺的只是数据——970 条旧事实在遗留 blackboard 表里。

### 7.2 迁移脚本 `migrate-blackboard-to-facts.js`（幂等，可重跑）

| blackboard key 形态 | facts 落点 |
|---|---|
| `import:美团SRC:<cat>/<slug>`（401 条） | program_id=`meituan-src`，category 取 `<cat>`（asset/infra/recon/target→对应类；未识别→`note/`），fact_key=`<cat>/<slug>` |
| `import:字节SRC:<cat>/<slug>`（566 条） | program_id=`bytedance`（依赖 §4.3 步骤 0 先登记），同上 |
| `alive:*` / `note:*`（3 条） | program_id 由 checkTarget 反查，归 `note/` |
| value 全文 | `body`（完整可复现上下文）；`summary`=首行截 120 字（注入 prompt 的索引） |
| confidence | 一律 `tentative`（导入未验证，人工确认后升 confirmed）；source=`import:cyberstrikeai` |

- 幂等：PRIMARY KEY (program_id, fact_key) 冲突即更新 updated_at，不复制不膨胀。
- 迁移后验证：facts 计数 ≥970、抽样 fact_search 召回正确、看板事实视图可见 → **保留 blackboard 只读 30 天观察期** → 撤掉看板「旧版扁平黑板」只读区块；`blackboard_set/get` 兼容薄封装（写 note/）保留不动。

---

## 八、P11 执行计划（可操作清单）

> 每步「做什么 / 改哪 / 怎么验收」。顺序执行，每步独立可验证、可回滚。

### 步骤 0：字节授权登记（前置，需用户确认，合规红线）

- 做什么：从存量资产反查字节域名候选清单 → 逐域核对字节 SRC 授权范围 → scope.yml 登记 `bytedance` program（含 exclude/max_risk）→ 服务重载让 syncPrograms 镜像。
- 验收：`program_list` 见 bytedance；`run_cli` 对 *.douyin.com 目标不再 fail-closed 拒绝。

### 步骤 1：工作区融合

- 改哪：asset-db.js（programs 加 workspace_id/workspace_path）；sec-suite.js（syncPrograms 配对逻辑 + `workspaces`/`sessions` RPC）；sec-dashboard.client.js（任务视图「项目」区块→「工作区」区块、KPI 卡改名、筛选器换工作区维度）。
- 验收：看板工作区区块列出 美团SRC/字节SRC 且各带 program 徽章与资产/漏洞计数；美团SRC↔meituan-src、字节SRC↔bytedance 绑定正确。

### 步骤 2：定时任务

- 改哪：asset-db.js（§5.2 ALTER + taskCreate/taskSchedule）；asset-graph.js（task_create 加 schedule 参 + task_schedule/task_run_now 工具）；sec-suite.js（调度循环 + worker cwd=workspace path）；seed-presets/seed-skills（§5.3 纪律）。
- 验收：对话里说「每小时对美团 SRC 跑一次存活复核」→ 看板任务视图立即出现该任务（schedule 徽章 + 下次运行时间）；到期自动跑、结果会话归工作区、interval 续期正确；重启服务后调度恢复不丢不重。

### 步骤 3：跳链

- 改哪：sec-suite.js（三工具 execute 捕获 `exec.agent.id` → meta/audit/findings.session_id/tasks.session_id 回填；RPC 返回增字段）；sec-dashboard.client.js（inject sessions + 行级跳链 + 工作区→会话列表→跳转）。
- 验收：新跑一条 run_cli 产生的 finding 带 session_id；看板点「来源会话」跳进该会话；老数据显示「—」不造假。

### 步骤 4：事实迁移

- 改哪：新增 `migrate-blackboard-to-facts.js`（§7.2）+ 看板撤旧黑板区块（观察期后）。
- 验收：facts ≥970 行；抽样检索正确；看板事实视图按工作区筛选正确。

### 步骤 5：存量重关联收尾

- 改哪：重跑 backfill-program.js（字节/美团归位）；复核 `_legacy` 剩余 → 真未关联的转入「未关联」展示组。
- 验收：assets/findings/endpoints 的 `_legacy` 清零或仅剩确无归属项；看板按工作区统计与 sqlite 实测一致。

### 尾项（P11 后，沿用原 P10 遗留）

- egress-guard（S3 兜底/S9 运行期）、chicheng-push（HITL 到手机）、auth-gate 挪 Authelia（S6）——三件未变，排入下一迭代。

---

## 九、验收标准（汇总）

| 能力 | 验收指标 |
|---|---|
| 定时任务 | 对话说「定时跑」→ 看板立即可见；到期自动执行；执行会话归工作区；重启不丢不重 |
| 跳转 | 看板四视图行级可跳来源会话；工作区→会话→跳转链路通；详情只在会话看 |
| 工作区融合 | 「项目」单一概念=工作区；program 徽章化；新建工作区不自动授权（fail-closed 不变） |
| 事实迁移 | 970 条旧事实进 facts；检索/纠正/废弃通道正常；旧黑板只读观察后下线 |
| 强关联 | 资产/漏洞/接口/事实按工作区可归因；`_legacy` 清零；允许合法「未关联」组 |
| 合规 | scope 显式登记红线不破；audit.jsonl 单一路径；intrusive 不进 interval 调度 |

---

## 十、风险与取舍

- **工作区映射是 1:1 软绑定**：workspace 删除（registry delete 不动会话/目录）会让 program 失去 UI 面——programs 行保留、显示「工作区已删」，重新登记同路径产生新 UUID 需重新绑定（映射表幂等更新）。
- **调度器自建于 sec-suite**：DSH 升级不冲击（只用 spawn/SQLite/setInterval，无内部 API）；代价是不复用 dsh-jobs 的 UI 可见性——后续可将执行登记进 `ctx.jobs` 增强可观测（增量，不挡 P11）。
- **worker cwd 改工作区路径**：headless 会话开始按工作区归组（这正是目的），但 results/<run_id>/ 落盘路径不变（输出仍集中管理）；worker 在工作区目录写文件不受限——由 scope-guard + 沙箱兜底。
- **事实迁移的 confidence 一律 tentative**：宁可全部降级也不让导入数据冒充已验证——人工/工具复核后升 confirmed。
- **诚实红线不变**：合规护栏「未落地就标未落地」（egress-guard/Authelia/手机推送三件仍 ❌，见 §1.5）。
- **看板依赖 rc.7 内部 API**：slot/api-remotes/客户端 sessions 服务是预览内部面，由 pin + shim 纪律兜底，最坏重写 client 薄层，数据层不动。

---

## 附录 A：P0–P5 落地历程（权威历史，压缩自 v3）

> 完整叙事见 git 历史中的 `doc/dsh-pi-secagent-plan.md`（v3）。此处保留里程碑与关键踩坑。

**里程碑**（2026-08-20 ~ 08-22）：

| 阶段 | 交付 | 验证 |
|---|---|---|
| P0 底座 | `bundles/dsh` 落地 csai（`spool bundle dsh setup/up` 一条链） | Web UI 200；setup 幂等；dsh-upgrade 备份+冒烟+回滚 |
| P0.5 插件治理 | 先扫后装 + plugins.lock（pin+hash） | auth-gate/model-failover/dsh-browser/dsh-bill PASS |
| P1 工具链 | sec-cli-adapter + scope-guard + 18 manifest 种子 + burp_import | 单测 7/7；subfinder 端到端 23363 行→20 行摘要 |
| P2 融合层 | spawn_worker（≤4 并发）+ dsh-browser + token 账本 | 压缩比 1146x；pi-bridge 判定不需要（DSH headless + pi-ai 底座已覆盖） |
| P3 流水线 | asset-graph 四表 + xray 流量总线（webhook→findings）+ authz_diff + 3 Skill | 越权 diff 实测通过；26 工具/22 manifest 装齐 |
| P4 学习闭环 | experience-hub（经验卡 FTS5+向量/kb/playbook-ranker）+ intel.timer | 单测 8/8；语义检索零关键词重叠命中（0.89） |
| P5 运营 | finding 状态机 + report_build + dsh-bill + 字节导入 | 美团 SRC 首跑：14 存活复核 + 2 新发现（id 58-59） |
| P6–P10 | 见 §1.1（脊柱/补血/管理增强/自学习/合规补齐） | 全部落地并部署验证 |
| 看板 | 全局入口四视图 + 丝之歌主题 | ADR-0002/0003 |

**关键踩坑（复用价值高）**：

1. **DSH 依赖必须用 pnpm**（npm 解析卡死，pnpm 14 秒）；rc.7 无 `--no-open`，systemd 下显式 `--host/--port`。
2. **link: 安装的插领取不到 peer 依赖 → 自研插件零依赖**；`dsh plugin` 子命令必须显式传 `DSH_HOME` 和 pnpm PATH，否则误建 `~/.dsh`（「工具不可见之谜」的根因：手工 headless 必须 `DSH_HOME=/opt/silkspool/dsh/data`）。
3. **rc.7 强制 loopback 绑定 + 特权 API 钉死 loopback + 校验 `Origin.host===Host.host`**：边缘代理用 Caddy 同步改写 Host **和 Origin**；curl 不带 Origin 会造成「已修复」假阳性——验收必须带 Origin/Sec-Fetch-Site 的 POST + WebSocket 升级测试；Caddy 站点地址不匹配 Host 会静默回空 200（通配站点 `http://:3080` 解决）。
4. **xray 被动扫描 pin `chaitin/xray@1.9.11`**（新版已变 xpoc 无被动模式）；xray 只从可执行文件旁读主配置（ExecStartPre 安装 xray.yaml 到 /usr/local/bin/）。
5. **FTS5 unicode61 对中英文混排整串成词**，必须逐词 LIKE 兜底。
6. **dsh-sentinel@0.11.0 的 client.js 会让 Web UI 插件加载失败**（已移除，BLOCKED 入锁）；事件触发由 silksec-intel.timer + xray webhook 承担。
7. **istoreos 的 Caddyfile 是单文件 bind mount**，sync push 替换 inode 后容器内看到旧文件，必须 `docker restart caddy`。
8. headless 会话产出最终报告后进程可能不退出（空转需人工清）；LLM 流式偶发挂起需看门狗（failover 只认显式失败）。

---

## 附录 B：安全审计发现清单（2026-08-21 审计 + 2026-08-22 修复状态）

> 审计方式：运行时实测（服务/端口/权限/认证）+ 自研插件源码通读 + rc.7 依赖盘点。核心判定「文档声称的防护强度 > 代码实际强度」已通过 P10 修复 + §1.5 真实状态标注收敛。证据索引（文件:行号）见 git 历史中的原审计报告。

| 编号 | 等级 | 发现 | 修复状态（2026-08-22） |
|---|---|---|---|
| S1 | 🔴 高 | scope-guard 只有字面校验，无 DNS/重定向/回调解析后校验 | ✅ 已补：active+ 目标 DNS 解析落内网/保留段且未授权 → 拒绝 |
| S2 | 🔴 高 | run_cli 裸 spawn 无沙箱（bwrap 装了没用；rc.7 自带 dsh-sandbox） | ✅ 已接 bwrap 白名单隔离（`--unshare-all --share-net`），SEC_NO_SANDBOX 兜底开关 |
| S3 | 🟠 中 | scope 强制完全依赖 manifest `target_param`，无网络层兜底 | ✅ 守卫已加（无 target_param 且 risk≥active → 拒绝）；⚠️ egress-guard 网络层兜底仍 PENDING |
| S4 | 🟠 中 | 参数注入（非 RCE，可注入危险 flag） | ✅ 标量参数类型校验已落地 |
| S5 | 🟠 中 | `.env` 权限 644 全局可读 | ✅ 实测 600，setup 固化 |
| S6 | 🟠 中 | 公网暴露 + 仅密码认证，无锁定/MFA | ❌ 未改（auth-gate 单 admin 密码）；计划挪 Authelia forward-auth / Caddy 层 IP 白名单+fail2ban |
| S7 | 🟡 低 | 流量/结果明文留存，无保留期与加密 | ✅ retention.sh + silksec-retention.timer（flows/results 30 天、audit 50MB 轮转）enabled 实测；加密未做（本地留存，风险接受） |
| S8 | 🟡 低 | taintguard 注入防护未装 | ✅ 等价落地：kb_import 注入扫描 + tainted 污点标记（kb_search 返回标注） |
| S9 | 🟡 低 | 供应链仅安装期静态扫描，无运行时约束 | ⚠️ 部分：安装期纪律在执行；运行期出口约束待 egress-guard |
| 运营 | 🔵 | cyberstrikeai.service 残留 / sentinel.lease / audit 无轮转 | ✅ 已清理 / 已清理 / 已轮转 |

**审计确认的正面样板（保持）**：authz_diff 执行前 checkTarget + 硬 deny 门 + `redirect:'manual'`；argv 而非 shell（无命令注入 RCE 面）；fail-closed 默认拒绝 + 排除清单；全量落盘 + ≤20 行摘要 + grep/page 按需取；非 root 运行 + settings.yaml 600 + apiKeyEnv 零明文。

---

*本文档为 v3 落地历史 + 安全审计 + v5 优化设计的合流终版（v6），以 2026-08-22 实测校准。v6 新内容：§四 工作区融合、§五 定时任务、§六 看板跳链、§七 事实迁移、§八 P11 执行计划。全部增量、可回滚、数据无损。*
