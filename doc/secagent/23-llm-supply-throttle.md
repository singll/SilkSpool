# 23 · LLM 供给联动调速（Campaign × Bellkeeper 池额度感知）设计方案

> 日期：2026-09-22
> 性质：**在办专项（设计文档）**，未实施；落地后按治理规则回填 05-task/16-dashboard 并归档。
> 动机：22 号方案的 Campaign 专项是常驻持续推进实体（L1/L2 自动派生），其执行面全部经 Bellkeeper `pool-secagent` 消耗 LLM 额度。池成员的套餐有独立额度窗口（如 kimi-code ~5h/7d 重置、deepseek-secagent 500 rpd、sensenova 专属积分），额度耗尽时渠道熔断。**专项若无视供给状态继续派生，会批量产生失败任务**（烧窗口预算、污染连败黑名单、触发错误降级）。
> 上游：[archive/22-campaign-task-2026-09-22.md](archive/22-campaign-task-2026-09-22.md)（Campaign 本体）；[17-llm-surface.md](17-llm-surface.md)（模型层零改动纪律）。
> 总原则：**不新增域、不改 Bellkeeper**（只读其现有 API）；供给调速是 task 域内 Supervisor 的第六信号 + Dispatcher 的一道前置闸。

---

## 一、一页结论

1. **Bellkeeper 已有全部所需观测面**（2026-09-22 实测）：`GET /api/llm/health`（渠道熔断 state + breakdown_class）与 `GET /api/llm/channels/status`（daily_used/daily_limit/令牌桶余量/健康）。**零改造读取**，鉴权复用 `BELLKEEPER_LLM_API_KEY`（环境变量引用，零明文——宪法 §十四.4）。
2. **方案一句话**：task 域新增 **LlmSupplyWatch（供给哨兵）**——tick 顺带拉取 pool-secagent 成员健康，规则层纯函数 `decideThrottle` 算出**供给因子 supply_factor ∈ {0, 0.4, 1.0}**；Dispatcher 派生闸叠加「有界 × 供给因子」取严；供给归零时 L2 专项自动降级 L1（产草稿不下发），供给恢复自动回弹并补派积压。
3. **与 5h 套餐窗口的相处**：不猜重置时间——以 Bellkeeper 熔断状态为唯一真相源（其自带 30min 恢复探针 + ~5h 重武装）。专项侧只在「渠道 quota_exhausted 熔断中」降速/停派，熔断解除（closed）即恢复，天然贴合 5h 窗口而无需计时。
4. **三闸取严**：per-program 周期预算闸（既有）∧ campaign 窗口预算闸（22 号）∧ **供给闸（本方案）**——任一停派。INV-C11 新增。
5. **看板**：任务视图专项卡片加「供给」徽章（正常/降速/停派）；checkpoint 留痕每次调速变化，可追溯「为什么这小时没派生」。

---

## 二、现状实测（2026-09-22，设计输入）

### 2.1 pool-secagent 成员与实时状态

| 渠道 | 池内角色（weight） | 实时状态 | 额度口径 |
|---|---|---|---|
| sensenova-secagent | flash-lite 256K 专属积分（6）→ glm-5.2（5）→ ds-v4-flash（4） | closed（daily 241/20000） | 专属积分 + rpd 20000 |
| deepseek-secagent | 权重 3 | **half_open**（unknown） | rpd 500，令牌桶 5 |
| opencode-go-secagent | 权重 1（兜底） | **half_open**（unknown） | rpd 20000 |
| kimi-code（**未入池**，候选） | — | closed（daily 1/50000） | **套餐 ~5h/7d 重置窗口**（Bellkeeper kimiCodeProbeLoop 注释证实） |

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
pool-secagent 成员表（配置 SEC_CAMPAIGN_POOL_MEMBERS，默认 sensenova-secagent,deepseek-secagent,opencode-go-secagent,kimi-code）
```

**决策纯函数** `decideThrottle(members) → { supply_factor, detail[] }`（确定性可重放，契约测试钉死）：

| 规则 | supply_factor | 语义 |
|---|---|---|
| 全部成员 open 或 quota_exhausted 熔断中 | **0** | 停派：L2→L1 降级 + checkpoint(llm_throttled)，在跑子任务不动 |
| 主力成员（weight ≥4）熔断，兜底可用 | **0.4** | 降速：derive_cap 折算（5→2），checkpoint 记录 |
| 主力可用但 daily 余量 <15% | **0.4** | 预防性降速（额度窗口尾段保护） |
| 其余 | **1.0** | 全速；从 0/0.4 回弹时 checkpoint(llm_restored) |

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

---

## 四、实施计划（小步）

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | Bellkeeper 采集器 + `decideThrottle` 纯函数 + 契约用例（五档规则各一例 + 探测失败两阶段） | 纯函数确定性测试全绿 |
| 2 | 接入 tick/Dispatcher/dispatch 三处 + INV-C11/C12 + checkpoint 留痕 | task 契约 +N 全绿；手工：临时把成员表指向不存在渠道验证 factor=0 停派 |
| 3 | 看板供给徽章 + L2 降级不回弹链路 | UI 单测 + accept PASS 不降级 |
| 4 | kimi-code 入池评估（独立小决策）：5h 窗口套餐是否加入 pool-secagent 成员表 | 配置变更 + 观察一周 |

每步独立可回滚（feature flag `SEC_CAMPAIGN_SUPPLY_GATE=off` 回到现状）。

---

## 五、开放问题

1. **5h 窗口的主动利用**：本方案是「熔断后被动降速」。若 kimi-code 入池且确认为主供给，可加「窗口对齐派生」——探明重置时点（从 breakdown 记录归纳）后在窗口前段加速、尾段减速。属优化非必需，Phase 4 后评估。
2. **多专项公平**：两个专项共用同一池，供给降速时 derive_cap 折算各自独立（各自 cap×factor），无需全局仲裁（总量已被各自窗口预算闸约束）。
3. **eval 域的 LLM 消耗**（fp/contract 跑批）不在本闸范围——它有自己的 SEC_EVAL_* 通道；是否统一进供给观测待实证。
