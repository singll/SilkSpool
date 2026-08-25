# SilkSecAgent 持久记忆治理设计（分类 + 遗忘机制）

> 日期：2026-08-25 ｜ 状态：**待拍板**（方案讨论稿，未实施）
> 起源：httpx 卡死故障文本被固化进每日任务 objective 与黑板，故障修复后仍被 agent 当现行约束读取。讨论后确认这不是单个故障问题，而是**所有持久记忆面缺少分类与遗忘机制**的系统性问题。

---

## 1. 背景与现状（csai 主机实测取证）

### 1.1 持久记忆面清单

| 记忆面 | 载体 | 现状规模 | 元数据 | 读取默认 |
|---|---|---|---|---|
| 黑板 | `asset-graph.db: blackboard`（key/value/updated_at 三列） | **1000 键** | 无分类、无 TTL | 全量可读 |
| 事实 | `facts`（有 pinned/confidence，无 TTL） | **999 条**（note 396 / target 264 / asset 231 / finding 70） | 无时效分类 | 全量可搜 |
| 经验卡 | `exp_cards` | 2 张 | 有 confidence/source，无使用统计 | 全量可搜 |
| 打法链 | `playbooks` | 15 条 | 有 runs/successes 统计（可借鉴） | 全量可搜 |
| 外部知识 | `kb_docs` | 0 | 有 tainted 注入标记 | — |
| 工作区指令 | `$DSH_HOME/AGENTS.md` 注入链 | **目前不存在** | — | 每会话开局注入 |
| 任务指令 | `tasks.objective`（interval 任务自续排复用） | 4 条每日 interval | — | 调度时注入 worker |
| 文件产物 | reports/ flows/ results/ audit.jsonl | — | retention.sh 每日清理（仅文件层） | — |

### 1.2 共享的错误默认假设

所有记忆面共享同一假设："**写下的就是永久真相，且所有任务默认可读**"。由此产生三类污染：

1. **时效污染**：时间轴流水（"2026-08-24 链健康""次日续排 id=17 已存在"）写成永久记录，无限累积；
2. **失效污染**：临时状态（httpx 卡死、代理某次封禁、某日存活清单）失效后无人清除，新旧矛盾并存
   ——实证：黑板中 `note:meituan-src:httpx-blocked-env`（故障记录）与 `note:dsh:httpx-fixed-2026-08-23`（已修复）同时存在，而 recon objective 还要求开局读前者；
3. **粒度污染**：目标特定事实（"auth.mykeeta.com 有 CORS"）与可迁移方法论（"SUPABASE anon JWT 泄露可直连数据库"）混存同层，后者才该永久。

### 1.3 httpx 事件定性

- 卡死文本存在于 **4 个 interval 任务（#16/#17/#18/#19）的 objective**（动态拼接层，非固定提示词）+ 黑板旧 note；
- interval 任务每日自续排**复用同一 objective**，临时故障由此被复制成永久指令；
- preset persona / skills / settings / patch.yml 中无相关内容（grep 证实）——问题 100% 在动态层。

### 1.4 已有基础设施

- `retention.sh` + `silksec-retention.timer`：每日跑，但只清 flows/results/audit 文件，**不管 SQLite 记忆表**——sweeper 框架现成，可直接扩展；
- 看板 RPC 通道 `/silksec-dashboard`（host↔client）现成，加 case 即可扩展管理界面；
- playbooks 的 runs/successes 统计设计可直接借鉴到 exp_cards 评分。

---

## 2. 设计目标

1. **分类**：所有持久记忆写入时必须声明"这是什么、活多久"；
2. **遗忘**：临时的、可失效的、时间轴记录有明确的生命周期出口，不无限累积；
3. **读取隔离**：不是所有任务都能读到一切——默认只给"当前还有效"的记忆；
4. **通用才长久**：永久层只放通用的、不受时间限制的内容，且有守门机制防污染；
5. **可审计可恢复**：遗忘不是直接删除，先归档后硬清，全程留痕。

### 治理的三个落刀面

| 面 | 内容 | 强制手段 |
|---|---|---|
| 写入面 | 写记忆时强制声明类别与寿命 | 代码校验 or 提示词纪律 |
| 存储面 | 记忆按寿命分层，有状态机和出口 | schema 字段 / 分表 / 命名约定 |
| 读取面 | 检索默认过滤失效与流水 | 检索工具过滤 / 注入层裁剪 |

---

## 3. 候选方案

### 方案 A：元数据标签制（单库扩展，代码强制）

不动存储结构，给 `blackboard`/`facts`/`exp_cards` 统一加列：

