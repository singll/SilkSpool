# SilkSecAgent v5 · 领域插件化架构 · 总设计文档

> 版本：v5.0 ｜ 状态：**00–18 已定稿；Phase 0–4 已实施，Phase 5 收尾中**。实际进度与最新核查见 [PROGRESS](PROGRESS.md)。
> 性质：当前架构设计真相源。历史架构资料在 [archive](../archive/INDEX.md)，历次升级方案与记录统一在 [upgrades](../upgrades/README.md)。
> 工程位置：csai `/opt/silkspool/dsh/`；版本受控源文件在 SilkSpool 仓库 `bundles/dsh/templates/`。
> **最高约定**：[`00-conventions.md`](00-conventions.md)（全局契约宪法——命名/actor/命令八铁律/信封/错误码/幂等/事件/审计/后端/测试/安全/版本化）。模块文档与它冲突时以它为准。

---

## 阅读入口

| 本次任务 | 阅读路径 |
|---|---|
| 快速了解系统 | [文档总入口](../README.md) → 本页分层图 → [全局契约](00-conventions.md) |
| 继续迁移实施 | [PROGRESS](PROGRESS.md) → [迁移路线](18-migration.md) → 对应域；用 [会话模板](SESSION-PROMPT.md) 确认范围 |
| 检查当前缺陷 | 对应域文末的 2026-09-12 深度审查 + [本次 csai 预检](../upgrades/2026-09-12-dsh-0.1.5-rc.2-record.md)；[9 月 11 日总线审查](REVIEW-bus-atomization.md) 是历史基线 |
| 升级 DSH | [升级时间线](../upgrades/README.md) → [0.1.5-rc.2 方案](../upgrades/2026-09-12-dsh-0.1.5-rc.2-plan.md) |
| 优化自学习与漏洞探测 | [自学习专项](../upgrades/2026-09-12-self-learning-design.md) → know / ledger / exec / eval 等相关域契约 |

2026-09-13 核查：生产仍为 DSH 0.1.2-rc.1；rc.2 的 Session/persona 兼容切片已完成，17 项针对性测试通过，会话副本预演 249/253，4 个历史序号冲突阻止切换。9 月 12 日的 25/25 是基础健康基线；自学习 L 工作包尚未实施。5.2 别名删除仍需连续七天零使用，9 月 12 日核查的最早闸口为 2026-09-19T15:23:24.420+08:00，新调用继续顺延。

## 一、为什么重构（一段话版）

v4.x 的"模块"只是文件切分：findings 的闸门逻辑散落在 `addFinding`/`updateFinding` 函数体里，5 个写入口（工具面/看板 RPC/parser/webhook/审批钩子）各自调用，漏一个 if 就产生"31 条已确认漏洞仍挂候选徽章且被信号面隐藏"的僵尸数据（2026-09-06 实测取证，见归档 `silksecagent-v5-domain-plugin-architecture.md` §1.2 的 12 条写路径清单）。v5 把不变量从函数体搬进**域边界**：每个业务域是一个独立 cordis 插件，对外只暴露契约动词（经 CommandGateway 强制校验/事务/事件/审计），对内私有状态机与存储；后端（sqlite/http/file）可替换；模型与看板与脚本与人走**同一条路**。

## 二、六条设计公理

1. **一切领域皆插件**：每域一个 cordis 插件（`@silksec/sec-domain-*`），按 profile 组合挂载，对齐 DSH"一切皆插件"。
2. **一切写入皆命令**：数据只能经域命令动词变更；命令 = 状态机入口 + 事务 + 事件 + 审计，无第二写入口。
3. **一切读取皆查询**：读投影与写动词分离，查询纯读无副作用。
4. **一切联动皆事件**：跨域副作用只允许"发布事件 + 订阅方执行命令"，禁止跨域直调写函数。
5. **一切后端可替换**：域只依赖 repository 接口；sqlite-local / http-remote / file 同契约三适配器，能力矩阵声明，混布允许（本地 overlay + 远端主库）。
6. **一切入口双投影**：模型工具面与看板 RPC 面是同一组 handler 的自动投影（ToolProjector / RpcProjector），物理上消灭两套校验。

