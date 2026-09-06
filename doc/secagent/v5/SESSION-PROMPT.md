# SilkSecAgent v5 迁移开工提示词（递归模板）

你是 SilkSecAgent v5 领域插件化重构的执行 agent。这是一次**延续性会话**——前面的会话已完成部分节点，你必须先读进度、再判断本次该做哪一步，不要从零开始、不要重做已完成的工作。

本次会话只完成**一个「可上线、可验收、可回滚」的节点**，不要贪多跨节点。

---

## 一、开工第一步：读进度，判定当前节点（必须最先做）

按顺序读，读完后你应当能回答「当前在哪、本次该做哪个节点」：

1. `doc/secagent/v5/PROGRESS.md` —— **进度真相源**（先读它）
2. `doc/secagent/v5/18-migration.md` —— 迁移计划真相源（Phase 0-5 与每步验收）
3. `bundles/dsh/CONTEXT.md` —— 领域语言术语表（Workspace/Program/Task/Finding/Scope 等词义以此为准）

交叉确认线上真实状态（防 PROGRESS.md 与线上脱节）：

```bash
git log --oneline -5
spool exec csai "systemctl is-active silksecagent && sqlite3 /opt/silkspool/dsh/data/asset-graph.db 'SELECT status FROM findings LIMIT 0' && echo db-ok"
```

**判定规则**：取 PROGRESS.md「待办节点」列表里**当前第一个未勾选**的项作为本次节点。勾选进度落后于线上实际时，以 git log 的 commit 为准校正 PROGRESS.md。

## 二、本次执行节点

只做上面判定出的那一个节点。节点定义、范围、验收见 PROGRESS.md §三 + 对应域文档（01-bus / 02-vuln / …）。**不要跨节点、不要提前做后续 Phase、不要顺手重构无关代码。**

## 三、关键背景与已定决策（勿推翻、勿重新设计）

- **目标**：SilkSecAgent（csai 主机授权漏洞发现平台，DSH + pi-ai）从 v4 单体（`dsh-plugin-sec-suite.js` 等）重构为 v5 领域插件化（14 域 + 总线）。
- **真相源**：源码 `/home/ubuntu/SilkSpool`（bundle 模板在 `bundles/dsh/templates/`）；文档 `doc/secagent/v5/`（00-18 已全量定稿）。
- **已定架构决策**：多进程 + SQLite WAL；event_outbox + dispatcher 跨进程投递；sync（同事务 SAVEPOINT 可回滚）/ async（outbox 派发 + retry/dead-letter）事件语义；approval_effects 幂等 effect outbox；audit fail-closed（主链路写命令）；LLM 工具面 phase 动态子集；兼容别名贯穿（7 天观察期）；不改表名不迁库（ensureCol 幂等列演进）。
- **已完成**：Phase 0 候选池热修（commit `4ae57cb`）已上线验收；文档定稿（commit `2e593e9`）。

## 四、执行纪律

- 改代码前先读对应域文档契约，严格对齐：命名（snake_case 动词 / 点分 RPC / 事件 `domain.obj.verb`）、actor 白名单、幂等键、事件 payload、错误码（宪法全局保留码 + `E_{DOMAIN}_*`）。
- 域命令拆自 `asset-db.js` 时：**保留 v4 兼容**——在别名切换前，旧工具名/旧函数路径不能断，每日链路（03:00/04:00 任务）不能中断超过一个调度周期。
- 新插件组装沿用现有 `sec-*-plugin-setup.sh` 模式（复制模板进 plugins/<name>/ + package.json + `dsh plugin add` + dump-config 冒烟）。

## 五、验收标准（本次会话完成的硬性门槛，全部满足才算完成）

1. **契约测试全绿**：对应域文档 §契约测试矩阵（宪法 §十三 8 用例类）全部通过。
2. **上线且系统正常**：部署后 `spool exec csai "systemctl is-active silksecagent"` = active；v4 现有功能无回归（看板/工具/每日任务正常）。
3. **代码提交 + 追踪**：`git add`（逐个文件，禁 `-f`）→ 有意义的中文 commit → `git push origin main`；把 commit hash 写进 PROGRESS.md 对应节点。
4. **更新 PROGRESS.md**：勾选完成节点、更新「当前 Phase」、若本节点产出后续待办则补充。

## 六、收尾：总结 + 生成下次提示词（递归）

本次会话结束时必须输出两部分：

1. **本次总结**：完成节点 / 验收结果（含线上 `systemctl is-active` 与关键口径数据）/ commit hash。
2. **下一步开工提示词**：内容与本模板**完全一致**（递归复用），唯一引导新会话去读**已更新后的** PROGRESS.md 来判定下一节点。

**递归终止条件**：当 PROGRESS.md「待办节点」全部勾选、Phase 5 完成、且 18-migration §十 DoD 6 条全部满足时，输出「v5 迁移全部完成」的最终验收总结，**不再**生成下次提示词。

---

（本提示词由上一次会话生成。开工前请先执行 §一，读到最新的 PROGRESS.md。）
