# SilkSecAgent 统一记忆基架设计（Memory Substrate）

> 版本：v2.0 终版（替代 v1 讨论稿）｜ 日期：2026-08-25 ｜ 状态：**已定型，待实施**
> 决策记录：候选方案 A（元数据标签制）+ B（分层记忆制）融合，**不采用 C 过渡方案**；
> 用户三要求：① 晋升/遗忘/分类全部代码硬实施强监管；② 容错托底——无周复盘系统也健康运转；
> ③ 保留弹性——底线之上写入方自主思考，思考留痕即可采纳。不怕动数据、不怕动代码。

---

## 0. 三条设计原则

1. **提示词负责智慧，代码负责纪律。** 提示词只教写入方"怎么思考"，监管全部在代码里。
2. **复盘是加速器，不是单点。** 所有关键流转（晋升/降级/归档/摘要）都有自动通道，复盘只做增强。
3. **permanent 层只有一种居民。** 事实永远会过期，只有方法论配永久——永久层 = 经验卡/打法，且只能晋升进入，禁止直写。

---

## 1. 背景（csai 实测，v1 取证）

- 所有记忆面（blackboard 1000 键 / facts 999 条 / exp_cards / playbooks）共享错误默认："写下即永久、全员默认可读"；
- 三类污染：时效污染（流水永久化，facts 中 note 类已 396 条）、失效污染（`httpx-blocked-env` 与 `httpx-fixed` 矛盾并存）、粒度污染（目标事实与可迁移方法论混层）；
- httpx 事件定性：故障文本固化在 4 个 interval 任务 objective + 黑板旧 note，属动态层污染；
- 现成设施：retention.sh 每日 timer（只管文件不管库）、`/silksec-dashboard` RPC 通道、playbooks 的 runs/successes 统计设计。

---

## 2. 架构总览：一个生命周期引擎，所有记忆面共用

新建 **`dsh-plugin-sec-suite.lifecycle.js`**（独立模块），提供四个统一原语。状态机、校验、过滤、清扫**只写一份**；blackboard / facts / exp_cards 及未来任何新记忆表，只要带统一列组并注册进引擎，即自动获得全部治理能力——不冗余的关键。

```
┌─────────────────────────────────────────────────────┐
│ lifecycle.js（唯一治理引擎）                          │
│  validateWrite()     写入校验（底线硬约束 R1-R7）      │
│  visibilityFilter()  读取过滤（读者角色×状态×scope）   │
│  transition()        状态机（唯一状态转换入口）         │
│  sweep()             每日清扫（降级/归档/硬删/自动晋升） │
└────────┬──────────────┬──────────────┬──────────────┘
    blackboard        facts        exp_cards      （未来新表）
```

### 2.1 统一列组（每张记忆表）

| 列 | 说明 |
|---|---|
| `mem_class` | permanent / durable / ephemeral / timeline |
| `scope` | global / program:\<id\> / task:\<id\> / session（session 级不落盘） |
| `status` | candidate / active / cooling / archived |
| `expires_at` | ephemeral 必填 |
| `revalidate_by` | durable 必填（复验期限） |
| `justification` | 写入理由（思考证明，见 §3） |
| `last_validated_at` | 最近复验时间 |
| 评分组 | `uses / adopted / pos_fb / neg_fb / score / last_used_at`（timeline 不参与） |

归档出口：每张表对应 `*_archive` 表（同构 + `archived_at` / `archive_reason`）。

---

## 3. 写入协议：底线代码卡死，上限写入方自主

每次写入必须携带 **intent 声明**：

```json
{ "mem_class": "ephemeral", "ttl_days": 5, "scope": "program:meituan-src",
  "justification": "代理池 8899 端口今日三次超时，疑临时封禁，复验后即可删" }
```

### 3.1 底线（代码硬校验，违反即拒绝）

| # | 规则 | 处理 |
|---|---|---|
| R1 | mem_class ∈ {permanent, durable, ephemeral, timeline}，必填 | 拒绝 |
| R2 | **permanent 禁止直写**，只能经 promote 进入 | 拒绝 |
| R3 | ephemeral：TTL ∈ [1小时, 30天]，写入方区间内自选 | 拒绝 |
| R4 | durable：revalidate_by ∈ [7天, 90天]，自选 | 拒绝 |
| R5 | fact/exp 类 evidence 非空（沿用验证铁律） | 拒绝 |
| R6 | justification ≥ 10 字且非占位符——**只验"思考过"，不审内容质量** | 拒绝 |
| R7 | timeline 只追加、不可改写（流水不可变） | 拒绝 update |

### 3.2 弹性（写入方自主空间）

类别判断、TTL 长短、scope 宽窄由写入方按 `skills/sec-knowledge` 的思考指引自行决定，过 R1-R7 即采纳。justification 全程留痕（audit.jsonl）。

**预留扩展点（一期不实现）**：按写入方（agent/worker）统计 justification 质量形成"写入信用分"，低信用写入者的卡片初始降权。

---

## 4. 状态机与双通道晋升

```
candidate ──❶复盘评审 promote──┐
    │                          ▼
    └──❷自动晋升（托底）──► active ──TTL过期/零使用30d/neg_fb≥3──► cooling
         adopted≥2 且 neg_fb=0        ▲                            │
         且存活≥7天（sweeper 执行）    └──❸用到即复验复活──           │
                                                              再衰退30d
                                                                 ▼
         timeline: active ─30d─► archived（纯老化，不评分）    archived ─90d─► 硬删
```

