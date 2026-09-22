# 23 · LLM 供给联动调速（Campaign × Bellkeeper 池额度感知）设计方案

> 日期：2026-09-22（v2 修订：补 SenseNova 双积分池实测口径 + OpenCode Go v4.1-flash 入池 + 统一额度面）
> 性质：**在办专项（设计文档）**，Bellkeeper 池成员调整已完成（见 §四步骤 0），域内调速组件未实施；落地后按治理规则回填 05-task/16-dashboard 并归档。
> 动机：22 号方案的 Campaign 专项是常驻持续推进实体（L1/L2 自动派生），其执行面全部经 Bellkeeper `pool-secagent` 消耗 LLM 额度。池成员的套餐有独立额度窗口（SenseNova 滚动 5h/周双积分池、OpenCode Go $12/5h+$30/周+$60/月美元额度、deepseek-secagent 500 rpd），额度耗尽时渠道熔断。**专项若无视供给状态继续派生，会批量产生失败任务**（烧窗口预算、污染连败黑名单、触发错误降级）。
> 上游：[archive/22-campaign-task-2026-09-22.md](archive/22-campaign-task-2026-09-22.md)（Campaign 本体）；[17-llm-surface.md](17-llm-surface.md)（模型层零改动纪律）。
> 总原则：**不新增域、不改 Bellkeeper**（只读其现有 API）；供给调速是 task 域内 Supervisor 的第六信号 + Dispatcher 的一道前置闸。

---

## 一、一页结论

1. **Bellkeeper 已有全部所需观测面**（2026-09-22 实测）：`GET /api/llm/health`（渠道熔断 state + breakdown_class）与 `GET /api/llm/channels/status`（daily_used/daily_limit/令牌桶余量/健康）。**零改造读取**，鉴权复用 `BELLKEEPER_LLM_API_KEY`（环境变量引用，零明文——宪法 §十四.4）。
2. **方案一句话**：task 域新增 **LlmSupplyWatch（供给哨兵）**——tick 顺带拉取 pool-secagent 成员健康，规则层纯函数 `decideThrottle` 算出**供给因子 supply_factor ∈ {0, 0.4, 1.0}**；Dispatcher 派生闸叠加「有界 × 供给因子」取严；供给归零时 L2 专项自动降级 L1（产草稿不下发），供给恢复自动回弹并补派积压。**所有可调整项集中在 dsh .env 一个区块（统一额度面，§3.6）**，一处修改全局生效。
3. **与 5h 套餐窗口的相处**：不猜重置时间——以 Bellkeeper 熔断状态为唯一真相源（其自带 30min 恢复探针 + ~5h 重武装）。专项侧只在「渠道 quota_exhausted 熔断中」降速/停派，熔断解除（closed）即恢复，天然贴合滚动 5h 窗口而无需计时（SenseNova 5h 窗口为**滚动窗口非定点清零**，见 §2.1——任何「到点全速」的计时策略都会猜错）。
4. **三闸取严**：per-program 周期预算闸（既有）∧ campaign 窗口预算闸（22 号）∧ **供给闸（本方案）**——任一停派。INV-C11 新增。
5. **看板**：任务视图专项卡片加「供给」徽章（正常/降速/停派）；checkpoint 留痕每次调速变化，可追溯「为什么这小时没派生」。

---

## 二、现状实测（2026-09-22，设计输入）

### 2.1 pool-secagent 成员与额度实测（v2 修订）

| 渠道 | 池内角色（weight） | 实时状态 | 额度口径 |
|---|---|---|---|
| sensenova-secagent | flash-lite 256K 专属积分（6）→ glm-5.2（5）→ ds-v4-flash（4） | closed | **双积分池**（下表）+ rpd 20000 |
| deepseek-secagent | 权重 3 | closed | rpd 500（付费，刻意保守，保底账） |
| opencode-go-secagent | **v4.1-flash（2，v2 新增）** → v4-flash（1，兜底） | closed | **$12/滚动5h · $30/滚动周 · $60/月**（官方口径），rpd 20000 |
| kimi-code（**未入池**，候选） | — | closed（daily 1/50000） | **套餐 ~5h/7d 重置窗口**（Bellkeeper kimiCodeProbeLoop 注释证实） |

**SenseNova 双积分池实测（2026-09-22 用户账户截图口径，公测免费期）：**

| 池 | 5h 滚动窗口 | 周滚动额度 | 当前余额 | 说明 |
|---|---|---|---|---|
| 通用积分池（全 Free 模型可用：glm-5.2/ds-v4-flash 等） | 60,000 / 窗（上次重置 9-21 22:10） | 600,000（下次重置 9-23 18:10） | 333,569 + 活动固定 105,067（2026-10-19 到期） | 主力 |
| Flash-Lite 专属池 | 60,000 / 窗 | 600,000 | 428,473 | flash-lite 消费 **1:1 返赠通用积分**（返赠不占滚动额度，~1h 到账，30 天有效）——专属池消费近似零成本 |

推论：**flash-lite（权重 6）是当前最廉价主供给**，应优先烧专属池；其 256K 上下文限制已由成员 max_context_tokens 由 Bellkeeper 路由自动跳过超长请求（17-llm-surface 纪律不动）。

**OpenCode Go（v2 变更，已上线）**：`deepseek-v4.1-flash` 已加入渠道模型表与池成员表（权重 2，介于官方 deepseek 与 v4 兜底之间），实测路由冒烟通过（2026-09-22）。美元额度与 SenseNova 积分池正交，构成第二条供给曲线——SenseNova 5h 窗口打满时 Go 的 $12/5h 窗口大概率仍有量。