```
mem_class:  permanent | durable | ephemeral | timeline
expires_at: 时间戳（ephemeral 必填；durable 必填=复验期限）
status:     active | cooling | archived
```

- 写入：工具强制带 `mem_class`，缺省按类型给默认（黑板 note=ephemeral 7 天、fact=durable 30 天、exp=permanent）；
- 读取：`blackboard_get`/`fact_search`/`exp_search` 默认过滤 expired/archived/timeline，timeline 仅复盘任务显式 `include_timeline=true` 可读；
- 遗忘：扩展 retention.sh 增加 SQLite sweeper：过期→cooling→归档表→90 天硬删。
- ✅ 一套机制全覆盖、硬保证、可审计、改动集中（experience.js / asset-db.js / asset-graph.js）
- ❌ 需迁移回填 1999 条遗留数据；需重启服务；标签判断仍靠写入方，标错照样污染 permanent 层

### 方案 B：分层记忆制（物理三层 + 晋升制）

仿人类记忆物理分层，核心思想"**知识只能升舱，不能直写永久层**"：

| 层 | 载体 | 谁能写 | 谁能读 | 寿命 |
|---|---|---|---|---|
| 工作记忆 | blackboard（全量 TTL 化） | 所有任务 | 所有任务 | 7-14 天自动归档 |
| 情景记忆 | facts/时间轴事件流 | 所有任务 | 默认仅复盘任务读全文；执行任务只读 pinned+近 7 天 | 30 天归档 |
| 语义记忆 | exp_cards/playbooks/AGENTS.md | **仅复盘任务经三闸门晋升** | 所有任务（开局注入） | 永久，带评分淘汰 |

- 执行任务禁止直接 exp_store，只写情景层"候选经验"；每周复盘做晋升评审。
- ✅ 架构上保证"通用才持久"，永久层有唯一入口和守门人，污染物理上进不去
- ❌ 改动最大（新表/工具语义变更/agent 习惯改变）；晋升制依赖复盘任务稳定运行，复盘一停知识管道断流

### 方案 C：纯约定制（零代码）

键名前缀约定（`[env-issue]`/`[timeline]`/`[perm]`）+ AGENTS.md 读取纪律 + 每周复盘清理。
- ✅ 今天就能上，零风险零重启
- ❌ 全靠模型自觉，无硬保证；1000 存量键不受约束；漏标即无声累积——正是 httpx 事件的重演路径。**只配当过渡，不配当终态。**

### 方案 D：混合制（推荐）= A 的机制 + B 的思想 + C 的过渡

1. **标签即层级**：不物理分库，用 `mem_class` 字段表达三层（ephemeral≈工作、durable/timeline≈情景、permanent≈语义），`promote` = 改 class 字段，避免 B 的大迁移；
2. **晋升制收窄**：`exp_store` 可写但新卡默认进 `candidate` 状态（检索可见但排序靠后），复盘评审通过才转 `active`——用远小于 B 的改动拿到"永久层守门"的核心收益；
3. **读写双面代码化**：写入强制分类 + 读取默认过滤 + sweeper 归档（A 的全部机制）；
4. **C 立即止血**：键名约定 + AGENTS.md 纪律 + httpx 清理今天先做，不等代码。

**遗忘机制组合拳**（四手段各司其职）：

| 手段 | 作用 | 类比 |
|---|---|---|
| 读取面过滤 | 过期/timeline 立刻"看不见"，即时生效 | 遗忘的感受 |
| 评分降权 | 低分/久未复验沉底，不删但不浮现 | 记忆淡化 |
| 归档软删 | 移入 archive 表，可恢复可审计 | 放进阁楼 |
| 定期硬删 | archived 超 90 天物理删除 | 真正遗忘 |

---

## 4. 推荐方案 D 的细化设计

### 4.1 标签体系（两轴 + 状态机）

**时效轴（mem_class）**：

| 类别 | 定义 | 默认 TTL | 例子 |
|---|---|---|---|
| `permanent` | 通用方法论、架构事实、授权范围 | 无 | 经验卡、三闸门通过的打法 |
| `durable` | 目标相关事实，需复验刷新 | 30 天未复验→cooling | 资产存活、指纹、CORS 误配置 |
| `ephemeral` | 环境状态、临时故障、代理状态 | 7 天 | httpx 卡死类 [env-issue] |
| `timeline` | 执行流水、调度日志、日期快照 | 30 天归档，默认不可读 | "链健康""次日续排 id=17" |

**作用域轴（scope）**：`global` / `program:<id>` / `task:<id>` / `session`——读取时按当前任务 scope 过滤，session 级随会话消亡不落盘。

**状态机**：

