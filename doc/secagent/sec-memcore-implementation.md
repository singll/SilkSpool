# SilkSecAgent 记忆基架 + 自学习 实施总纲

> 版本：v1.2 ｜ 日期：2026-09-01 ｜ 上游设计：[sec-memory-governance-design.md](sec-memory-governance-design.md) v2.1
> 本文档记录记忆治理系统的**实施状态**；数据现状以 `silksecagent-system-complete.md` §4.2/§5 与 csai 运行时实测为准。
> 2026-09-01 更新：blackboard 现为 timeline/ephemeral 兼容层（47 键），facts 1,082 条，exp_cards 4 张；sweeper 6h 运转、AGENTS.md 受管区块自动生成、vault 导出桥正常。

> **实施状态（2026-08-25 已上线，csai 验证通过）**
> - ✅ B0：4 条 interval objective 清 httpx/统一报告路径/清陈旧日期；黑板 httpx note 标记归档
> - ✅ B1+B2：@silksec/sec-memcore 已装入 web+headless profile；存量迁移完成
>   （blackboard 21 timeline+979 ephemeral；facts 396 ephemeral+603 durable；exp 2 candidate；playbooks 15）；
>   sweeper 6h 运转、AGENTS.md 受管区块自动生成、objective lint 首跑 12 命中
> - ✅ fail-open 实测：摘除 memcore 后服务正常 + stderr/黑板告警触发 + 写读透传；恢复后治理回归
> - ✅ B3：看板知识 tab（卡片评分/晋升/编辑/弃置 + playbooks）+ 报告只读 tab + memcore 缺席横幅；
>   sec-knowledge 技能已种；5 个执行型 persona 已补开局检索句
> - ✅ B4（部分）：每周 review interval 任务已建（id=24，每周日 05:00）
> - ✅ B4（剩余）：**Bellkeeper 融合双向桥已上线**（2026-08-25，按融合评估报告 F1/F3 落地）：
>   - 方向① sec→vault：sweeper 每日导出 permanent+active+**exportable=1** 的 exp_cards/playbooks
>     为 pkb 兼容 frontmatter 的 md → rsync 推送 keeper:`vault/安全经验/`（幂等覆盖+tombstone；
>     **exportable 默认 0 fail-closed**；scope 授权域脱敏硬门命中即拒导；看板知识 tab 有导出开关）
>   - 方向② vault→sec：每日 05 时后 rsync 拉取 `vault/安全/` → 新卡经 kbImport 入 kb_docs
>     （taintguard+external 低置信；**source_system: silksecagent 禁回流防循环**；已导入 224 张）
>   - 拓扑说明：csai/keeper 均为非特权 LXC 无法挂 NFS，桥走 SSH rsync（keeper 真实 IP .230，
>     .167 为转发地址）；Bellkeeper scan_dirs 递归覆盖 vault/ 故 安全经验/ 零开发入 Meili/Obsidian
>
> **实施期设计修正**：① facts 的 note 类负知识归为 ephemeral 14 天（而非 timeline）——neg_check
> 依赖其可见性，timeline 会弄瞎负知识拦截；② R6 justification 硬要求仅语义层（exp/pb/kb），
> 工作/情景层允许缺省分类（auto:default）——否则内部自动写入点（runcli 失败证伪等）会全部被拒。

---

## 1. 核心结论：不是两个系统，是一个系统的两层

知识卡片治理（评分/晋升/淘汰/看板操作）**完全吸收进 memcore**，作为引擎在"语义层"的策略实例。
若并行实施会产生：双状态机、双评分、双管理入口——全部合并为一。

### 1.1 三层记忆模型（评分是语义层专属，不铺满全表）

| 层 | 表 | 治理重心 | 评分列 | 可驻 permanent |
|---|---|---|---|---|
| 工作层 | blackboard | TTL 到期即走 | 无 | 否 |
| 情景层 | facts | 复验刷新 | 无 | 否 |
| 语义层 | exp_cards / playbooks / kb_docs | 评分 + 晋升 | 有 | 是（kb_docs 除外：外部知识 durable 90d） |

> 修正 v2.1：评分组列从"统一列组"移出，仅语义层三表持有。生命周期列组仍为全表统一。

### 1.2 冲突点与解法对照

| # | 冲突 | 解法 |
|---|---|---|
| 1 | 卡片晋升 vs memcore 状态机 = 双状态机 | 状态机唯一（transition()）；卡片规则降级为 exp_cards 的策略参数 |
| 2 | 评分列铺满全表 = 冗余 | 三层模型，评分仅语义层 |
| 3 | exp_validate vs durable revalidate_by 同源 | 统一为引擎复验策略，"用到即复验"两层通用 |
| 4 | exp_feedback/检索命中 = 独立机制 | 抽象为引擎第五原语 recordSignal()，评分只是信号计数 |
| 5 | 看板知识操作 = 另建管理 API | 看板 tab 直接调用 transition/recordSignal，是状态机的 UI |
| 6 | playbooks 已有 runs/successes | 天然信号源，零改造接入 recordSignal |
| 7 | blackboard note:* 与 facts category=note 用途重叠 | 不合并存储（侵入大），迁移时各自正确分类即可 |

---

## 2. 最终原语集（@silksec/sec-memcore 提供五个）

