# SilkSecAgent 全面检查报告（2026-09-19）

> 检查对象：csai 主机上的 SilkSecAgent（DSH 授权范围内漏洞发现平台）
> 检查范围：文档体系（doc/secagent 00–18）→ 代码实现（`bundles/dsh/templates/` 与 csai `/opt/silkspool/dsh/`）→ 功能流程 → 运行态与数据质量 → 漏洞产出 → 执行历史 → 界面/插件
> 检查方式：只读。远程经 `spool exec csai`；代码本地/线上逐文件 md5 比对；数据库用 sqlite3 / node better-sqlite3 只读查询；UI 单测 `node --test`。
> 运行基线：DSH **0.1.5-rc.2**，`silksecagent` active / NRestarts=0，14 域 registered，DB `asset-graph.db` 62 MiB。
> 本报告为临时专项文档；结论回填对应正式文档后应移入 `archive/` 并标注（见 [README.md](README.md) 文档治理规则）。

---

## 一、执行摘要

平台整体**运行健康、架构清晰、文档密度高**，文档标注「未实现/设计预留」的习惯在同类系统中罕见，值得肯定。但本次检查确认了若干**必须优先处理的实质问题**：

| 级别 | 问题 | 证据 |
|---|---|---|
| 🔴 严重 | **exec 域 risk 闸只按 `targets[0]` 的项目配置判定**，多目标可跨项目放行高 risk 工具 | `dsh-plugin-sec-domain-exec.js:621-623`（已复现核对） |
| 🔴 严重 | **exec 域 exclude 判定与 scope 域规范实现语义相反**，可绕过 exclude 放行 | `exec.js:519-529` vs `scope.js:122-140`（已核对） |
| 🔴 严重 | **asset 域 scope 自查 fail-open**：program 不存在时直接放行 | `dsh-plugin-sec-domain-asset.js:341-357`（已核对） |
| 🔴 严重 | **漏洞产出闭环断裂**：43 条 confirmed 全部 `submitted_at/remote_id` 为空，0 条提交 SRC | 线上 DB 实测 `43|0`（已复现） |
| 🟠 高 | `asset_grade` 写不存在的 `owner` 列，带 owner 的调用必然失败 | 本地代码 + 线上 `PRAGMA table_info(assets)` 无 owner（已复现） |
| 🟠 高 | 候选池污染：316 条噪声候选放大总数，`noise` 与 `status` 生命周期脱节 | 线上 DB：`noise=1` 316 条，new 209 条 |
| 🟠 高 | 任务租约/超时缺失，出现僵尸 running；本次复查期间 3 个 running 已转 failed | tasks 状态变化 |
| 🟠 中 | 文档跨域订阅关系成片漂移（approval 被订阅方、task↔approval effect 机制、endpoint 预留订阅） | 文档审查 S1/S3/S4 |
| 🟠 中 | UI：asset 视图在 ui-core 缺席时整个 bundle 崩溃（其余 6 视图可降级） | `view-asset.client.js:40`（已核对） |
| 🟠 中 | UI：同视图 KPI 跳链不生效（pending effect 依赖数组为空） | `view-vuln.client.js:231-237` 等 |

**结论**：安全红线（scope-guard）存在 3 处可被利用的放行/绕过缺陷，属 fail-open 违背平台「fail-closed」承诺，应作为第一批修复；产出闭环与任务治理是第二批；文档漂移与 UI 健壮性是第三批。

---

## 二、系统架构与运行基线

### 2.1 服务矩阵（csai 实测）

| 服务 | 状态 | NRestarts | 内存 | 说明 |
|---|---|---|---|---|
| `silksecagent.service` | active/running | 0 | ~1.43 GiB | DSH Web UI :3080（内部 3081） |
| `silksecagent-edge.service` | active/running | 0 | 46.9 MB | caddy :3080 → 127.0.0.1:3080，Host/Origin 改写绕过 loopback 特权栅栏 |
| `silksec-xray.service` | active/running | 0 | 157.4 MB | 被动扫描 7777 → webhook 7788 |
| `silksec-shared-browser.service` | active/running | 0 | 308.3 MB | CDP 9222 常驻 |
| `silksec-proxy-rotator.service` | active/running | 3 | 24.4 MB | mubeng 网关 :8899 |
| `silksec-backup/intel/proxy-refresh/retention` | timer | — | — | 定时任务 |

- 主机：16 GiB 内存 / 831 GB 可用磁盘 / load ~7（up 40 天）。
- 端口：3080(edge)、9223(LAN browser)、9222/7777/7788/8899(loopback)。

### 2.2 数据规模（asset-graph.db，实测）

主库 62.2 MiB，WAL 39.4 MiB，`quick_check=ok`，WAL 模式。

| 表 | 行数 | 表 | 行数 |
|---|---:|---|---:|
| assets | 96,814 | findings | 377 |
| event_outbox | 15,470 | facts | 847 |
| idempotency | 3,548 | bus_subscription | 2,582 |
| endpoints | 357 | tasks | 43 |
| task_runs | 195 | workers | 258 |
| approval_requests | 22 | programs | 5 |
| exp_cards | 44 | fgs_nodes | 132 |
| kb_docs | 409 | learning_episodes | 211 |

- `assets.db` / `tasks.db` / `sec-suite.db` 均为 **0 字节残留文件**。
- `results/` 1322 个目录（265 MB），`sessions/` 201 MB，`reports/` 45 个，`evidence/` 仅 7 个 finding 子目录。
- **注意**：文档点名的 `signals` / `bus_events` / `dead_letter` / `audit` 表并不存在——`findings` 即信号/候选存储场（`noise` 区分），`dead_letter` 是 `event_outbox.status` 的取值。文档术语与库结构需对齐说明。

---

