# 23 · LLM 供给联动调速（Campaign × Bellkeeper 池额度感知）设计方案

> 日期：2026-09-22（v2 修订：补 SenseNova 双积分池实测口径 + OpenCode Go v4.1-flash 入池 + 统一额度面）
> **v3 修订（2026-09-23）**：① SenseNova 渠道与 OpenCode Go 均已支持 `deepseek-v4.1-flash`，并升格为 **SenseNova 主力模型**（替代 glm-5.2 的默认主力位）；② 直面「Bellkeeper 只管额度、单一模型链条」现状的不足，新增 **任务级智能选模型**（§3.7）：专项派发时按任务强度/复杂度 × 各模型可用性 × 积分池/美元额度自主选模型——dsh 有选模型能力则派生负载带 model_hint，否则交 Bellkeeper LLM 侧策略路由（Path A/B 两路径）。
> 性质：**已全量落地（实现态，2026-09-23）**——task 域内调速组件（LlmSupplyWatch / `decideThrottle` / 任务分档选模型 / 统一额度面 / 看板供给徽章 / 预算自动爬坡）完成并部署 csai（本地全量契约 575/575；accept PASS=72 FAIL=0；线上 `campaign_tick` 返回 `supply_factor=1`）；**步骤 0.5**（Bellkeeper sensenova 加 `deepseek-v4.1-flash` 权重 7 入池）、**步骤 2.5**（配置化 `pool-secagent-lite`/`pool-secagent-heavy` 分档组 + dsh `task_class` 映射）、**步骤 5 Path A**（worker `model-patch` 指定模型）均已落地并线上验证；**步骤 4** kimi-code 入池评估结论见 §五.6。回填见 [05-task §7.10](05-task.md) 与 [16-dashboard](16-dashboard.md)。
> 动机：22 号方案的 Campaign 专项是常驻持续推进实体（L1/L2 自动派生），其执行面全部经 Bellkeeper `pool-secagent` 消耗 LLM 额度。池成员的套餐有独立额度窗口（SenseNova 滚动 5h/周双积分池、OpenCode Go $12/5h+$30/周+$60/月美元额度、deepseek-secagent 500 rpd），额度耗尽时渠道熔断。**专项若无视供给状态继续派生，会批量产生失败任务**（烧窗口预算、污染连败黑名单、触发错误降级）。
> 上游：[archive/22-campaign-task-2026-09-22.md](archive/22-campaign-task-2026-09-22.md)（Campaign 本体）；[17-llm-surface.md](17-llm-surface.md)（模型层零改动纪律）。
> 总原则：**不新增域**；供给调速是 task 域内 Supervisor 的第六信号 + Dispatcher 的一道前置闸。Bellkeeper 侧原则上只读其现有 API；**v3 例外收窄**：仅允许 Bellkeeper 配置面变更（渠道/池成员表、pool-secagent 组策略，走其 DB API），不动其路由/熔断/计费代码路径（§3.7 Path B）。

---

## 一、一页结论