| 通道 | 机制 | 性质 |
|---|---|---|
| ❶ 评审晋升 | 周复盘三闸门（换目标可复用？evidence 齐全？已查重？） | 加速器：快、质量高 |
| ❷ 自动晋升 | candidate 被不同 run 实际采用 ≥2 次、零负反馈、存活 ≥7 天 → sweeper 自动升 active | **托底**：无复盘好用的卡照样浮现 |
| ❸ 自愈复活 | 执行任务读到 cooling 的 durable 可现场复验，`last_validated_at` 刷新即回 active | 常用事实永不死，冷门自然沉 |

### 4.1 评分公式

```
score = adopted×3 + pos_fb×2 + uses×0.5 − neg_fb×5 − 天数衰减
降级: uses=0 且 >30 天 → cooling；cooling 再 30 天或 neg_fb≥3 → archived
检索排序: FTS×10 + 余弦×20 + source×3 + confidence + score×2；candidate 固定降权
```

---

## 5. 读取隔离（代码强制）

| 读者 | permanent active | candidate | durable active | durable cooling | ephemeral active | timeline | archived |
|---|---|---|---|---|---|---|---|
| 执行任务 | ✅ | ✅ 降权 | ✅ | ✅ 带"待复验"标记 | ✅ | ❌ | ❌ |
| 复盘任务 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 6. 容错托底总表

| 失效场景 | 系统行为 |
|---|---|
| **周复盘停跑** | 自动晋升/sweeper 降级归档硬删/AGENTS.md 每日自动重写/评分沉浮照常；仅损失"晋升加速、质量审查、碎片合并"三个增强项 |
| sweeper 停跑 | 读写路径**惰性降级**（读到过期项即时 transition），可见性不错乱；恢复后补扫 |
| 写入方乱标类别 | 底线校验挡硬错误；误标卡靠评分+零使用自动沉没；justification 可审计追责 |
| embedding 服务挂 | FTS 检索照常；语义合并降级为 scenario 精确匹配 |
| 复盘误判晋升 | neg_fb + 评分衰减自动纠错下沉 |
| 合并事故（既往 0.85 阈值） | 阈值收紧 0.95 才合并覆盖 takeaway；0.85~0.95 只追加证据 + warning |

---

## 7. AGENTS.md 自动化（引擎产物，非复盘产物）

sweeper 每日重写 `AGENTS.md` 受管区块（`<!-- memcore:begin/end -->` 标记内）：
- Top N 高分 permanent 卡摘要（只摘要 + ID，不铺全文）；
- 当前 active 的 `[env-issue]` 清单；
- 写入/读取纪律一句话指引。

人工内容写标记外。复盘可补充，但引擎不缺位。

---

## 8. 提示词层定位（极薄，架构级红线）

提示词只剩两件事（skills/sec-knowledge + AGENTS.md 受管区块）：
1. **写入思考指引**："写记忆前回答三问：它会过期吗？换目标还有用吗？谁会读它？——答案写进 justification"；
2. **读取纪律**："cooling 标记的事实用到即复验"。

**红线**：persona/objective 从此禁止承载任何具体事实、故障、状态。兜底：sweeper 顺带做 "objective lint"——扫描 interval 任务 objective 中的日期/故障关键词，命中即看板告警。

---

## 9. 数据迁移（一次到位）

存量 1000 黑板键 + 999 facts，规则迁移 + 抽样验证：
1. 键名含日期 / `alive:*` / `scan:*` → `timeline`；
2. `note:*`、env 相关 → `ephemeral`（TTL 7 天，到期自然消亡——含 httpx-blocked-env，无需手工删）；
3. `asset/target/finding` 类 facts → `durable`（revalidate_by 30 天）；
4. 迁移后一次性抽检任务（抽 5% 模型核对），误标看板手动修正。

---

## 10. 实施批次

| 批次 | 内容 | 需重启 |
|---|---|---|
| 一 | **lifecycle.js 引擎**：validateWrite / visibilityFilter / transition / sweep；三表统一列组迁移 + archive 表；存量规则迁移 | ✅ |
| 二 | 三插件接入引擎（blackboard/facts/exp 读写全走原语）；exp_store 候选制；exp_feedback/exp_update/exp_deprecate；合并阈值 0.95；AGENTS.md 生成器；objective lint | ✅（与批次一合并为一次重启） |
| 三 | 看板知识 tab（列表/评分/编辑/弃置/新增/恢复，走 /silksec-dashboard RPC）；sec-knowledge 技能；5 个执行型 persona 补开局检索一句 | ✅ |
| 四 | 每周 review interval 任务（三闸门评审加速 + 碎片合并 + 质量审计）；报告路径统一；NAS vault 同步 + 卡片 md 导出桥 + kb_import 回流 | ❌ |

---

## 11. 参数表（集中可调，先跑一个月再校准）

| 参数 | 默认值 |
|---|---|
| ephemeral TTL 区间 | 1小时 ~ 30天 |
| durable 复验区间 | 7 ~ 90天 |
| 自动晋升阈值 | adopted≥2 且 neg_fb=0 且存活≥7天 |
| 降级阈值 | uses=0 且 >30天 / neg_fb≥3 |
| cooling→archived | 30天 |
| archived→硬删 | 90天 |
| timeline 归档 | 30天 |
| 语义合并阈值 | 0.95（0.85~0.95 仅追加证据） |