## 三、文档体系审查

详细逐模块结论见附录 A。核心问题：

### 3.1 严重

- **S1 订阅关系成片冲突**：`09-approval.md:4` 称 `approval.approved` 被 scope/task/know/fact/exec 订阅，但代码复核实际订阅方为 **fact / ledger**（`fact.js:318`、`ledger.js`），`08-scope.md`、`07-know.md`、`10-exec.md`、`05-task.md` 均声明「不订阅 / 经 decide 内同步 effect」。09:4 既多列（scope/task/know/exec）又漏列（ledger），违反 `00-conventions.md:224`。
- **S2（初查误报，已更正）**：初查曾称 Phase 4（http-remote 后端）从未实施。**复核后确认该结论错误**——`dsh-plugin-sec-backend-vuln-http.js` 已存在，且 `sec-vuln-domain-plugin-setup.sh` 组装该后端并运行 `contract-vuln-http.test.js` 契约测试，故 18-migration「Phase 0–4 已上线」属实。仅 `02-vuln.md:853`、`03-asset.md:708` 仍以「Phase 4 试点时定稿」措辞描述已实现的机制，属**文档措辞过时**（轻微），非未实现。**教训：文档审查结论必须对照 manifest/代码复核后再采信。**
- **S3 effect 机制互斥**：`05-task.md:4/431/491` 说 `approval_effects` 经 dispatcher 幂等执行、失败自动重试；`09-approval.md:438/562` 说同步 dispatch、无独立 outbox dispatcher、失败需人工 `approval_effects_retry`。09 为 owner，应以其为准回改 05。
- **S4 预留订阅写成现行**：`04-endpoint.md:305`、`10-exec.md:4` 把 vuln/ledger/dashboard 的订阅写成现行机制，但 `02-vuln.md:478`、`11-ledger.md:4` 的 manifest 无此声明。对照 `03-asset.md:416` 已正确标注「未实现/设计预留」。

### 3.2 中等/轻微

- M1 `task.finished → fgs`：05 写 sync、14 写 async（`14-fgs.md:255`）。
- M2 `11-ledger.md:411` 仍留 L0 修复前的「静默降级」旧述（05 已改）。
- M3 `17-llm-surface.md:65/144` 查询可见口径与 task 域实际不符（task_drift 等 3 个不向模型注册）。
- M4 `07-know.md:4` 头部漏列 `ledger.card_usage.logged`。
- M5 `00-conventions.md:63` 域枚举只有 13 个，漏 `endpoint`，与「14 域」口径不符。
- M6 `00-conventions.md:304` 把 `parser` 当 actor，但 actor 白名单无此项（02 已纠正为 actor=script + identity=parser）。
- M7 `15-eval.md` 缺 §1.3 的 C4 逐个详述节，违反强制骨架。
- N1 别名移除样板段在 14 个文件中逐字重复，与 README「历史只归档」冲突。
- N3 `archive/INDEX.md:13` 指向不存在的 `v5/` 路径。

### 3.3 文档治理评价

- 根目录整洁（恰为 00–18 + PROGRESS + README），archive 链接抽查全部有效。
- **但 `PROGRESS.md:14` 声称「B1–B5 文档漂移全部闭环」，本次仍发现 S1/S3/S4/M1/M2/M3/M4 等未闭环或在回退**——说明漂移排查结论过期，或回流未受门禁拦截。
- 建议：把「跨域订阅声明」与「Phase 完成度」纳入文档 CI 门禁，防止再次漂移。

---

## 四、代码实现审查

详细清单见附录 B。所有 `dsh-plugin-sec-*.js` 本地与线上 **md5 完全一致**（无漂移）；`.sh/.py` 的 md5 差异经 `{{BASE_DIR}}` 归一化后消失。线上多一个孤儿文件 `dsh-plugin-sec-suite.parsers.js`（无任何 import，旧版残留，建议清理）。

### 4.1 严重（安全红线）

**H1 · exec risk 闸只取首目标项目**
`dsh-plugin-sec-domain-exec.js:621-623`
```js
const firstChk = targets.length ? checkTarget(targets[0]) : { programCfg: null }
const riskChk = checkRisk(String(manifest.risk || 'passive'), firstChk.programCfg, toolName)
```
每个目标都做了 scope 白名单校验，但 `allow_intrusive_tools` / `max_risk` 只按 `targets[0]` 的项目判定，工具却对全部目标执行。**一个 intrusive 工具只要首目标落在已放行项目，就能顺带打另一个未放行该工具的项目**；findings/events 也一律归到首目标项目。
**修复**：对每个目标用其自身 `programCfg` 分别 `checkRisk`，全部通过才执行；或要求所有目标同属一个 program。

**H2 · exec exclude 判定 fail-open**
`dsh-plugin-sec-domain-exec.js:519-529`：逐项目「先看本项目 exclude，再看本项目 scope」，命中 scope 立即 `allow`。
`dsh-plugin-sec-domain-scope.js:122-140`（规范）：**先遍历所有项目检查全部 exclude，命中即拒**；再查 scope。
**影响**：主机被 A 项目 exclude、同时被 B 项目 scope 覆盖且 B 在 `scope.yml` 排前时，exec 会放行——与规范语义相反。
**修复**：exec 的 `checkTarget` 改为与 `checkTargetScope` 相同的两遍结构。

**H3 · asset 域 scope 自查 fail-open**
`dsh-plugin-sec-domain-asset.js:341-357`：`asset_upsert(_bulk)` 带 `program_id` 时，若该 program 不在 `scope.yml`，直接 `return { ok: true }` 并 log「fail-open（过渡）」。
**影响**：平台宣称 fail-closed，但「项目已撤销/拼错/伪造」场景反而放行，可用任意 program_id 污染归属。
**修复**：program 不存在时返回 `E_INVARIANT` 拒绝；域外登记须不带 `program_id`。