1. **Bellkeeper 已有全部所需观测面**（2026-09-22 实测）：`GET /api/llm/health`（渠道熔断 state + breakdown_class）与 `GET /api/llm/channels/status`（daily_used/daily_limit/令牌桶余量/健康）。**零改造读取**，鉴权复用 `BELLKEEPER_LLM_API_KEY`（环境变量引用，零明文——宪法 §十四.4）。
2. **方案一句话**：task 域新增 **LlmSupplyWatch（供给哨兵）**——tick 顺带拉取 pool-secagent 成员健康，规则层纯函数 `decideThrottle` 算出**供给因子 supply_factor ∈ {0, 0.4, 1.0}**；Dispatcher 派生闸叠加「有界 × 供给因子」取严；供给归零时 L2 专项自动降级 L1（产草稿不下发），供给恢复自动回弹并补派积压。**所有可调整项集中在 dsh .env 一个区块（统一额度面，§3.6）**，一处修改全局生效。
3. **与 5h 套餐窗口的相处**：不猜重置时间——以 Bellkeeper 熔断状态为唯一真相源（其自带 30min 恢复探针 + ~5h 重武装）。专项侧只在「渠道 quota_exhausted 熔断中」降速/停派，熔断解除（closed）即恢复，天然贴合滚动 5h 窗口而无需计时（SenseNova 5h 窗口为**滚动窗口非定点清零**，见 §2.1——任何「到点全速」的计时策略都会猜错）。
4. **三闸取严**：per-program 周期预算闸（既有）∧ campaign 窗口预算闸（22 号）∧ **供给闸（本方案）**——任一停派。INV-C11 新增。
5. **看板**：任务视图专项卡片加「供给」徽章（正常/降速/停派）；checkpoint 留痕每次调速变化，可追溯「为什么这小时没派生」。
6. **任务级智能选模型（v3 新增，§3.7）**：现状 Bellkeeper 只做额度管理与单一权重链条（主力打满→熔断→整链降级兜底），不看任务难度，额度使用效果并不好。本方案让**专项派发成为模型选择决策点**：按任务强度/复杂度分档（lite/std/heavy），结合各模型熔断状态与积分池/美元额度自主选模型——通用积分池主力 `deepseek-v4.1-flash`（v3 升格），轻任务优先烧 Flash-Lite 专属池（1:1 返赠反哺通用池），重任务/长上下文上 glm-5.2 或 Go v4.1-flash。dsh 具备选模型能力则派生负载带 model_hint（Path A），否则由 Bellkeeper LLM 侧策略路由承接（Path B，先落地）。

---

## 二、现状实测（2026-09-22，设计输入）

### 2.1 pool-secagent 成员与额度实测（v3 修订）

| 渠道 | 池内角色（weight） | 实时状态 | 额度口径 |
|---|---|---|---|
| sensenova-secagent | **ds-v4.1-flash（7，v3 升格主力）** → glm-5.2（6，重任务/长上下文）→ flash-lite 256K 专属积分（5，轻任务档）→ ds-v4-flash（4，旧主力兜底） | closed | **双积分池**（下表）+ rpd 20000 |
| deepseek-secagent | 权重 3 | closed | rpd 500（付费，刻意保守，保底账） |
| opencode-go-secagent | **v4.1-flash（2）** → v4-flash（1，兜底） | closed | **$12/滚动5h · $30/滚动周 · $60/月**（官方口径），rpd 20000 |
| kimi-code（**未入池**，候选） | — | closed（daily 1/50000） | **套餐 ~5h/7d 重置窗口**（Bellkeeper kimiCodeProbeLoop 注释证实） |

> v3 说明：SenseNova 渠道已上线 `deepseek-v4.1-flash`（与 OpenCode Go 同步支持），作为 **SenseNova 系主力模型**权重置顶。glm-5.2 降为「重任务/长上下文档」，flash-lite 降为「轻任务档」（能力弱于 v4.1-flash，不再无条件置顶——见 §3.7 返赠收益逻辑），ds-v4-flash 保留旧主力兜底位。

**SenseNova 双积分池实测（2026-09-22 用户账户截图口径，公测免费期）：**

| 池 | 5h 滚动窗口 | 周滚动额度 | 当前余额 | 说明 |
|---|---|---|---|---|
| 通用积分池（全 Free 模型可用：**ds-v4.1-flash 主力**/glm-5.2/ds-v4-flash 等） | 60,000 / 窗（上次重置 9-21 22:10） | 600,000（下次重置 9-23 18:10） | 333,569 + 活动固定 105,067（2026-10-19 到期） | 主力，标准/重任务消耗此池 |
| Flash-Lite 专属池 | 60,000 / 窗 | 600,000 | 428,473 | 仅 flash-lite 可用，能力较弱；消费 **1:1 返赠通用积分**（返赠不占滚动额度，~1h 到账，30 天有效）——**轻任务烧专属池 = 近似零成本且反哺通用池额度** |

推论（v3 修正）：**flash-lite 是最廉价供给但能力弱**，不再无条件置顶；正确姿势是**任务分档**——轻任务优先烧专属池赚返赠，标准/重任务用通用池 ds-v4.1-flash 主力保证质量（§3.7）。flash-lite 256K 上下文限制仍由成员 max_context_tokens 由 Bellkeeper 路由自动跳过超长请求（17-llm-surface 纪律不动）。