| 原语 | 职责 |
|---|---|
| `validateWrite(table, intent)` | R1-R7 底线硬校验 |
| `visibilityFilter(reader, rows)` | 按读者角色 × status × scope 过滤 |
| `transition(table, id, to, reason)` | 状态机唯一入口，audit 留痕 |
| `recordSignal(table, id, signal, meta)` | 信号计数（searched/adopted/useful/wrong/outdated/validated/ran/succeeded）→ 更新评分 → 按策略触发自动流转 |
| `sweep()` | 每日：过期降级 / 归档 / 硬删 / 自动晋升 / AGENTS.md 重写 / objective lint |

fail-open 语义不变：存储插件 `ctx.inject(['secMemoryLifecycle'])` 缺席即透传 + 告警。

---

## 3. 最终数据模型

### 3.1 全表统一生命周期列（blackboard / facts / exp_cards / playbooks / kb_docs）

`mem_class` / `scope` / `status` / `expires_at` / `revalidate_by` / `justification` / `last_validated_at`

### 3.2 语义层追加评分列（exp_cards / playbooks / kb_docs）

`uses` / `adopted` / `pos_fb` / `neg_fb` / `score` / `last_used_at`
（playbooks 映射：uses=runs、adopted=successes，沿用既有列不加新列）

### 3.3 每表策略注册表（引擎内置，集中可调）

| 表 | allowed mem_class | 默认 | 评分 | 自动晋升 | 降级 | timeline 归档 |
|---|---|---|---|---|---|---|
| blackboard | ephemeral, timeline | ephemeral 7d | 无 | — | 过期→archived | 30d |
| facts | durable, ephemeral, timeline | durable 复验30d | 无 | — | 逾期未复验→cooling→30d→archived | 30d |
| exp_cards | （入口 candidate）→ permanent | candidate | 全量 | adopted≥2 且 neg_fb=0 且存活≥7d | uses=0>30d / neg_fb≥3 →cooling→30d→archived | — |
| playbooks | permanent | permanent | runs/successes | — | success_rate<30% 且 runs≥5 →cooling | — |
| kb_docs | durable | durable 复验90d | uses 计数 | — | 逾期未复验→cooling | — |

### 3.4 归档表

每表对应 `*_archive`（同构 + `archived_at` / `archive_reason`），archived 超 90 天硬删。

---

## 4. 写入协议（不变，引用设计稿 §3）

R1-R7 底线硬校验 + justification 思考留痕；permanent 禁直写（exp_store 落 candidate）。
读取隔离矩阵不变（执行任务不见 timeline/archived，复盘全量）。

---

## 5. 看板知识 tab 操作映射（状态机的 UI）

| 看板操作 | 引擎调用 |
|---|---|
| 新增卡 | validateWrite → 落 candidate |
| 编辑 takeaway/chain | 更新 + justification 必填（修改理由） |
| 👍/👎 | recordSignal(useful/wrong) |
| 弃置 / 恢复 | transition(archived) / transition(cooling) |
| 强制复验 | recordSignal(validated) |
| playbooks 查看 | 只读（信号来自真实运行，不开放手改） |

---

## 6. 边界外（不受 memcore 治理）

- **报告文件**：是产物不是记忆，retention.sh 管文件生命周期；看板"报告"tab 只读预览；
- **NAS vault**：单向导出桥——sweeper 每日把 active permanent 卡导出 md（frontmatter 带 score/status）；vault 人工新知识经 kb_import 回流（taintguard + external 低置信 + 人审晋升）；
- **sessions/trajectories/flows**：现有 retention 已覆盖。

---

## 7. 实施批次（依赖序）

| 批次 | 内容 | 重启 | 依赖 |
|---|---|---|---|
| **B0** 止血 | 4 个 interval objective 清 httpx 段 + 报告路径统一；黑板 httpx-blocked-env 标记待迁移 | ❌ | 无，SQL 即做 |
| **B1** 插件骨架 | @silksec/sec-memcore：schema 一次迁移（生命周期列 + 语义层评分列 + archive 表）、五原语、策略注册表、sweeper、存量规则迁移 | ✅ | — |
| **B2** 存储接入 | 三存储插件可选注入（透传+缺席告警）；exp_store 候选制；exp_search 接 recordSignal；exp_feedback/exp_update/exp_deprecate；合并阈值 0.95；AGENTS.md 生成器；objective lint | ✅ 与 B1 同次 | B1 |
| **B3** 人机界面 | 看板知识 tab + 报告只读 tab + memcore 缺席横幅；sec-knowledge 技能；AGENTS.md 初版；5 个执行型 persona 补开局检索 | ✅ | B2 |
| **B4** 治理运转 | 每周 review interval 任务（评审加速+碎片合并+质量审计）；NAS dataset + 卡片 md 导出桥 + vault 同步 | ❌ | B3 |

### 验证标准（每批验收）

- B1：`sqlite3 .schema` 三表列齐全；存量 1999 条分类完成；sweeper 干跑（dry-run）输出正确；
- B2：memcore 摘除后 agent 全功能正常（fail-open 实测）；exp_store 直写落 candidate；检索命中 uses+1；
- B3：看板可完成 §5 全部操作且 audit.jsonl 留痕；
- B4：复盘任务跑通一轮；vault 目录出现卡片 md。