### 4.2 高

**H4 · `asset_grade` 写不存在的 `owner` 列**
`dsh-plugin-sec-domain-asset.js:578` 设 `set.owner` → 后端生成 `UPDATE assets SET owner = ?`；DDL/`ensureCol` 从未创建 owner 列（已用线上 `PRAGMA table_info(assets)` 确认无 owner）。
**影响**：任何带 `owner` 的 `asset_grade` 触发 `no such column: owner` 并回滚，「owner 归属标注」整体不可用。
**修复**：补 `ensureCol('assets','owner','owner TEXT')`，或移除该入参与写入。

### 4.3 中

- **M1 幂等预检在事务外**（`bus.js:1171-1184` 预检 vs `:1244` `BEGIN IMMEDIATE`）：跨进程同 key 可同时过预检，后写触发 PK 冲突被兜底为 `E_CONFLICT` 而非 replay。
- **M2 DNS 校验只查 A 记录 + TOCTOU**（`exec.js:552` 仅 `resolve4`）：IPv6 / DNS rebinding 可把已授权域名指向内网，绕过 `verifyResolved`。
- **M3 `_file` 参数与 Burp 导入构成任意文件读**（`exec.js:359-360`、`:822-825`）：`fs.readFileSync` 无路径约束，模型可读 silkspool 可读的任意文件。当前无 manifest 使用 `_file`，属潜在原语。
- **M4 `exec_grep_result` 用户正则直接编译**（`exec.js:1004`）：ReDoS 风险。
- **M5 `exec_evidence_publish` 逐文件 120ms 稳定窗**（`exec.js:955`）：十万级小文件可阻塞数小时，未限文件数。
- **M6 沙箱把 `$HOME` 读写挂入**（`exec.js:575`）：`fofa_search.sh:7` 的凭据 `$HOME/.config/fofa.conf` 及浏览器登录态在沙箱内可读写。
- **M7 每次 `getDb()` 重刷 noise**（`asset-db.js:254`）：进程重启把人工摘掉 noise 的 info finding 再次打回。
- **M8 工具安装无完整性校验**（`tools-manager.sh:86-124`）：GitHub release 直下、无 checksum/签名。
- **M9 审批 effect 重试分支不可达**（`approval.js:556` / `:653`）：`approved_effect_failed` 永不落库，死逻辑（文档 09 已承认）。
- **M10 `vuln_dedup_check` 未强制 host/vuln_type 至少其一**（`vuln-sqlite.js:206-216`）：两空时返回全表信号。

### 4.4 低 / 卫生

- 死代码：`sec-suite.js:413/714/319/360` 的 scope/approval 旧函数无调用方（看板已走总线），`suite` 版还缺 `validEntry` 校验，存在两套 scope 写路径风险。
- `dashboard-rpc.js:341` reportBuild / `:762` reports 端点 `path.join` 未走 `resolveSafe`。
- `webhook.js:21-44` 无 `error`/`aborted` 监听、无来源鉴权（仅绑 127.0.0.1）。
- `hostRoot` 两套实现（`asset-sqlite.js:309-319` vs `approval.js:55-61`）对多级后缀判定不一致。
- `task-policy.js:20-29` `every_seconds=0` 会算出 `NaN`（调用方保证 interval，原语无防护）。
- `fact-sqlite.js:218` LIMIT 默认 5000，与其它域 500 不一致。

---

## 五、功能与流程审查

### 5.1 漏洞生命周期流程

```
候选登记(register_candidate) → 信号(register_signal) → 确认(confirm) → 提交(submitted) → SRC 回执(vendor_status)
     280 事件 / noise=1 316         14 事件 / noise=0 61       7 事件 / 43 status   0 条              0 条
```

- 漏斗断点在**确认→提交**：43 条 `status=confirmed` 全部 `submitted_at/remote_id/vendor_status` 为空，`sync_state` 全空。平台「授权范围内漏洞发现」的最终交付环节未闭环。
- **状态/置信度脱节**：`status=confirmed & confidence=tentative` 27 条，`status=new & confidence=confirmed` 2 条。状态机与置信度模型未保持约束一致。
- 候选池污染：`noise=1` 316 条中 201 条仍 `status='new'`（占全部 new 的 96%）。噪声候选未经 TTL/治理即计入总量，使「377」严重虚高。

### 5.2 任务与调度流程

- tasks 43：`done 28 / queued 8 / cancelled 3 / failed 4`（本次检查期间 3 个长卡 running 已转 failed）。
- task_runs 195：`ok=1 137（70.3%）/ ok=0 58（29.7%）`。
- workers 258：`done 186 / failed 26 / killed 46`（非成功 27.9%）。
- **任务租约缺失**：先前观察到 100015/100021/100023 三条 running 卡 77 分钟、`active_run_id` 空、`budget_timeout_sec=NULL`、无 worker，属僵尸 running；`worker_reap` 只回收 worker 不回收 task。本次复查时已转 failed，说明存在非确定性回收或人工干预，缺可观测的租约机制。
- **成本/模型归因失效**：tasks 的 `provider/model/spent_tokens` 全空；findings 的 `task_id` 377/377 全空，漏洞无法回溯到任务。

### 5.3 审批流程

- `approval_requests` 22 条，5 种 kind 注册表机制成立。
- 本次报告确认：`approved_effect_failed` 状态分支死逻辑；pending effect 无自动续跑（需人工 retry），与 task 文档描述冲突（S3）。

### 5.4 事件总线