**OpenCode Go（v2 变更，已上线）**：`deepseek-v4.1-flash` 已加入渠道模型表与池成员表（权重 2，介于官方 deepseek 与 v4 兜底之间），实测路由冒烟通过（2026-09-22）。美元额度与 SenseNova 积分池正交，构成第二条供给曲线——SenseNova 5h 窗口打满时 Go 的 $12/5h 窗口大概率仍有量。

> **Bellkeeper 配置真相源备注**：llm_channels / llm_model_groups 为 **DB 持久化**，YAML 仅首启空库种子（SeedLLMProxyConfig）。渠道/成员表变更须走 `PUT /api/llm/config/channels/:id` / `PUT /api/llm/config/groups/:id`（自动触发 reload），改 YAML 对运行实例无效。本次 v4.1-flash 入池即走此路径；bellkeeper.yaml 同步更新保持种子一致（Bellkeeper commit cb0572d）。

### 2.2 教训与约束

- deepseek-direct 当天已用 132/500——**rpd 500 级渠道在持续挖掘下半天就能打满**，调速不是理论需求；
- Bellkeeper 熔断恢复：自带 `kimiCodeProbeLoop`（30min tick，探针恢复则 closed，否则重武装 ~5h）——专项侧**不做自己的探针**（避免浪费额度探测），只读状态；
- 17-llm-surface 纪律：模型层零改动——本方案**不碰** settings.yaml/路由/熔断/dsh-bill，只在任务派生层节流。
- **Bellkeeper 现状的两点不足（v3 直面）**：① 只做额度/熔断管理，**没有任务感知**——一条固定权重链条自上而下消费，主力模型打满即熔断整链降级，额度使用效果并不好（轻任务烧主力积分、重任务被弱模型接单两种情况同时存在）；② 单一模型链条意味着「供给侧的丰富度」（双积分池 × 返赠机制 × 多美元渠道）没有被任务侧利用。这正是 §3.7 任务级智能选模型的动机。

---

## 三、设计

### 3.1 组件：LlmSupplyWatch（task 域内，Supervisor 第六信号）

**采集器**（tick 顺带，60s 一次与 campaign tick 同周期；进程内 60s 缓存防抖动）：

```
GET /api/llm/channels/status  → 每渠道 {name, health.state, breakdown_class, daily_used, daily_limit, available_tokens}
pool-secagent 成员表（统一额度面 SEC_CAMPAIGN_POOL_MEMBERS，默认 sensenova-secagent,deepseek-secagent,opencode-go-secagent）
```

> 口径说明：channels/status 的 daily_used/daily_limit 是 Bellkeeper 自己的 rpd 令牌桶口径（sensenova rpd 20000 是保守配置值，**不等于** SenseNova 实际积分余额）。真实积分池余量只有 SenseNova 控制台可见——因此余量比规则（<15% 降速）只防「Bellkeeper 桶打满」这一层；积分池级耗尽的兜底仍靠熔断状态（quota_exhausted）。滚动 5h 窗口不可预测，不做窗口对齐猜测。

**决策纯函数** `decideThrottle(members) → { supply_factor, detail[] }`（确定性可重放，契约测试钉死）：

| 规则 | supply_factor | 语义 |
|---|---|---|
| 全部成员 open 或 quota_exhausted 熔断中 | **0** | 停派：L2→L1 降级 + checkpoint(llm_throttled)，在跑子任务不动 |
| 主力成员（weight ≥4，即 sensenova 三成员）熔断，兜底可用 | **0.4** | 降速：derive_cap 折算（8→3），checkpoint 记录 |
| 主力可用但 daily 余量 <15%（SEC_CAMPAIGN_SUPPLY_WARN_RATIO 可调） | **0.4** | 预防性降速（rpd 桶尾段保护） |
| 其余 | **1.0** | 全速；从 0/0.4 回弹时 checkpoint(llm_restored) |