```
active ──过期/零使用──► cooling ──持续衰退/neg_fb≥3──► archived ──90天──► (硬删)
  ▲                       │                              │
  └── promote（仅复盘）────┴──── 恢复（看板/复盘手动）──────┘

candidate ──复盘评审通过──► active   （permanent 层唯一入口）
```

### 4.2 写入门禁

| 写入方 | 规则 |
|---|---|
| 执行任务 worker | 可写 ephemeral/durable/timeline；exp_store 落 `candidate`；**禁直写 active permanent** |
| 复盘任务（review phase） | 唯一 promote 通道：三闸门评审（① 换目标可复用？② evidence 齐全？③ 已查重？） |
| 看板人工 | 全部操作可用，audit 留痕，human-verified 来源权重最高 |
| 目标特定事实 | 永远进 facts(durable)，**禁入 exp_cards**——卡只装可迁移方法论 |

### 4.3 读取隔离

| 读取方 | 默认可见 |
|---|---|
| 执行任务开局 | permanent(active) + 本 scope durable(active) + ephemeral(active 未过期)；**timeline 不可见** |
| 复盘任务 | 全量（含 timeline、archive、cooling）——只有复盘能"回忆过去" |
| exp_search 排序 | 现有 `FTS×10 + 余弦×20 + source×3 + confidence` + **score×2**；candidate 固定降权 |

### 4.4 评分淘汰（与卡片评分机制合并）

```
exp_cards 新增列: uses / adopted / pos_fb / neg_fb / score / status / last_used_at
score = adopted×3 + pos_fb×2 + uses×0.5 − neg_fb×5 − 天数衰减
淘汰: uses=0 且 >30 天 → cooling；cooling 再 30 天或 neg_fb≥3 → archived
```

### 4.5 Sweeper（扩展现有 retention.sh）

每日 timer 已在跑，新增 SQLite 阶段：
1. `expires_at < now` → cooling；
2. cooling 超 30 天 → 移入 `*_archive` 表；
3. archive 超 90 天 → 硬删；
4. 全程写 audit.jsonl。

### 4.6 提示词层纪律（三不原则，防 objective/persona 固化）

1. 临时环境故障**只进黑板**（`[env-issue]` 前缀 + 日期 + TTL 7 天）；
2. **不进 objective、不进 persona**——objective 只允许写"开局 blackboard_get 读 `[env-issue]` 键"这一条通用指引，不写具体故障内容；
3. 复盘任务每周巡检 `[env-issue]` 键：已修复验证后删除，未修复保留复核——黑板自净闭环。

### 4.7 遗留数据回填

1999 条存量（blackboard 1000 + facts 999），两条路线待选：
- **大清洗**：建一次性复盘任务，模型逐条分类回填（1-2 个工时，质量高）；
- **粗清洗**：`updated_at` 超 30 天未动的全部进 cooling，note/timeline 类键名匹配日期的直接 timeline 化（快，误伤需人工恢复）。

---

## 5. 待拍板决策点

| # | 决策点 | 选项 | 倾向 |
|---|---|---|---|
| 1 | 终态选型 | A（务实）/ B（理想大改）/ **D（混合）** | D |
| 2 | exp_store 是否收窄为候选晋升制 | 收窄（D 内含）/ 保持直写靠评分淘汰 | 收窄 |
| 3 | timeline 对执行任务可见性 | 完全不可读 / 可读近 3 天 | 完全不可读，靠复盘摘要衔接 |
| 4 | 遗留数据回填 | 大清洗（模型逐条）/ 粗清洗（规则批量） | 大清洗，分 program 两次跑 |
| 5 | 评分公式数值与淘汰阈值 | 按 §4.4 / 调整 | 按 §4.4 先跑一个月再调 |

---

## 6. 落地批次（与总方案对齐）

| 批次 | 内容 | 需重启 |
|---|---|---|
| 一（纯文本/DB） | httpx 清理（4 objective + 黑板）、AGENTS.md 三不纪律、键名前缀约定、报告路径统一 | ❌ |
| 二（代码） | mem_class/status/expires_at 三表扩展、写入校验、读取过滤、sweeper、exp 评分列+exp_feedback、exp_store 候选制、合并阈值 0.85→0.95、5 个 persona 补句、看板知识 tab | ✅ 一次 |
| 三（治理运转） | 每周 review interval 任务（晋升评审 + exp_validate + [env-issue] 巡检 + AGENTS.md 知识段重写）、遗留大清洗任务 | ❌ |
| 四（基础设施） | NAS vault 同步 + 卡片 md 导出桥 + kb_import 回流通道 | ❌ |