- `event_outbox` 15,470：`delivered 15,469 / dead_letter 3 / pending 1`。
- 3 条 dead_letter 与 1 条 pending 均为 `exec.run.completed`，订阅者 `vuln::exec.run.completed` 持续 `registered:0, failed:1`，retry 达 6-9 次。消费者对「部分失败」无幂等降级，导致毒消息。
- audit 中 `subscriber_failed` 45 行即此重试记录。

### 5.5 scope 授权流程

- 线上 `scope.yml`：3 个 active program（vulhub / meituan-src / bytedance），`programs` 表 5 条（active 3、archived 2）。
- **无授权时效字段**（`expires_at/reviewed_at`），无法自动发现过期授权，只有 `AUTHORITY.md` 人工复核记录。
- scope-guard 的 fail-closed 承诺被代码 H1/H2/H3 三处削弱。

---

## 六、运行态与数据质量

### 6.1 异常

1. **僵尸 running 任务**（先观察到 3 条，复查已消失）——缺租约/超时/回收。
2. **产出断点**：43 confirmed 全未提交。
3. **候选池污染**：316 噪声候选，201 条 new。
4. **外键缺失**：findings `program_id` 空 309（82%）、`task_id` 全空 377；assets program 空 151；endpoints 空 13；findings host 空 3。
5. **毒消息**：3 dead_letter + 1 即将入列。
6. **重复导入**：6 组 `host+title` 重复（cyberstrikeai 与 vuln 管线各写一份）；source 命名不统一（空 / `nuclei` / `parser:nuclei` / `nuclei:<id>`）。
7. **重启可观测性**：日志显示 04:37 插件 `scheduler.js` 模块缺失导致加载失败，当天 node 多次换 pid（4104550→…→4192766），但 `NRestarts=0`——存在非 systemd 管理的频繁重启，需排查。
8. **WAL 偏大**：39.4 MiB ≈ 主库 63%。
9. **孤立外键**：`fgs_nodes` 1 条（task_id=99999）。
10. **证据缺口**：evidence 字段 377/377 非空，但磁盘证据目录仅 7 个，字段与证据实体不匹配。

### 6.2 数据健康

- `PRAGMA quick_check = ok`；审计日志 12,574 行、0 坏 JSON。
- 命令面 top：subfinder 562、httpx 333、scheduler 244、spawn_worker 224、nuclei 218。
- `decision`：executed 1017 / allow 808 / deny 2。

---

## 七、界面 / UI 审查

UI client 单测 **114/114 全绿**；全 glob 单测 125 例 **123 pass / 2 fail**（2 个失败均非 UI，是 sec-suite 测试夹具未随打包改名拷贝 `host-compat.js`/`task-policy.js`）。UI 文件本地/线上 md5 20/20 一致。

### 7.1 架构

13 个 client bundle 正确注册到 DSH 原生信息架构（`main`/`sidebar.panellist`、`shell.overlay`、`sidebarRightTabs`、`settings.section`、`conversation.view`、`conversation.chat.assistant-actions`），无重复注册 id，各载体有独立降级视图。7 个域视图经 `viewRegistry` 装配。

### 7.2 Bug（分级）

**P1**
- **B1 asset 视图在 ui-core 缺席时整个 bundle 崩溃**：`view-asset.client.js:40` 模块求值期直接解引用 `uiCore.T.error`（已核对）；其余 6 视图均 `var T = uiCore ? uiCore.T : {}`。违背「域缺席降级不崩溃」。
- **B2 同视图 KPI 跳链不生效**：`panel.client.js:138-148` 仅 `setPending+setActiveId`，当前视图不重挂；视图消费 effect 依赖数组为空（`view-vuln.client.js:231-237`、`view-asset.client.js:302-308`）。

**P2**
- B3 报告视图 `new Date(r.mtime).toISOString()` 非法值抛 `RangeError`；`size` 缺失显示 NaN（`view-report.client.js:71-72`；`view-know.client.js:266` 同类）。
- B4 知识全景图 `Object.keys(factOv.byCategory)` 未防御（`view-know.client.js:206`）。
- B5 报告阅读器 `open()` 无序号守卫，快速切换会内容错配（`view-report.client.js:118-125`）。
- B6 授权设置工作区下拉值（`db.workspace_id`）与徽章数据源（`workspace`）不一致（`ui-settings-scope.client.js:153-158/224`）。
- B7 把组件当普通函数调用（`view-know.client.js:269` `RulesSection`、`view-task.client.js:617` `HistoryBlock`），Rules of Hooks 隐患。
- B8 降级态双入口叠加（`panel.client.js:85-95` + `:151-158`），旧宿主窄场景「降级 tab + Modal」双开。

**P3**
- B9 `view-vuln.client.js:137` `silksec-btn-danger` 无 CSS 定义；accept 门禁只扫 `className:` 字面量，变量类名漏检。
- B10 审批/任务/会话首帧无骨架屏，加载即显示「空」。
- B11 面板子查询错误静默吞掉（仅展示 `statsState.error`）。
- B12 任务队列同时渲染 Table 与 Cards 靠 CSS 二选一，白做一倍 DOM。
- B13 审计展开态以数组下标为 key，轮询刷新后位置漂移。

### 7.3 测试覆盖

- 覆盖：注册契约、纯函数/常量、一次性渲染探针、零颜色字面量 grep。
- **未覆盖**：状态迁移与重渲染（假 `useState` setter 为 noop）、`useEffect` 副作用（轮询/pending/fetch 竞态）、事件交互、真实 DOM/焦点/键盘、a11y、B1–B13 全部问题。
- 建议补 Playwright 交互层（仓库已有 `dsh-ui-surface-smoke.mjs`）。

### 7.4 可访问性