> v3 权重门槛说明：ds-v4.1-flash 升格后权重序列为 7/6/5/4（sensenova）→ 3（官方 ds）→ 2（go v4.1）→ 1（go v4）。「主力」= weight ≥4 即 sensenova 系；权重 ≤3 为兜底链（付费官方 → Go v4.1 → Go v4）。factor=0.4 时专项仍在跑，只是靠兜底链低速推进——这正是「双供给曲线」设计意图。注意：权重只是**缺省路由顺序**，任务级选择（§3.7）可越过权重按档指定模型。

**接线点**：
- `runCampaignTick` 的 Planner/Dispatcher 段前计算 supply_factor；factor=0 跳过派生段（Supervisor/Reviewer/LearnLink 照常——验收不烧 LLM）；
- `dispatchDrafts` 的有效上限 = `ceil(derive_cap_per_tick × supply_factor)`；
- `campaign_dispatch`（显式路径，人/模型）同样过供给闸：factor=0 时 `E_CAMPAIGN_LLM_EXHAUSTED`（retryable:true，hint「LLM 池额度熔断中，Bellkeeper 探针恢复后自动回弹」）——人工紧急派生可经 dashboard 放行（现有预算闸同款人工通道）。

### 3.2 与自主级别的联动

| autonomy | factor=0 | factor=0.4 | factor=1.0 |
|---|---|---|---|
| L0 台账 | 无影响（无自动派生） | 无影响 | 无影响 |
| L1 建议 | 照常产草稿（不烧额度） | 照常 | 照常 |
| L2 有界自动 | **自动降级 L1** + checkpoint(autonomy_change) | cap 折算 | 全速；恢复时不自动升回 L2（需人工 review_pass 确认——防震荡） |

**降级不回弹**是有意的：供给反复震荡时自动升降会产生抖动派生，恢复后由人审一次性确认。

### 3.3 不变量与错误码（新增）

| ID | 内容 | 失败语义 |
|---|---|---|
| INV-C11 | 派生前供给闸：supply_factor=0 ⇒ tick 路径静默跳过（checkpoint 可观测），显式路径报错 | `E_CAMPAIGN_LLM_EXHAUSTED` |
| INV-C12 | 供给观测失败（Bellkeeper 不可达/超时 3s）⇒ **fail-open 为 1.0** 但有界降级：derive_cap 取 min(cap, 2) 并记 checkpoint(llm_probe_failed)；连续 3 tick 失败 ⇒ 转 fail-closed factor=0 | — |

INV-C12 的「先降速、持续失败再停派」是可用性与防烧余额的折中：短时网络抖动不该停摆挖掘，持续失联才停。

### 3.4 数据与事件

- 无新表。调速历史全部走 `campaign_checkpoints`（kind 增 `llm_throttled` / `llm_restored` / `llm_probe_failed`，payload 存成员健康快照）。
- 事件复用 `task.campaign.escalated`（factor=0 停派发一次，checkpoint 幂等防抖：同因子不重复发）。
- 看板：`campaign_list` 行聚合最近供给 checkpoint → 专项卡片「供给」徽章（正常绿 / 降速黄 / 停派红），复用授权时效徽章三态组件。

### 3.5 与 dsh-bill / spent_tokens 的一致性

供给闸管「要不要派」，预算闸管「花了多少」——两者正交。spent_tokens 归因链不动（INV-T14）；supply_factor 不进 dsh-bill（计费真相源不变）。

### 3.6 统一额度面（v2 新增：一处调额度）

**问题**：供给调速涉及的可调参数散落在多处（池成员、权重门槛、降速比例、derive_cap、各 campaign 窗口预算），调额度要改多个位置易漏。

**设计**：全部调速参数集中到 **dsh `.env` 单一区块**（环境变量组，task 域启动读取，零代码调整额度）：