## 三、分层总图

```
┌─ DSH 平台层（不动）────────────────────────────────────────────┐
│  cordis 容器 / profiles(web|headless) / tools.register /        │
│  connection.rpc / spawn_worker / pi-ai 模型层 / dsh-bill /       │
│  @silksec/dsh-browser fork + 常驻 Chromium(CDP :9222) 共驾底座   │
├────────────────────────────────────────────────────────────────┤
│  边缘层（不动清单，10-exec §2.7 / 18-migration §9.2）             │
│  silksecagent-edge(:3080→3081 / :9223) / shared-browser / xray  │
│  proxy-rotator·refresh / intel.timer / backup·retention / OOB    │
├────────────────────────────────────────────────────────────────┤
│  领域总线 @silksec/sec-domain-bus                                │
│  DomainRegistry · CommandGateway · QueryGateway · EventBus      │
│  ToolProjector · RpcProjector · 幂等表 · 统一 audit · 事件回放    │
│    ▲ provide('secDomain.{domain}') / inject（memcore 已验证的 DI 模式）
├────────────────────────────────────────────────────────────────┤
│  领域模块层（14 域，每域一文档）                                  │
│  vuln │ asset │ endpoint │ task │ fact │ know │ scope │ approval │
│  exec │ ledger │ report │ proxy │ fgs │ eval                    │
│    ▲ 每域只依赖自己的 repository 接口                             │
├────────────────────────────────────────────────────────────────┤
│  后端适配层（可替换，能力矩阵，三后端同契约测试）                   │
│  sqlite-local（默认）│ http-remote（外部系统）│ file（TSV/YAML）  │
└────────────────────────────────────────────────────────────────┘
  另两个投影面：看板（sec-dashboard 壳 + 域视图插件）· LLM 工具面（§五）
  治理旁路：sec-memcore（订阅事件 + 调 lifecycle 命令，fail-open，零裸 SQL）
```

## 四、文档地图（设计完成度索引）

> 编号是依赖索引，按任务选读相关模块；**每份模块文档的对外暴露面（§一）永远在最前**。状态：`起草中` → `草案` → **`定稿`**（用户评审通过后冻结，才允许对应域代码动工）。各模块文档 §四为开放问题（实现期观察项，按所列倾向推进、实证后复评），文末审查记录用于区分设计与当前实现。

| # | 文档 | 域职责（一句话） | owns（单写者） | 状态 |
|---|---|---|---|---|
| 00 | [conventions](00-conventions.md) | 全局契约宪法 | —（总线管 audit/events） | **定稿** |
| 01 | [bus](01-bus.md) | 领域总线：注册/网关/事件/投影/幂等/审计 | idempotency 表、audit.jsonl、data/events/ | 定稿 |
| 02 | [vuln](02-vuln.md) | 漏洞信号/候选队列/证据复核 | findings 表、data/evidence/ | 定稿 |
| 03 | [asset](03-asset.md) | 资产/指纹/分级 | assets、fingerprints 表 | 定稿 |
| 04 | [endpoint](04-endpoint.md) | 接口面/参数队列 | endpoints 表、param-queue | 定稿 |
| 05 | [task](05-task.md) | 任务/调度/执行史/worker 注册表 | tasks、task_runs、workers 表 | 定稿 |
| 06 | [fact](06-fact.md) | 事实/边/黑板环境层/负知识 | facts、fact_edges、blackboard 表 | 定稿 |
| 07 | [know](07-know.md) | 知识六仓：经验/文献/先验/规程/收割/体检 | exp_*、kb_* 表、rules/、vulncards/ | 定稿 |
| 08 | [scope](08-scope.md) | 授权/项目/排除/凭据引用/规则 | scope.yml、programs、credentials 表 | 定稿 |
| 09 | [approval](09-approval.md) | 统一审批中心（kind 注册表） | approval_requests 表 | 定稿 |
| 10 | [exec](10-exec.md) | 工具执行/沙箱/QPS/worker 派生/parser 提案 | tools.d/、results/、flows/ | 定稿 |
| 11 | [ledger](11-ledger.md) | 纪律台账/卡使用/覆盖/雷达队列 | pipeline/{program}/ 台账文件 | 定稿 |
| 12 | [report](12-report.md) | 报告生成/提交稿 | reports/ 全树（含 submissions/） | 定稿 |
| 13 | [proxy](13-proxy.md) | 代理池 | pool.json/live/blocklist | 定稿 |
| 14 | [fgs](14-fgs.md) | 任务内决策图 | fgs_nodes 表 | 定稿 |
| 15 | [eval](15-eval.md) | 活评测集/假阳性消融 | data/eval/ | 定稿 |
| 16 | [dashboard](16-dashboard.md) | 看板壳 + 域视图插件化 + RPC 投影消费 | client 资源 | 定稿 |
| 17 | [llm-surface](17-llm-surface.md) | LLM 工具面/挂载矩阵/prompt 体系对接 | — | 定稿 |
| 18 | [migration](18-migration.md) | 迁移路线 Phase 0-5/回滚/数据修复 | — | 定稿 |