- 可排序 `<th onClick>`、行下钻 `<tr onClick>` 无 `tabIndex/role/onKeyDown`，键盘/读屏不可操作；chip `data-on` 无 `aria-pressed`；主面板 tab 无 `role="tab"/aria-selected`；展开态无 `aria-expanded`；搜索框仅 placeholder；自绘 Modal 降级无 Esc/焦点陷阱/`aria-modal`。
- 主题合规：13 个 UI 文件零 hex/rgb 字面量，全部走 `--dsw-alias-*` / `--silksec-sev-*`，与丝之歌主题一致。

### 7.5 文档一致性（16-dashboard / ui-surface-deps）

- `16-dashboard.md:128/140` 仍写侧栏文案「看板」，代码是「安全中心」；`:140` 注册示例方法与代码不符；`:156` title 描述过时。
- `ui-surface-deps.yaml:454-460/516-527` 仍描述兼容别名 `vuln.finding_add`、旧单体 Modal、`-old` 并排视图，与「别名层已移除/旧单体已删除」矛盾。
- `ui-surface-deps.yaml:220/259/278/310/336` 的 `selectPanel` 主面板降级在代码中已删除。
- 代码注释残留「主面板 11 视图 / legacy footer / 旧入口保留」等旧口径。

---

## 八、风险清单（按优先级汇总）

### 第一批 · 安全红线（立即）
1. H1 exec 多目标 risk 闸按首目标判定 → 跨项目放行
2. H2 exec exclude 判定 fail-open → 绕过排除
3. H3 asset scope 自查 fail-open → 伪造/撤销 program 放行
4. H4 asset_grade owner 列缺失 → 功能坏

### 第二批 · 闭环与治理（短期）
5. 漏洞确认→提交闭环断裂（43 confirmed 0 提交）
6. 候选池污染与 noise/status 脱节
7. 任务租约/超时/僵尸回收缺失
8. 毒消息消费者加固（dead_letter/pending）
9. 外键回填（findings.task_id/program_id 等）
10. 授权时效（scope expires_at/reviewed_at）

### 第三批 · 健壮性与体验（中期）
11. H4 之外的中危代码（M1–M10）
12. M2/M3/M6 解析绕过与凭据/文件边界
13. UI B1/B2 及 B3–B13
14. 文档漂移 S1–S4 / M1–M7 回填
15. a11y 与测试覆盖

### 第四批 · 卫生（长期）
16. 死代码/0 字节残留/孤儿文件/重复导入
17. WAL checkpoint 维护
18. 工具安装 integrity 校验

---

## 九、改进与优化建议

### 9.1 安全红线修复（建议本周期）
- exec 域：`checkTarget` 与 `checkRisk` 改为**逐目标**判定，全部目标通过才执行；exclude 改为「全项目两遍扫描」；禁止跨 program 混目标（或强制显式 `program_id` 且所有目标同属）。
- asset 域：program 不存在直接 `E_INVARIANT` 拒绝，删除 fail-open 过渡分支。
- 把上述不变量写成契约测试（仓库已有 `*.contract-*.test.js`，补多目标跨项目、exclude 优先、program 缺失三组用例），纳入 `sec-v5-accept.sh` 门禁。
- `_file` 参数与 Burp 导入路径限定在 runDir/工作区（realpath + 白名单）。
- 沙箱不挂载整个 `$HOME`，凭据目录只读挂载或移出。

### 9.2 产出闭环
- 为 confirmed findings 增加 `submitted_at/remote_id/vendor_status/sync_state` 的写入路径与「提交任务」；否则确认率无业务意义。
- 增加「确认后未提交」看板指标与提醒。

### 9.3 数据治理
- 候选池：`noise=1 & status='new'` 按 TTL 自动 ignore/expire；以 `noise` 驱动状态迁移，消除双重计数。
- 回填外键并加校验约束（NOT NULL/CHECK）；清理 `fgs_nodes` 孤立行。
- 清理 0 字节 `assets.db/tasks.db/sec-suite.db`、孤儿 `parsers.js`；统一 source 枚举。

### 9.4 任务与事件
- 引入 `lease_expires_at/heartbeat_at`；`budget_timeout_sec` 缺省时套用全局上限；`worker_reap` 同时回收超时 running task。
- 消费者对 `exec.run.completed` 的「部分失败」做逐条幂等记录，避免整事件重试进 DLQ；补失败事件查询接口。

### 9.5 文档
- 修 S1–S4、M1–M7：以 owner 域为准统一跨域订阅/effect/联动表述；Phase 4 明确标「未实施」并改 PROGRESS。
- 统一「运行时/设计预留」二态标注；补 00-conventions 的 endpoint 域与 parser actor；补 15-eval C4 节。
- 把「跨域订阅对端声明一致」「Phase 完成度」纳入文档 CI 门禁。

### 9.6 UI
- 修 B1（uiCore 守卫）与 B2（pending effect 依赖 `[api.pending]`）。
- B3/B4 防御式取值；B5 加请求序号；B7 改 `React.createElement`；清死代码。
- 补加载骨架屏；补 a11y（role/aria/keyboard/Esc/焦点陷阱），并加结构门禁（含变量类名 CSS 检查）。
- 补真实 DOM/Playwright 交互测试，覆盖竞态与键盘路径。

### 9.7 运维
- 查清当日多次换 pid / `scheduler.js` 缺失原因，加加载失败告警。
- 低峰期 `wal_checkpoint(TRUNCATE)`。
- 工具安装加 sha256 清单校验。

---

## 十、附录：验证方法