```
# ===== 专项 LLM 供给统一额度面（23 号方案） =====
SEC_CAMPAIGN_SUPPLY_GATE=on                 # 供给闸总开关（off 回到现状）
SEC_CAMPAIGN_POOL_MEMBERS=sensenova-secagent,deepseek-secagent,opencode-go-secagent
SEC_CAMPAIGN_SUPPLY_MAIN_WEIGHT=4           # ≥此权重视为「主力」（熔断触发 0.4 档）
SEC_CAMPAIGN_SUPPLY_WARN_RATIO=0.15         # rpd 桶余量低于此比例触发 0.4 档
SEC_CAMPAIGN_SUPPLY_SLOW_FACTOR=0.4         # 降速因子（derive_cap 折算乘数）
SEC_CAMPAIGN_SUPPLY_PROBE_TIMEOUT_MS=3000   # 观测超时（INV-C12 两阶段）
SEC_CAMPAIGN_DERIVE_CAP_PER_TICK=8          # 每 tick 派生上限（v2 调高：5→8）
SEC_CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT=30000 # 草稿预估（既存，统一迁此区块）
SEC_CAMPAIGN_DEFAULT_BUDGET_TOKENS=2000000  # 新建专项默认窗口预算（v2：500k→2M/7d）
# --- v3 新增：任务级智能选模型（§3.7） ---
SEC_CAMPAIGN_MODEL_STRATEGY=auto            # auto=按任务分档+额度自主选；weight=退回旧纯权重链（回滚用）
SEC_CAMPAIGN_MODEL_MAIN=deepseek-v4.1-flash # SenseNova 主力模型（v3 升格）
SEC_CAMPAIGN_MODEL_MAIN_FALLBACK=glm-5.2,deepseek-v4-flash  # 主力熔断时的池内顺延序
SEC_CAMPAIGN_FLASHLITE_FIRST=on             # 轻任务优先烧 Flash-Lite 专属池（赚 1:1 返赠）
SEC_CAMPAIGN_MODEL_SELECTOR=dsh             # dsh=派生负载带 provider+model（Path A）；bellkeeper=仅标注 task_class 交 Bellkeeper 侧路由
SEC_CAMPAIGN_CLASS_GROUPS=lite:pool-secagent-lite,std:pool-secagent,heavy:pool-secagent-heavy  # task_class → Bellkeeper 模型组（分档路由 + 组内熔断顺延）
```

> **v3.1 实现说明（2026-09-23 落地）**：Path B 以 **配置化模型组**承接——Bellkeeper 新建 `pool-secagent-lite`（flash-lite 优先）/ `pool-secagent-heavy`（glm-5.2+v4.1-flash）两个模型组，dsh 按 `task_class` 映射组名并作为 `model` 下发（Path A 的 worker `model-patch` 通道），组内保留健康过滤 + 熔断顺延，等价实现「按 task_class 分档路由 + 首选熔断顺延」且**无需改动 Bellkeeper 路由代码**。`SEC_CAMPAIGN_MODEL_SELECTOR=bellkeeper` 时仅带 `task_class` 元数据，交 Bellkeeper 侧策略（需其路由代码支持 `X-Task-Class`，尚未实施）。

**campaign 窗口预算调高路径（v2，尊重既有校验）**：新建专项默认 2M/7d（`SEC_CAMPAIGN_DEFAULT_BUDGET_TOKENS`，campaign_create 缺省读取）。**存量专项不走破例直改**——`campaign-budget-extend` 的 validate 铁律（spent ≥ 80% 才准延长、单次 ≤ 原预算×2）是防囤预算设计，保留不动。配套小增强（步骤 1.5）：Supervisor 在 `budget_low` checkpoint 时**自动提请** campaign-budget-extend（request_actors 已含 scheduler，tick 路径天然合规）——在跑的两个专项（500k）到达 400k 水位即自动 +1M → 1.5M → 后续平滑爬坡至 2M+，全程审批留痕、零人工介入。

### 3.7 任务级智能选模型（v3 新增：派生时的模型自主决策）

**问题（现状）**：Bellkeeper 只做额度/熔断管理，pool-secagent 是**单一权重链条**——所有任务不论轻重都沿 7→6→5→4→3→2→1 顺位消费。后果：轻任务（线索归类、摘要、字段抽取）烧主力模型积分；重任务（全量研判、长上下文关联）可能被弱模型接单失败浪费预算；flash-lite 的返赠红利没有按任务性质定向利用。

**目标**：专项派生任务时，按**任务强度/复杂度 × 模型可用性 × 各池额度**自主选模型，双积分池的结构性红利被任务侧吃满。

**任务复杂度分档（规则分类器，零 LLM 成本，确定性可测）**：