> **Bellkeeper 配置真相源备注**：llm_channels / llm_model_groups 为 **DB 持久化**，YAML 仅首启空库种子（SeedLLMProxyConfig）。渠道/成员表变更须走 `PUT /api/llm/config/channels/:id` / `PUT /api/llm/config/groups/:id`（自动触发 reload），改 YAML 对运行实例无效。本次 v4.1-flash 入池即走此路径；bellkeeper.yaml 同步更新保持种子一致（Bellkeeper commit cb0572d）。

### 2.2 教训与约束

- deepseek-direct 当天已用 132/500——**rpd 500 级渠道在持续挖掘下半天就能打满**，调速不是理论需求；
- Bellkeeper 熔断恢复：自带 `kimiCodeProbeLoop`（30min tick，探针恢复则 closed，否则重武装 ~5h）——专项侧**不做自己的探针**（避免浪费额度探测），只读状态；
- 17-llm-surface 纪律：模型层零改动——本方案**不碰** settings.yaml/路由/熔断/dsh-bill，只在任务派生层节流。

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

> v2 权重门槛说明：v4.1-flash 入池后权重序列为 6/5/4（sensenova）→ 3（官方 ds）→ 2（go v4.1）→ 1（go v4）。「主力」= weight ≥4 即 sensenova 系；权重 ≤3 为兜底链（付费官方 → Go v4.1 → Go v4）。factor=0.4 时专项仍在跑，只是靠兜底链低速推进——这正是「双供给曲线」设计意图。

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
```

**campaign 窗口预算调高路径（v2，尊重既有校验）**：新建专项默认 2M/7d（`SEC_CAMPAIGN_DEFAULT_BUDGET_TOKENS`，campaign_create 缺省读取）。**存量专项不走破例直改**——`campaign-budget-extend` 的 validate 铁律（spent ≥ 80% 才准延长、单次 ≤ 原预算×2）是防囤预算设计，保留不动。配套小增强（步骤 1.5）：Supervisor 在 `budget_low` checkpoint 时**自动提请** campaign-budget-extend（request_actors 已含 scheduler，tick 路径天然合规）——在跑的两个专项（500k）到达 400k 水位即自动 +1M → 1.5M → 后续平滑爬坡至 2M+，全程审批留痕、零人工介入。

**单一事实源纪律**：.env 区块是唯一调节点；代码内不得再出现裸数字默认值（契约测试断言 env 解析正确性）。看板专项卡片显示当前生效的 supply_factor 与 derive_cap 折算值（只读展示，不在 UI 改额度——额度调整走 .env + 重启，符合 ops 纪律）。

---

## 四、实施计划（小步）

| 步 | 内容 | 验收 |
|---|---|---|
| 0 | **Bellkeeper 池成员调整（已完成 2026-09-22）**：opencode-go-secagent 加 deepseek-v4.1-flash（渠道模型表 + 池成员权重 2），DB API 路径 + YAML 种子同步（Bellkeeper cb0572d） | channels/status 见 v4.1-flash；直调模型冒烟 200；pool-secagent 组冒烟 200 |
| 1 | Bellkeeper 采集器 + `decideThrottle` 纯函数 + 契约用例（五档规则各一例 + 探测失败两阶段） | 纯函数确定性测试全绿 |
| 1.5 | 统一额度面 .env 区块落位 + env 解析契约测试；Supervisor budget_low 自动提请 campaign-budget-extend（存量专项平滑爬坡） | .env 解析契约全绿；模拟 budget_low 触发 approval_request（kind=campaign-budget-extend） |
| 2 | 接入 tick/Dispatcher/dispatch 三处 + INV-C11/C12 + checkpoint 留痕 | task 契约 +N 全绿；手工：临时把成员表指向不存在渠道验证 factor=0 停派 |
| 3 | 看板供给徽章 + L2 降级不回弹链路 | UI 单测 + accept PASS 不降级 |
| 4 | kimi-code 入池评估（独立小决策）：5h 窗口套餐是否加入 pool-secagent 成员表 | 配置变更 + 观察一周 |

每步独立可回滚（feature flag `SEC_CAMPAIGN_SUPPLY_GATE=off` 回到现状）。

---

## 五、开放问题

1. **5h 窗口的主动利用**：本方案是「熔断后被动降速」。SenseNova 为**滚动 5h 窗口**（非定点清零），窗口对齐猜测无意义；kimi-code 若入池且确认为主供给，可加「窗口对齐派生」——探明重置时点（从 breakdown 记录归纳）后在窗口前段加速、尾段减速。属优化非必需，Phase 4 后评估。
2. **多专项公平**：两个专项共用同一池，供给降速时 derive_cap 折算各自独立（各自 cap×factor），无需全局仲裁（总量已被各自窗口预算闸约束）。**注意**：2M/窗 × 2 专项 = 4M 名义上限 > 周供给 ~1.2M 积分等效——实际由供给闸限速兜底，预算闸只是防失控上限，两者分工不变。
3. **eval 域的 LLM 消耗**（fp/contract 跑批）不在本闸范围——它有自己的 SEC_EVAL_* 通道；是否统一进供给观测待实证。
4. **SenseNova 积分余额自动观测**：channels/status 只见 Bellkeeper rpd 桶，不见真实积分池余量。若 SenseNova 提供余额查询 API，可由 Bellkeeper balance provider 接入（现有 balanceMgr 框架）——届时 decideThrottle 可把「积分池余量比」纳入降速规则。待调研。