| 检查项 | 方法 | 结果 |
|---|---|---|
| 文档 | 通读 00–18 + README + PROGRESS + archive 索引 | 见 §三 / 附录 A |
| 代码 | 本地 templates vs 线上 `/opt/silkspool/dsh` md5 逐文件比对 | `.js` 全一致；`.sh/.py` 仅模板变量差异 |
| 关键漏洞 | 人工复核 H1–H4 源码行号 | H1/H2/H3/H4 均确认 |
| 数据库 | `spool exec csai` + sqlite3 只读查询 | `quick_check=ok`；计数见 §二 |
| 漏洞产出 | findings 分组统计、submitted 字段、事件漏斗 | 43 confirmed / 0 submitted |
| 执行历史 | tasks/task_runs/workers 分组、僵尸任务、锁心跳 | 见 §五、§六 |
| UI | 本地/线上 md5、`node --test` | 20/20 一致；114 UI 用例全绿 |
| 服务健康 | systemd status、journalctl 24h、端口 | 见 §二 |

### 附录 A · 文档逐模块问题索引
S1 approval 订阅冲突（09:4；实际订阅方=fact/ledger，初查误写「仅 fact」）｜S2 初查误报已更正（http-remote 实已实现）｜S3 effect 机制互斥（05:4/431/491 vs 09:438/562）｜S4 预留订阅写成现行（04:305、10:4）｜M1 task→fgs sync/async（05:481 vs 14:255）｜M2 ledger 旧述（11:411）｜M3 查询可见口径（17:65/144）｜M4 know 头部漏订阅（07:4）｜M5 域枚举漏 endpoint（00:63）｜M6 parser actor（00:304）｜M7 eval 缺 C4 节（15）｜N1 别名样板重复（14 文件）｜N3 archive INDEX 路径（archive/INDEX.md:13）。

### 附录 B · 代码问题索引
H1 exec.js:621-623｜H2 exec.js:519-529 vs scope.js:122-140｜H3 asset.js:341-357｜H4 asset.js:578 + asset-sqlite.js 无 owner 列｜M1 bus.js:1171-1184 vs :1244｜M2 exec.js:552｜M3 exec.js:359-360/822-825｜M4 exec.js:1004｜M5 exec.js:955｜M6 exec.js:575｜M7 asset-db.js:254｜M8 tools-manager.sh:86-124｜M9 approval.js:556/653｜M10 vuln-sqlite.js:206-216｜L1 sec-suite.js:413/714/319/360｜L2 dashboard-rpc.js:341/762｜L3 webhook.js:21-44｜L4 asset-sqlite.js:309-319 vs approval.js:55-61｜L7 task-policy.js:20-29。

### 附录 C · UI 问题索引
B1 view-asset.client.js:40｜B2 panel.client.js:138-148 + view-vuln.client.js:231-237｜B3 view-report.client.js:71-72、view-know.client.js:266｜B4 view-know.client.js:206｜B5 view-report.client.js:118-125｜B6 ui-settings-scope.client.js:153-158/224｜B7 view-know.client.js:269、view-task.client.js:617｜B8 panel.client.js:85-95/151-158｜B9 view-vuln.client.js:137｜B10 approval.client.js:381-425、task.client.js:598-610、session.client.js:352-400｜B11 panel.client.js:122-125｜B12 task.client.js:607-609｜B13 view-audit.client.js:44-45。

---

## 十一、本会话修复记录（2026-09-19）

> 依据本报告第一批（安全红线）、第二批（部分）与 UI 高优先项执行修复；改动落在版本受控源 `bundles/dsh/templates/`，经本地契约/UI 测试与 csai 部署验收。

### 11.1 已修复（含验证证据）

| 编号 | 修复内容 | 文件 | 验证 |
|---|---|---|---|
| H1 | exec 风险闸改**逐目标**判定（多目标跨项目任一未放行即拒） | `dsh-plugin-sec-domain-exec.js` | 新增 `H1` 契约用例通过（exec 26/26） |
| H2 | exec `checkTarget` 改**全项目先 exclude 再 scope**（与 scope 域同源） | 同上 | 新增 `H2` 契约用例通过 |
| H3 | asset scope 自查 program 不存在改 **fail-closed `E_INVARIANT`** | `dsh-plugin-sec-domain-asset.js` | 新增 `H3` 契约用例通过（asset 31/31） |
| H4 | assets 表补 `owner` 列（`V5_COLS` + `ASSET_LIST_COLS`） | `dsh-plugin-sec-backend-asset-sqlite.js` | 线上 `PRAGMA table_info(assets)` 出现 `owner TEXT`；factory 幂等建列成功 |
| M2 | DNS 校验补 `resolve6`（IPv6 解析后内网判定） | `dsh-plugin-sec-domain-exec.js` | 语法校验 + 回归套件通过 |
| M3 | `_file` 清单与 Burp 导入限制在 HOME/data/tmp 常规文件（realpath，拒绝符号链接逃逸） | 同上 | 语法校验 + exec 套件通过 |
| M4 | `exec_grep_result` 正则长度上限 + 拒绝嵌套量词（ReDoS） | 同上 | 语法校验 + exec 套件通过 |
| M7 | info 噪声回填改**一次性迁移**（仅在 noise 列新建时执行，不再每次启动覆盖人工判定） | `dsh-plugin-sec-suite.asset-db.js` | 语法校验 |
| M10 | `vuln_dedup_check` 强制 host/vuln_type 至少其一 | `dsh-plugin-sec-domain-vuln.js` | 新增 `M10` 契约用例通过（vuln 51/51） |
| B1 | asset 视图模块级 `uiCore.T` 解引用加守卫（ui-core 缺席不再崩 bundle） | `dsh-plugin-sec-dashboard.view-asset.client.js` | UI 单测 114/114 |
| B2 | 漏洞/资产视图 pending effect 依赖 `[api.pending]`（同视图 KPI 跳链生效） | `view-asset.client.js` / `view-vuln.client.js` | UI 单测 114/114 |
| B3 | 报告/知识时间与大小渲染防御式取值 | `view-report.client.js` / `view-know.client.js` | UI 单测 114/114 |
| B4 | 知识全景图 `byCategory` 缺失防御 | `view-know.client.js` | UI 单测 114/114 |
| B5 | 报告阅读器加请求序号守卫（防内容错配） | `view-report.client.js` | UI 单测 114/114 |
| B7 | `RulesSection` / `HistoryBlock` 改 `React.createElement`（消除 Rules of Hooks 隐患） | `view-know.client.js` / `dsh-plugin-silksec-ui-task.client.js` | UI 单测 114/114 |
| B9 | ui-core 基样式补 `.silksec-btn-danger` | `dsh-plugin-silksec-ui-core.client.js` | `sec-v5-accept.sh` `ui-class-defined` PASS |