| 档 | 判定信号（draft/task payload） | 首选模型 | 理由 |
|---|---|---|---|
| lite | 摘要/归类/字段抽取/短输出类 | **sensenova flash-lite**（专属池） | 能力够用 + 1:1 返赠反哺通用池，近似零成本 |
| std（默认） | 常规研判/验证/报告起草 | **sensenova ds-v4.1-flash**（主力） | 质量主力，通用积分池 |
| heavy | 长上下文（>128K）/多源关联/高失败代价 | glm-5.2（sensenova）→ **Go v4.1-flash** | 能力强/上下文长；通用池紧张时跨渠道用美元额度 |

> 分类器初版用任务类型枚举映射（campaign 派生的草稿自带 kind）；后续可从历史任务的成功率/重试率反馈调档（LearnLink 面，独立迭代）。

**额度与可用性联动**：选档后先看目标模型熔断状态（channels/status）与所属池余量——
- 首选熔断 → 按 `SEC_CAMPAIGN_MODEL_MAIN_FALLBACK` 顺延（同档内）→ 仍不可用则升/降档重选（heavy→std，std→lite 仅在 lite 任务可接受时）；
- 通用积分池 5h 窗口熔断 → std/heavy 任务自动改走 Go v4.1-flash（美元曲线），lite 任务不受影响的继续烧专属池；
- 全部不可用 → 落到 supply_factor=0 的既有停派逻辑（§3.1）。

**两路径落地（SEC_CAMPAIGN_MODEL_SELECTOR 切换）**：
- **Path B（先落地，bellkeeper）**：dsh 侧只在派生请求元数据上带 `task_class`（lite/std/heavy，纯标注非强制路由），模型选择策略由 **Bellkeeper LLM 侧**承接——pool-secagent 组策略升级为「按 task_class 分档路由 + 池内顺延」。优点：dsh 零路由侵入，17-llm-surface 纪律下只动 Bellkeeper 组策略；缺点：策略在 Bellkeeper，迭代需跨仓。
- **Path A（dsh 有能力后升级）**：若 dsh 派发链路支持指定模型（model_hint/preferred_model 字段），专项任务直接带 hint 下发，Bellkeeper 只按 hint 路由（hint 模型熔断时照旧顺延兜底）。届时 `SEC_CAMPAIGN_MODEL_SELECTOR=dsh` 切换，决策收敛回 task 域单一事实源。
- 无论哪条路径，`SEC_CAMPAIGN_MODEL_STRATEGY=weight` 一键退回旧纯权重链（回滚与 A/B 对照用）。

**与供给闸的关系**：供给闸（§3.1）管「总量派不派/派多快」，选模型管「每个任务用谁」——两层正交。供给熔断时选模型结果仅供顺延决策，不越过停派闸。

---

## 四、实施计划（小步）

| 步 | 内容 | 验收 |
|---|---|---|
| 0 | **Bellkeeper 池成员调整（已完成 2026-09-22）**：opencode-go-secagent 加 deepseek-v4.1-flash（渠道模型表 + 池成员权重 2），DB API 路径 + YAML 种子同步（Bellkeeper cb0572d） | channels/status 见 v4.1-flash；直调模型冒烟 200；pool-secagent 组冒烟 200 |
| 0.5 | **v3 Bellkeeper 变更（前置）**：sensenova-secagent 渠道加 `deepseek-v4.1-flash` 并入池（权重 7 主力位），glm-5.2→6、flash-lite→5、ds-v4-flash→4 顺延（DB API + YAML 种子） | channels/status 见 sensenova v4.1-flash；组冒烟 200；主力路由命中 v4.1-flash |
| 1 | Bellkeeper 采集器 + `decideThrottle` 纯函数 + 契约用例（五档规则各一例 + 探测失败两阶段） | 纯函数确定性测试全绿 |
| 1.5 | 统一额度面 .env 区块落位 + env 解析契约测试；Supervisor budget_low 自动提请 campaign-budget-extend（存量专项平滑爬坡） | .env 解析契约全绿；模拟 budget_low 触发 approval_request（kind=campaign-budget-extend） |
| 1.6 | **v3 任务分档分类器**（任务 kind → lite/std/heavy 纯函数映射）+ dsh 派生请求带 `task_class` 元数据（Path B） | 分类器契约测试全绿（三档各边界用例）；派生负载含 task_class |
| 2 | 接入 tick/Dispatcher/dispatch 三处 + INV-C11/C12 + checkpoint 留痕 | task 契约 +N 全绿；手工：临时把成员表指向不存在渠道验证 factor=0 停派 |
| 2.5 | **v3 Bellkeeper 组策略升级**：pool-secagent 按 task_class 分档路由 + 首选熔断顺延（Path B 承接）；通用池熔断时 std/heavy 自动走 Go v4.1-flash | lite 任务路由命中 flash-lite；主力熔断冒烟自动顺延 |
| 3 | 看板供给徽章 + L2 降级不回弹链路 | UI 单测 + accept PASS 不降级 |
| 4 | kimi-code 入池评估（独立小决策）：5h 窗口套餐是否加入 pool-secagent 成员表 | 配置变更 + 观察一周 |
| 5 | **Path A 评估**：调研 dsh 派发链路是否支持 model_hint；支持则 `SEC_CAMPAIGN_MODEL_SELECTOR=dsh` 切换，决策收敛回 task 域 | 调研结论留档；支持则切换冒烟 |