**依赖关系速览**：bus 是所有域的宿主；vuln/asset/endpoint/fact/know 相互只通过事件联动；scope 是 exec 的前置（守卫链）；approval 只发事件不直写任何域；ledger 订阅 exec 产物；task 调 exec 派生 worker；memcore 订阅全部域的 lifecycle 事件。

## 五、LLM 只见动词不见存储（总则，细节在 17）

- 工具面 = 契约自动投影（工具名=动词名，schema=命令 schema，描述=manifest `agent_note`）；
- model 不可用的动词（机器直灌通道/审批裁决/scope 写/调度收尾）**根本不向模型注册**（profile × actor 白名单挂载矩阵）；
- 状态机私有：模型没有 `update X SET status` 类自由动词；
- 脚本产 proposal 不落库：治理/采集脚本的 manifest 废止 `store` 直写，落库只有域命令一条路；
- run_cli 沙箱对域 owned 文件不可写（manifest owns × sandbox 白名单交叉断言）。

## 六、关键取舍（已定，模块文档不得推翻）

| 决策 | 选择 | 一句话理由 |
|---|---|---|
| 单写者进程 vs 多进程开库 | 保留多进程 + SQLite WAL，写收敛于网关（进程内单入口） | 单写者守护进程改动面过大；契约层单写者律已消灭全部 v4.x 病灶；Phase 5 复评 |
| 域粒度 | 14 域 | 一张状态机 + 一个 owner 为界；fingerprints 等读模型不单独成域 |
| 工具改名 | 域前缀新名 + 旧名别名一个观察期 | prompt/objective 里的工具引用需脚本化改写（p14-1 先例） |
| asset-db.js 1865 行 | 按域搬迁不重写 | v4.x 闸门/事务逻辑是对的，搬进域+套壳 |
| http-remote 时机 | Phase 4，vuln 域试点 | 先把契约做实，再接外部漏洞管理系统 |
| 表名/库文件 | 不改名不迁库（sqlite-local 后端直接接管现表） | 迁移风险最小化；列级演进走域内 ensureCol |

## 七、与归档文档的关系

- [v4.x 运行态快照](../archive/README.md)记录 2026-09-05 的进程、规模和人工事项；当时的“当前/待办/必做”不能直接当作今天的状态或升级规则。
- [v4.x 系统解剖](../archive/silksecagent-system-complete.md)是各模块“现状代码映射”节的历史取证来源。
- [升级目录](../upgrades/README.md)集中维护历次方案、实施与回滚记录；尤其 DSH Session V3 会话的回滚须采用新方案，不能照搬旧版退包操作。
- 当前架构契约以本目录为准；upgrades 中未实施的提议在批准和同步契约之前不改变它。运行是否符合契约须看最新核查，不能由“定稿”推定。