### 11.2 文档漂移已回填（均经 manifest/代码复核）

- S1 `09-approval.md:4`：被订阅方改为 **fact / ledger**（实际 `subscribes`），scope/task/know/exec 注明改走 decide 内同步 effect。
- S3 `05-task.md:4/428/492`：approval effect 表述改为「`approval_decide` 内同步 dispatch + `approval_effects` 幂等账本，无独立 dispatcher 自动重试」，与 09 对齐。
- S4 `04-endpoint.md:305`、`10-exec.md:4`：未实现的订阅方/事件标注「设计预留」，并注明对端 manifest 未声明。
- M1 `05-task.md:481`：task.finished→fgs 改 **async**，与 `fgs.js` manifest 及 14-fgs 对齐。
- M2 `11-ledger.md:411`：删除 L0 前的「静默降级」旧述。
- M4 `07-know.md:4`：补 `ledger.card_usage.logged` 订阅。
- M5 `00-conventions.md:63`：域枚举补 `endpoint`。
- M6 `00-conventions.md:304`：`parser` 改为「经 script 身份 + `identity=parser:…`」。
- **S2 更正**：初查误报 Phase 4（http-remote）未实现；复核确认 `dsh-plugin-sec-backend-vuln-http.js` 及契约测试均已存在并部署。

### 11.3 部署与验收

- `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` → `spool bundle dsh setup csai`（setup 内契约测试硬门槛全绿，服务已重启）。
- 本地：exec 26/26、asset 31/31、vuln 51/51、bus 51/51、task 38/38、approval 19/19、fact 23/23、know 73/73、ledger 22/22、endpoint 25/25、scope 15/15；UI 114/114。
- 线上：`sec-v5-accept.sh` **PASS=41 FAIL=0**；`silksecagent` active、NRestarts=0。
- 代码 md5：本地 templates 与线上 `/opt/silkspool/dsh` 一致。

### 11.4 第二轮修复（产出闭环 + 数据治理 + 任务/事件 + UI + 文档，2026-09-19 续）

| 编号 | 修复内容 | 文件 | 验证 |
|---|---|---|---|
| 闭环-1 | `vuln_submit` 增 `remote_id`（平台工单号）写入路径 | `dsh-plugin-sec-domain-vuln.js` | 契约用例：submit 后 `remote_id` 落库 |
| 闭环-2 | 新查询 `vuln_submission_queue`（confirmed 未提交，带 age_days/overdue） | 同上 + 后端 `listSubmissionQueue` | 契约用例：入队→submit→出队 |
| 闭环-3 | `vuln_stats.signal` 增 `confirmed_unsubmitted` / `submitted_awaiting_vendor` | 后端 `statsFindings` | 契约用例 |
| 闭环-4 | 看板 KPI 增「待提交 SRC」六卡之一 | `dashboard-rpc.js` / `ui-panel.client.js` | UI 114/114 + accept `ui-class-defined` |
| 闭环-5 | task 域订阅 `vuln.signal.confirmed` → 幂等入队 `[提交] finding #id` 任务（phase=review） | `dsh-plugin-sec-domain-task.js` | task 契约 39/39 |
| 治理-1 | 新命令 `vuln_expire_candidates` + 每 6h 候选 TTL 治理（`noise=1 & status=new` 超 14d → ignored，`SEC_CANDIDATE_TTL_DAYS`） | vuln 域 + 后端 `expireCandidates` | 契约用例：超期候选出池 |
| 治理-2 | `vuln_dedup_check` host/vuln_type 至少其一（已强制 E_SCHEMA） | vuln 域 | 契约用例 M10 |
| 治理-3 | retention.sh 增 SQLite `wal_checkpoint(TRUNCATE)` + 0 字节残留库清理 | `retention.sh` | 线上手工执行：WAL checkpoint 成功、3 个空库清理 |
| 任务-1 | `task_reap` 回收范围扩至**一次性任务**（原只回收定时任务，一次性 running 崩溃成永久僵尸） | `dsh-plugin-sec-backend-task-sqlite.js` | 契约用例：无 schedule_kind 僵尸任务回收为 failed |
| 事件-1 | `exec.run.completed` 订阅者逐条按**重试性**判定：确定性失败逐条登记后丢弃（不再让整事件重试进 DLQ），仅可重试失败返回 partial | `dsh-plugin-sec-domain-vuln.js` | 线上：3 条 dead_letter + 1 条 pending 全部转 delivered，0 残留 |
| UI-B6 | 授权设置工作区下拉值按 id/title/path 反查，与徽章同源 | `ui-settings-scope.client.js` | UI 114/114 |
| 文档 | 02-vuln（C13/Q7/remote_id/闭环）、05-task（提交订阅/reap 范围）、16-dashboard（安全中心文案/注册形态/KPI 六卡） | doc/secagent | 人工复核 |

**第二轮验收**：本地契约 466 例全绿（bus51/exec26/asset31/vuln63/endpoint25/task39/fact23/know73/scope15/approval19/ledger22/report12/proxy17/fgs21/eval29）+ UI 114/114；csai `bundle dsh setup` 部署、`sec-v5-accept.sh` **PASS=41 FAIL=0**、`silksecagent` active/NRestarts=0；outbox 0 dead_letter / 0 pending。