每步独立可回滚（feature flag `SEC_CAMPAIGN_SUPPLY_GATE=off` 回到现状）。

---

## 五、开放问题

1. **5h 窗口的主动利用**：本方案是「熔断后被动降速」。SenseNova 为**滚动 5h 窗口**（非定点清零），窗口对齐猜测无意义；kimi-code 若入池且确认为主供给，可加「窗口对齐派生」——探明重置时点（从 breakdown 记录归纳）后在窗口前段加速、尾段减速。属优化非必需，Phase 4 后评估。
2. **多专项公平**：两个专项共用同一池，供给降速时 derive_cap 折算各自独立（各自 cap×factor），无需全局仲裁（总量已被各自窗口预算闸约束）。**注意**：2M/窗 × 2 专项 = 4M 名义上限 > 周供给 ~1.2M 积分等效——实际由供给闸限速兜底，预算闸只是防失控上限，两者分工不变。
3. **eval 域的 LLM 消耗**（fp/contract 跑批）不在本闸范围——它有自己的 SEC_EVAL_* 通道；是否统一进供给观测待实证。
4. **SenseNova 积分余额自动观测**：channels/status 只见 Bellkeeper rpd 桶，不见真实积分池余量。若 SenseNova 提供余额查询 API，可由 Bellkeeper balance provider 接入（现有 balanceMgr 框架）——届时 decideThrottle 可把「积分池余量比」纳入降速规则。待调研。
5. **返赠到账延迟对选模型的影响（v3 新增）**：flash-lite 消费返赠 ~1h 到账且 30 天有效——「烧专属池反哺通用池」存在时滞，通用池临熔断时不能指望即时返赠救场；选模型的池余量判断应以**滚动窗口额度**为准，返赠视为次日级增益。另需观察 lite 档任务边界：若 flash-lite 在某类任务上失败率明显偏高，分类器应把该类上调 std 档（用历史重试率数据说话，步骤 2.5 上线后跑两周再调）。

6. **kimi-code 入池评估结论（步骤 4，2026-09-23）**：**暂不入池**。理由：① kimi-code 为**编码专用**渠道（`kimi-for-coding`，渠道 `task_types` 约束为 coding），pool-secagent 承载的是侦察/假设验证/覆盖推进，非编码任务，成员级 task-type 过滤会将其剔除，入池收益低；② 其套餐为 ~5h/7d 重置窗口（Bellkeeper `kimiCodeProbeLoop` 注释证实），滚动窗口不可预测，作为主供给需窗口对齐策略（见开放问题 1），成本/复杂度高于收益；③ 现有供给曲线（SenseNova 双积分池 × OpenCode Go 美元额度）已覆盖 lite/std/heavy 三档。**复评条件**：若后续引入编码型专项（如 exploit 脚本自动生成）或 SenseNova/Go 双曲线同时频繁熔断，再评估入池。
