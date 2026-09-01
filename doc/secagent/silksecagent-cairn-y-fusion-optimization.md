# SilkSecAgent × Cairn_Y 融合优化设计

> 版本：v1.1 · 2026-09-01
> 性质：**实施跟踪文档**。P17 FGS 框架（`fgs_nodes` 表 + 工具 + scheduler prompt 注入）已于 2026-09-01 随代码清理批次落地；当前 `fgs_nodes` 表为空，待 Decide/Execute 循环跑通产生运行节点。本文原设计 RFC 内容保留，现状描述以 2026-09-01 实测为准。
> 数据来源：2026-09-01 通过 `spool exec csai` 对 `/opt/silkspool/dsh/` 运行时实测，结合 `doc/secagent/` 现有文档与 2026-08-30~09-01 的任务执行调查。

---

## 目录

1. [背景与目标](#一背景与目标)
2. [现状核实（csai 实测）](#二现状核实csai-实测)
3. [Cairn_Y 核心思想与当前体系对比](#三cairn_y-核心思想与当前体系对比)
4. [融合设计原则](#四融合设计原则)
5. [具体优化方案](#五具体优化方案)
6. [实施路线图（三阶段）](#六实施路线图三阶段)
7. [预期效果与验收指标](#七预期效果与验收指标)
8. [风险与边界](#八风险与边界)

---

## 一、背景与目标

### 1.1 背景

Cairn_Y 是基于 Cairn 架构改进的 AI 自动化渗透引擎，以极简主义（0 Skill、0 RAG、0 MCP、无固定角色、不预设攻击流程）和「外化状态图」思想，在 TsecBench v1、Cybench、XBOW Validation Benchmarks 等公开榜单取得领先成绩。其核心创新包括：

- **FGS 图（Fact-Goal-Step Graph）**：把渗透测试建模为面向目标的状态空间搜索，Fact=已确认世界状态，Goal=终止条件（含动态 Sub Goal），Step=推动状态演化的因果动作。
- **Decide & Execute 双循环**：系统只有两类活动——Decide（评估状态、增删/排序 Step、提出 Sub Goal）和 Execute（执行工具、提交 Fact）。二者都是无状态的 Agent Loop，记忆完全外化在 FGS 图。
- **Finding 概念**：把搜索过程中发现的中间产物结构化，而不是只关注最终 Goal。
- **Less Is More**：提示词极短、不与安全任务耦合、不堆 Skill/RAG，让模型本身承担规划和路径选择。

### 1.2 当前 SilkSecAgent 的问题

SilkSecAgent 已经具备非常完整的平台工程（scope-guard、调度器、记忆基架、看板、合规护栏、流程守卫、噪声闸门、资产准入等），但近两天实测暴露出几个关键问题：

1. **产出密度低**：79,705 资产、51,159 个 S/A/B 级目标，最近 7 天 findings 仅 17 个 low + 1 个 medium，高价值漏洞靠偶发。
2. **任务执行偶发失败/拒执**：8 月 30 日字节 vuln 任务被模型以"授权不可验证"为由拒绝执行；同日美团 vuln 因 API 错误 `reasoning_content must be passed back` 失败。
3. **任务状态与实际结果不一致**：failed run 被标 done、模型拒绝执行的 run 也被标 done。
4. **IdeaCard 未入库**：头脑风暴生成的 IdeaCard 仅以 yaml 文件存在，未同步到 `exp_cards` 表，跨任务无法检索复用。
5. **长任务上下文腐烂**：3600s 预算硬顶，objective 仍较臃肿（500~700 字），模型在长时间运行后被自己的旧假设带偏。
6. **扫描面摊薄**：每日任务仍带有"覆盖面 100%"的隐含目标，51,159 个 S/A/B 资产与 1 小时预算不匹配。

### 1.3 目标

本优化设计的目标：**把 Cairn_Y 的状态空间搜索思想嫁接进 SilkSecAgent 已有的运营骨架，实现"更好、更快、更多"地挖掘漏洞，并让积累和沉淀真正有效。**

- **更好**：提高漏洞质量（medium/high 占比），减少误报和 info 噪声。
- **更快**：降低单次任务成本，减少无效扫描，把预算集中在高价值目标。
- **更多**：把每日任务的产出从" few low findings + 偶发拒绝"提升到"稳定发现新漏洞 + 持续产出 IdeaCard/PatternCard"。
- **积累和沉淀有效**：IdeaCard、PatternCard、MethodCard 自动入库、自动评分、跨任务检索复用。

---

## 二、现状核实（csai 实测）

### 2.1 健康度

```bash
spool exec csai "python3 /opt/silkspool/dsh/scripts/pipeline/discipline-audit.py"
```

输出（2026-09-01 11:01 +08:00）：

```
台账: {"bytedance": {"total": 134, "today": 42}, "meituan-src": {"total": 95, "today": 35}}
card_usage(7d)=21  handoff(7d)=9  IdeaCard=0
调度漂移: 无  task_runs 新鲜度: 1.5h
结论: 纪律在执行 ✔
```

```bash
spool exec csai "python3 /opt/silkspool/dsh/scripts/pipeline/data-quality.py"
```

输出：

```
✔ assets_ungraded: 544/79705 (0.7%) 未分级
✔ findings_noise_ratio: 信号 51 / 噪声 326（噪声已闸门隔离）
✔ schedule_drift: 0 个 interval 任务漂移
✔ task_runs_freshness: 最近执行记录 1.5h 前
⚠ assets_orphan_program: 106 条孤儿外键
⚠ dual_memory_store: blackboard 1051 键 / facts 1080 行
结论: 健康
```

### 2.2 资产与发现

| 指标 | 数值 |
|---|---|
| 总资产 | 79,705 |
| 未分级 | 544（0.7%） |
| S/A/B 活跃队列 | 51,159 |
| 非噪声 findings | high 6 / medium 10 / low 35 |
| 噪声 findings | 326（已隔离） |
| 经验卡 exp_cards | 4 张（2 candidate / 2 active） |
| IdeaCard 文件 | 6+ 张（未入库） |

### 2.3 任务状态

| 任务 | 项目 | 阶段 | 状态 | 下次运行 |
|---|---|---|---|---|
| #16 | bytedance | recon | queued | 2026-09-01 19:00 |
| #17 | meituan-src | recon | queued | 2026-09-01 19:10 |
| #18 | meituan-src | vuln | done | — |
| #19 | bytedance | vuln | queued | 2026-09-01 20:00 |
| #37 | meituan-src | vuln | queued | 2026-09-02 01:08（补跑） |

### 2.4 关键问题确认

1. **任务 #18 状态为 done，但最后一次 run（#59）failed**——状态与结果不一致。
2. **任务 #19 在 8 月 30 日被模型拒绝执行，但 task_runs.ok=1**——状态失真。
3. **任务 #37 首次运行被宿主重启中断，当前已重跑并产出 findings #377~#380**——稳定性仍有波动。
4. **exp_cards 仅 4 张，工作区 `vulncards/ideas/` 有 6+ 张 yaml 未入库**——沉淀断链。

---

## 三、Cairn_Y 核心思想与当前体系对比

### 3.1 任务建模对比

| 维度 | Cairn_Y | 当前 SilkSecAgent |
|---|---|---|
| 任务本质 | 状态空间搜索 | 流程化扫描编排 |
| 记忆载体 | FGS 图（Fact-Goal-Step） | 对话历史 + facts + exp_cards + 文件 |
| 规划方式 | Decide 循环从图生成 Step | objective 预设流程 + 覆盖矩阵 |
| 执行方式 | Execute 循环执行 Step 并提交 Fact | run_cli / spawn_worker 按流程调用工具 |
| 产物 | Finding（搜索过程发现） | finding（验证后漏洞）+ IdeaCard（文件） |
| 提示词 | 极短、通用、不与安全耦合 | 较长、角色化、内联安全纪律 |
| 知识库 | 0 RAG / 0 Skill | RAG（kb_docs）、Skill（sec-pipeline 等 7 个）、VulnCard 18 张 |

### 3.2 优劣势对照

**Cairn_Y 更好之处：**

1. **深层攻击链上限**：状态空间搜索能涌现出预设流程之外的组合利用链。
2. **上下文工程**：干净上下文重启 + 外化记忆，避免长任务上下文腐烂。
3. **幻觉控制**：只有被工具验证的 Fact 才写回图，天然过滤幻觉。
4. **模型红利承接**：提示词短且通用，换更强模型时系统直接变强。
5. **成本效率**：作者称 TsecBench 全量成本从 ~7000 元降到 <50 元。

**当前 SilkSecAgent 更好之处：**

1. **持续运营能力**：定时调度、资产生命周期、变更 diff、跨时间累积——Cairn_Y 没有。
2. **私有知识复用**：知识库、VulnCard、规则先验层对已知模式覆盖快。
3. **合规与护栏**：scope-guard、bwrap、审计、流程守卫、噪声闸门——Cairn_Y 未涉及。
4. **工程成熟度**：已在真实业务运行，DSH+pi 底座稳定。
5. **资产准入与分级**：79,705 资产的治理基架已经存在。

### 3.3 融合判断

**不要整体切换到 Cairn_Y。** 当前体系的运营层、合规层、资产层是核心资产，不能丢。应该把 Cairn_Y 的**状态空间搜索思想、FGS 图记忆、Decide/Execute 双循环、Finding 过程产物**嫁接到现有骨架上。

---

## 四、融合设计原则

### 4.1 保留层（不改动核心）

1. **运营层保留**：定时调度、资产收集、变更雷达、分级准入、流程守卫、噪声闸门、合规护栏。
2. **数据层保留**：asset-graph.db、tasks、task_runs、findings、facts、exp_cards、attempts TSV。
3. **合规层保留**：scope-guard、checkTarget、bwrap、审计、retention。

### 4.2 引入层（新增或改造）

1. **FGS 图作为任务状态外化**：每个 Task 运行时不只依赖 objective 和对话历史，而是维护一张 FGS 图。
2. **Decide/Execute 双循环替代固定流程**：每日 vuln 任务从"按 objective 顺序执行"变成"Decide 选 Step → Execute 执行 → 提交 Fact → 再 Decide"。
3. **Finding 作为过程产物**：搜索过程中产生的 tentative 发现也结构化入库，不一定等 confirmed。
4. **IdeaCard 自动入库**：头脑风暴产出直接调用 `exp_store` 写入 `exp_cards` 表。
5. **短 prompt + 纪律代码化**：objective 压缩到 150 字以内，纪律通过工具和守卫强制，不依赖提示词自觉。

### 4.3 关键取舍

- **不放弃 VulnCard**：VulnCard 对已知漏洞模式的确定性覆盖是优势，但只作为 Execute 的可用工具/Step，不再主导流程。
- **不放弃 RAG/知识库**：但知识库从"每轮注入"改为"工具查询"，不挡路。
- **不放弃流程守卫**：流程守卫继续存在，但守卫的粒度从"任务收尾三查"细化到"Step 级产物校验"。

---

## 五、具体优化方案

### 5.1 FGS 图数据模型设计

新增一张 `fgs_graph` 表（或复用 `facts` + `fact_edges` 扩展）：

```sql
CREATE TABLE fgs_nodes (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('fact','goal','step','finding')),
  -- fact: 已确认事实
  -- goal: 目标/子目标
  -- step: 待执行/已执行动作
  -- finding: 搜索过程发现
  status TEXT NOT NULL CHECK(status IN ('open','running','done','failed','blocked','deprecated')),
  content TEXT NOT NULL,          -- 结构化 JSON：{summary, detail, evidence, run_id, ...}
  score REAL DEFAULT 0,           -- 优先级/价值分
  created_at INTEGER,
  updated_at INTEGER,
  parent_id INTEGER REFERENCES fgs_nodes(id),
  depends_on TEXT                 -- JSON array of node ids
);
```

**与现有表的关系：**

- `fgs_nodes` 的 `finding` 类型在 confirmed 后同步到 `findings` 表。
- `fgs_nodes` 的 `fact` 类型在运行结束后同步到 `facts` 表。
- `fgs_nodes` 的 `step` 类型在运行结束后提取经验写入 `exp_cards` / `playbooks`。

### 5.2 Decide/Execute 双循环改造

#### 5.2.1 当前模式

```
定时任务启动 → 读取 objective → 按流程执行 → 收尾 → 标 done
```

问题：流程固定，模型没有空间根据中间结果调整策略。

#### 5.2.2 新模式

```
定时任务启动
  │
  ▼
Decide 循环（只读 FGS 图 + 操作 Step/Goal 的工具）
  │
  ├── 分析当前已确认 Fact
  ├── 评估 open Step 优先级
  ├── 增删 Step/Sub Goal
  └── 输出：下一步要执行的 Step 列表
  │
  ▼
Execute 循环（读 FGS 图 + 执行工具 + 提交 Fact/Finding）
  │
  ├── 执行 Step（调用 run_cli / spawn_worker / VulnCard 等）
  ├── 提交 Fact（工具结果验证）
  ├── 提交 Finding（过程发现）
  └── 更新 Step 状态
  │
  ▼
回到 Decide 循环，直到：
  - Goal 达成
  - 预算耗尽
  - 无 open Step
```

**关键纪律：**

- 每个 Step 必须关联一个 Goal/Sub Goal。
- 每个 Fact 必须有证据（run_id / evidence_path）。
- 每个 Finding 必须有证据和 confidence（tentative/confirmed）。
- Decide 每次从干净上下文启动，不携带历史对话。

### 5.3 Step 类型设计

Step 是 FGS 图中的"动作节点"，对应现有体系中的具体动作。新增/改造以下 Step 类型：

| Step 类型 | 对应现有能力 | 说明 |
|---|---|---|
| `recon_target` | subfinder/httpx/grade_assets | 对单个目标做 recon |
| `consume_card` | VulnCard detect/verify | 按卡片规程探测 |
| `intel_hunt` | intel_hunt | 指纹命中 N-day |
| `param_fuzz` | dalfox/arjun/sqlmap | 参数面测试 |
| `authz_diff` | authz_diff | 越权差分（需 H-002） |
| `brainstorm` | 研究模式 | 无预设目标时产生 IdeaCard |
| `verify_finding` | verify_replay | 对 tentative finding 机械复核 |
| `submit_draft` | submission_draft | CONFIRMED 后生成提交草稿 |
| `exp_store` | exp_store | 把经验写入卡片库 |

### 5.4 Finding 过程产物

新增 `findings` 表字段（或复用现有字段）：

```sql
ALTER TABLE findings ADD COLUMN confidence TEXT DEFAULT 'tentative' CHECK(confidence IN ('tentative','confirmed','false_positive','dup'));
ALTER TABLE findings ADD COLUMN fgs_node_id INTEGER REFERENCES fgs_nodes(id);
ALTER TABLE findings ADD COLUMN discovery_step TEXT; -- 哪个 Step 发现
```

**Finding 流转：**

```
tentative ──verify_replay──▶ confirmed ──submission_draft──▶ src_ready
    │
    └── 证伪 ──▶ false_positive
```

- `tentative` finding 不入日常报告信号面，但入 FGS 图和看板"待验证"视图。
- `confirmed` 才进入提交链路。

### 5.5 任务 objective 瘦身

当前 #16~#19 objective 约 500~700 字。改造后：

```markdown
【项目·phase·每日Slice】
Goal: 今日产出 ≥1 个 confirmed/tentative finding 或 ≥3 条 IdeaCard。
Sub Goal: 从 coverage_report 取 top-10 BLOCKED/PENDING 格子，每个转成 Step。
纪律: 全程 8899 代理；每 Step 结束必须提交 Fact；每 finding 必须 evidence；用完 VulnCard 必须 card_usage_log。
收尾: coverage_report → handoff-{date}.md → task_update done（流程守卫强制）。
```

目标字数控制在 150 字以内。具体规程进 sec-pipeline 技能，不内联。

### 5.6 IdeaCard 自动入库

当前问题：IdeaCard 生成在 `vulncards/ideas/IC-*.yaml`，未进 `exp_cards`。

改造：在 sec-pipeline 技能/工具中增加 `idea_store` 工具：

```javascript
// idea_store 工具
{
  name: 'idea_store',
  parameters: {
    scenario: '目标画像',
    takeaway: '一句话结论',
    evidence: ['run_id', 'finding_id'],
    verification_requires: ['条件1', '条件2'],
    first_testable_when: '满足什么条件可测试',
    related: ['VC-001', 'VC-003']
  },
  execute: async (a) => {
    // 1. 写 /home/silkspool/{program}/data/vulncards/ideas/IC-xxx.yaml
    // 2. 调用 exp_store 写入 exp_cards 表（status=candidate, source=实战）
    // 3. 返回 {id, file_path}
  }
}
```

**流程守卫增加**：vuln 任务标 done 前校验今日是否产生 ≥3 条 IdeaCard 或 ≥1 个 finding（当前已要求，但需 IdeaCard 入库才算数）。

### 5.7 聚焦高价值目标：从"覆盖面"到"搜索收益"

当前任务隐含"资产覆盖 100%"，导致 51,159 个 S/A/B 目标与 1 小时预算不匹配。

改造：

1. **每日预算分配**：
   - 60% 预算给 top-20 高价值目标（S 级 + 变化雷达新资产 + 历史 high/medium 同族）。
   - 30% 预算给覆盖矩阵中 BLOCKED/PENDING 解锁收益最高的格子。
   - 10% 预算给自由探索（研究模式、新思路验证）。

2. **目标价值分算法**：
   ```
   score = level_score(S=100, A=60, B=30, C=10)
         + history_bonus(同 program 历史 finding 附近 +40)
         + change_bonus(CT/JS 雷达新资产 +50)
         + card_match_bonus(命中 VulnCard applicable_when +30)
         - blocked_penalty(BLOCKED 格子按 blocker 类型扣减)
   ```

3. **Decide 循环根据 score 排序 open Step**，不人工预设顺序。

### 5.8 跨任务记忆复用

当前 `exp_cards` 仅 4 张，跨任务检索弱。

改造：

1. **每次任务启动时 Decide 循环先执行 `exp_search`**：
   - 按当前目标画像检索 active/candidate 卡。
   - 把命中卡的 id 作为 Step 依赖写入 FGS 图。

2. **每次 Step 执行后自动调用 `exp_feedback`**：
   - 不需要 agent 自觉回执，工具层自动记录 `useful`/`adopted`/`wrong`/`outdated`。

3. **每周 #24 复盘任务自动评审**：
   - 按 score/usage/hit/fp 排序。
   - candidate→active 自动晋升（adopted≥2 且 neg_fb=0 且 ≥7d）。
   - usage=0>30d 或 neg_fb≥3→cooling。

### 5.9 状态一致性修复

当前 task #18 done 但 run failed、task #19 模型拒绝但 ok=1。

改造：

1. **`taskFinishScheduledRun` 增加结果真实性校验**：
   - worker.log 包含 "I won't produce" / "拒绝执行" / 明确失败标记 → ok=false。
   - handoff/attempts 文件不存在或空 → 不允许标 done。

2. **任务状态机增加 `needs_review`**：
   - 当结果无法明确判断成功/失败时，状态置 `needs_review`，人工在看板确认后再转 done/failed。

3. **ops 健康度增加"状态一致性"指标**：
   - 每日扫描 `tasks.status=done` 但最近 task_runs.ok=0 的记录，自动告警。

---

## 六、实施路线图（三阶段）

### 阶段一：记忆架构手术（1~2 周，低风险高收益）

**目标**：先把对话历史记忆换成 FGS 图，不动流程和知识库。

| # | 动作 | 验收 |
|---|---|---|
| 1.1 | 新增 `fgs_nodes` 表 + DDL 迁移 | 表存在，旧数据无影响 |
| 1.2 | 新增 `fgs_*` 工具（fgs_add_fact / fgs_add_goal / fgs_add_step / fgs_add_finding / fgs_list / fgs_next） | 工具单测通过 |
| 1.3 | 改造 spawn_worker：任务启动时初始化 FGS 图，运行中每完成一个动作写 FGS，结束时导出 | worker.log 可见 FGS 摘要 |
| 1.4 | 任务 objective 瘦身到 ≤150 字 | #16~#19 objective 字数控在 150 以内 |
| 1.5 | 修复 taskFinishScheduledRun 真实性校验 | #18/#19 类型状态不一致不再出现 |

### 阶段二：Decide/Execute 双循环落地（2~3 周）

**目标**：把每日 vuln 任务从固定流程改造成 Decide/Execute 双循环。

| # | 动作 | 验收 |
|---|---|---|
| 2.1 | 新增 `decide` 工具（只读 FGS + 操作 Step/Goal） | 能从 FGS 图输出下一步 Step 列表 |
| 2.2 | 新增 `execute_step` 工具（执行单个 Step，调用底层 run_cli/VulnCard/authz_diff） | 每个 Step 有 run_id 证据 |
| 2.3 | 新增 `finding_tentative` 工具（tentative finding 入库） | 搜索过程发现可落库 |
| 2.4 | 改造 vuln 任务调度器：启动后先 Decide，再循环 Execute → Decide | 一次任务运行中可见多次 Decide/Execute 交替 |
| 2.5 | 新增 `idea_store` 工具（IdeaCard 自动入库 exp_cards） | 头脑风暴产出同时入库和写 yaml |
| 2.6 | 流程守卫增加 Step 级校验 | 无 evidence 的 Step 不允许标 done |

### 阶段三：智能聚焦与沉淀放大（3~4 周）

**目标**：让系统聚焦高价值目标，并让沉淀自动复用。

| # | 动作 | 验收 |
|---|---|---|
| 3.1 | 目标价值分算法落地 | 每日任务启动时输出 top-20 目标列表 |
| 3.2 | 预算分配策略落地 | handoff 中可见 60/30/10 预算分配 |
| 3.3 | exp_search/exp_feedback 自动触发 | Step 用卡自动记录 usage，执行后自动 feedback |
| 3.4 | 每周 #24 复盘自动评审 exp_cards | review-*.md 含卡片 ROI 排行 |
| 3.5 | 看板新增 FGS 视图 | 可看任务运行的 FGS 图、Step 状态、Finding 流转 |
| 3.6 | A/B 回归验证 | 抽 20 个历史目标，新旧系统盲跑，比较命中率和成本 |

---

## 七、预期效果与验收指标

### 7.1 量化指标

| 指标 | 当前 | 3 个月目标 |
|---|---|---|
| 每周 findings 数（非噪声） | ~3-5 个 low | ≥10 个，其中 medium+ ≥3 |
| 每周 IdeaCard 入库数 | 0 | ≥15 条 |
| exp_cards 总数 | 4 | ≥50 张 |
| 单次 vuln 任务成本 | 3600s 预算常打满 | ≤1800s，聚焦后命中密度提升 |
| 任务状态一致性错误 | 存在 | 0 |
| 高价值目标覆盖率（S/A 级） | 低 | top-100 S/A 目标每个季度至少被不同角度覆盖一次 |

### 7.2 质量指标

1. **每个 confirmed finding 必须有**：
   - FGS 图中的 discovery_step
   - evidence 包
   - verify_replay 复核记录

2. **每个 exp_cards 新增必须有**：
   - evidence 非空
   - justification ≥10 字
   - 自动评分信号

3. **每次任务 handoff 必须有**：
   - 执行的 Step 列表
   - 新增 Fact/Finding 数
   - 预算消耗分布

### 7.3 定性指标

1. 模型拒绝执行任务的现象消失。
2. 任务运行过程中能根据中间结果动态调整策略。
3. IdeaCard 不再只存文件，而能被次日任务自动检索复用。
4. 看板能展示"任务在思考什么"。

---

## 八、风险与边界

### 8.1 风险

| 风险 | 等级 | 应对 |
|---|---|---|
| FGS 图增加 DB 写入量 | 中 | 单任务节点控制在 500 以内；sweeper 自动归档 |
| Decide 循环调用模型次数增加 | 中 | 每次 Decide 只读图、输出 Step，token 可控；预算分配限制 |
| 模型在 Decide 阶段也拒绝执行 | 中 | objective 中明确"这是授权范围内的自动化任务"；配合 H-002 凭据到位 |
| 改造期间日常任务中断 | 高 | 阶段式落地，每个阶段都有回滚方案；保留旧任务 objective 作为 fallback |
| 状态一致性校验误伤正常任务 | 低 | 先告警不拦截，观察 1 周后再强制 |

### 8.2 边界

1. **不替代人工审校**：CONFIRMED finding 仍需人工确认后提交 SRC。
2. **不放开 intrusive 级操作**：Decide/Execute 仍受 scope-guard 和 risk 级别限制。
3. **不丢弃现有合规**：FGS 图本身也受 audit.jsonl 审计。
4. **不针对具体靶场/榜单优化**：借鉴 Cairn_Y 思想，但优化目标是真实 SRC 产出。

### 8.3 先决条件

1. **H-002 SRC 测试账号注册**：解锁越权/逻辑/登录态面，这是产出 medium/high 的关键。
2. **H-001 OOB 域名 NS 委派**：解锁盲 SSRF/盲注/盲 RCE。
3. **DSH 0.1.2 升级窗口**：部分工具接口改造依赖 DSH 新版本能力。

---

## 九、结论

SilkSecAgent 的平台工程和纪律体系已经非常完整，当前最大的瓶颈不是"缺能力"，而是"任务的规划与记忆方式仍停留在流程说明书时代"。

**Cairn_Y 给我们的最大启示不是"0 Skill / 0 RAG"，而是：把状态外化成图，让模型在图上做搜索，而不是在对话历史里做背诵。**

本设计通过三阶段改造：

1. **阶段一**：把记忆从对话历史迁到 FGS 图，先解决上下文腐烂和状态不一致。
2. **阶段二**：把每日任务从固定流程改造成 Decide/Execute 双循环，让模型根据中间结果动态调整。
3. **阶段三**：用价值分算法聚焦高价值目标，并用自动入库/自动评分让沉淀真正复用。

实施完成后，SilkSecAgent 将同时具备：

- **当前体系的运营成熟度**（资产、调度、合规、看板）
- **Cairn_Y 体系的搜索上限**（状态空间搜索、过程产物、动态规划）

这才是适合真实 SRC 场景的"更好、更快、更多"的漏洞挖掘系统。

---

*文档作者：OpenCode · 2026-09-01*
*数据来源：csai 运行时实测 + doc/secagent/ 文档审读 + Cairn/Cairn_Y 公开资料*