### 11.5 第三轮修复（代码中危 + 供应链 + 数据卫生 + a11y，2026-09-19 续）

| 编号 | 修复内容 | 文件 | 验证 |
|---|---|---|---|
| M6 | 沙箱凭据隔离：不再整目录挂载 `$HOME`（暴露 `.ssh/id_ed25519`、`fofa.conf`、浏览器登录态）；改 HOME tmpfs + 工具链目录只读投影 | `dsh-plugin-sec-domain-exec.js` | exec 契约 26/26；线上确认敏感项不可见 |
| M5 | 证据发布稳定窗由**逐文件 120ms** 改**整批一次**（十万级小文件不再线性拖死） | 同上 | exec 契约 26/26 |
| M9 | `approval_requests` 增独立列 `effect_state`（applied/failed/pending），消除 `approved_effect_failed` 死逻辑；retry 成功后回置 applied | `dsh-plugin-sec-domain-approval.js` + `-approval-sqlite.js` | approval 契约 19/19 |
| M8 | tools-manager 下载 integrity：解析 release 的 checksums 文件比对 sha256，不符即拒装，缺失则告警 | `tools-manager.sh` | `bash -n` 通过 |
| B8 | 降级态双入口去重（保留说明，正常宿主不触发） | 代码复核 | — |
| B10 | 审批/任务中心首帧接 `SkeletonRows`（加载不再显示「空」） | `ui-task.client.js` | UI 114/114 |
| B11 | 主面板呈现 `stats.degraded` 数据源降级提示 | `ui-panel.client.js` | UI 114/114 |
| B12 | 大队列（>60 行）按窄栏判定只渲染一套 DOM | `ui-task.client.js` | UI 114/114 |
| B13 | 审计展开态改稳定行键（ts+tool+decision），轮询刷新不漂移 | `view-audit.client.js` | UI 114/114 |
| a11y | 可排序表头 `aria-sort`/键盘；行下钻 `role=button`/`tabIndex`/`aria-expanded`/Enter·Space；chip `aria-pressed`；主面板 tab `role=tablist/tab`+`aria-selected`；搜索框 `aria-label` | ui-core / panel / 4 视图 | UI 114/114 |
| 数据卫生 | 新增 `data-hygiene.py`：program_id 唯一命中回填、source 空值归一、fgs 孤儿清理、重复发现报告（默认 dry-run，`--apply` 落库） | `data-seed/scripts/data-hygiene.py` + manifest | 本地沙箱验证通过 |
| 去重口径 | `register_candidate` 返回 `dedup_reason`（same_host_title_url / same_host_title_diff_url） | `dsh-plugin-sec-domain-vuln.js` | vuln 契约 63/63 |
| 文档 | 09-approval（effect_state）、10-exec（沙箱隔离）回填 | doc/secagent | 人工复核 |

**第三轮验收**：本地契约 466 例 + UI 114 全绿；csai `bundle dsh setup` 部署 + `sec-v5-accept.sh` PASS=41 FAIL=0。

### 11.6 第四轮修复（剩余全部建议项，2026-09-19 收尾）

| 编号 | 修复内容 | 文件 | 验证 |
|---|---|---|---|
| M1 | 事务内幂等复检（`BEGIN IMMEDIATE` 串行化后）闭合 check-then-insert 竞态；并发同 key 返回 replay 而非 E_CONFLICT | `dsh-plugin-sec-domain-bus.js` | 新增并发契约用例：恰好一个 replay（bus 52/52） |
| 授权时效 | scope.yml program 增 `expires_at`/`reviewed_at`；过期 fail-closed（scope_check/exec/asset 三处一致）；`scope_grant`/`scope_rules_apply` 可设/续期；新查询 `scope_expiring`；看板面板过期/临期告警 + 设置页徽章 | scope 域/后端、exec、asset、dashboard-rpc、ui-panel、ui-settings-scope | 新增 3 契约用例（scope 18/18） |
| 批量提交 | 新命令 `task_submission_backlog`（dashboard/system）：扫描 `vuln.submission_queue` 幂等补建 `[提交] finding #id` 任务（历史存量一次性；**queued 无调度，不自动起 worker，由人工 `task_run_now`**——避免一次性拉起数十个 LLM 会话）；线上已补建 42 条 | `dsh-plugin-sec-domain-task.js` | 新增契约用例（task 40/40）；线上 42 created / 2 skipped |
| external_id | findings 增 `external_id` 列 + 索引；`register_signal`/`register_candidate`/parser 订阅支持 external_id 优先去重 | vuln 域/后端 | 新增跨源去重契约用例（vuln 64/64） |
| 文档 | 17-llm-surface 查询可见口径修正；15-eval 补 C4 逐个详述节；ui-surface-deps 清理旧单体/别名/主面板降级陈旧条目 | doc/secagent、bundles/dsh/doc | 人工复核 |

**第四轮验收**：本地契约 **483 例** + UI 114 全绿；csai `bundle dsh setup` 部署 + `sec-v5-accept.sh` PASS=41 FAIL=0。

### 11.7 说明：不建议继续自动化的项

- 6 组重复发现的**自动合并**：需人工判 `dup_of`（工具无法可靠判定哪个是主记录），`data-hygiene.py` 只报告不合并。
- 沙箱凭据读取的**彻底消除**：工具（如 fofa_search）合法需要 `~/.config/fofa.conf`，只能做到「遮蔽非必要凭据 + 只读投影」；根治需把凭据改为环境变量注入（设计变更）。
- L 类卫生项（死代码/命名）属持续清理，不阻塞。
