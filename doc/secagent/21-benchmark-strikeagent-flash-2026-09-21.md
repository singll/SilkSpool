# StrikeAgent_AtkBrain-Flash 对标分析与吸收建议（对 SilkSecAgent）

> 日期：2026-09-21
> 对标对象：[Yean-Sec/StrikeAgent_AtkBrain-Flash](https://github.com/Yean-Sec/StrikeAgent_AtkBrain-Flash)（版本 `0.7.0-beta.3`，AGPL-3.0-only）
> 分析方式：全仓库只读审阅（backend 130 文件 / engine 约 1.2 万行 / graph 约 0.6 万行 + skills + frontend + deploy），并与 `doc/secagent/00–18`、`bundles/dsh/` 现状逐项对照。
> 性质：**在办专项（研究/决策文档）**，非实施记录；吸收项落地后须按 [README](README.md) 治理规则回填对应模块文档并归档。
> 定位：这是「上层猎面编排」的对标，不是又一个知识库对标；与 [archive/silksecagent-external-repos-benchmark-2026-09-05.md](archive/silksecagent-external-repos-benchmark-2026-09-05.md)（知识/流程层对标）互补。

---

## 〇、一页结论（先给答案）

1. **StrikeAgent 真正的创新不在模型、不在工具，而在「上层推进方式」**：它把「LLM 自由发挥」改造成 **攻击图驱动的状态机**——图是唯一工作记忆，LLM 只产出**参考假说**，循环把图编译成**必须守住的局面硬约束**，每一轮结束自动派生**下一步的有界动作集合（Intent）**。
2. **它的「自循环」不是定时任务，也不该被理解成「一直跑」**：它是一个有明确终止条件、由状态/事件推进、时间只作守卫阈值的长驻协程。**自循环与定时任务不是替代关系，而是分层**（见 §五）。
3. **SilkSecAgent 的工程底座（14 域 + 总线 + outbox + scope/approval fail-closed + 审批副作用幂等）明显比 StrikeAgent 更硬**，**不需要架构大改**，更不能退化成它的单体 + SQLite 直连。
4. **SilkSecAgent 真正缺的不是「执行能力」也不是「知识量」，而是「把它们串成一个目标推进循环」的那层编排器**：目前任务之间相互独立、攻击图/FGS 只活在单个任务内、任务完成后没有任何机制决定「下一步打哪里」。
5. **建议吸收的 6 个突破性思路**：① 参考假说 vs 局面硬约束的分离；② 图作为唯一工作记忆 + Intent 自动派生；③ 自循环的「有意义终止条件」（防假自循环烧钱）；④ 记忆蒸馏的「去特化」（只留可迁移战术骨架 + 置信度反馈）；⑤ 可信度工程（独立二次复核 + 红队评级 rubric + 未证明执行硬降级）；⑥ 侦察螺旋圈层账本（不打歪又扩面）。
6. **大改判定：否。** 属于「新增一层编排 + 若干域增强」的中等增量，建议分 3 期（Phase A/B/C，见 §六.4），全程不触碰 fail-closed 红线。

---

## 一、对标对象画像

### 1.1 一句话定位

StrikeAgent_AtkBrain-Flash 是夜安团队的 **AI 渗透测试猎面平台**，主打「**自循环 · 自监督 · 自进化**」，聚焦**外网打点**（红队 getshell / SRC / CTF），运行时为 **Pi（deepseek-flash）**，控制台 `:2334`、API `:2333`，Docker host 网络（Kali）。README 自称 TSecbench v1 第 1 名（97.89/100），Pro 版落地几十个项目、上千外网授权环境。

### 1.2 角色模型（关键）

| 角色 | 实现 | 职责 |
|---|---|---|
| **御主（supervisor / AI 监督）** | `engine/ai_supervisor.py`，**无工具的一次性 Pi 查询** | 看攻击图 → 产出下一轮方案 JSON（`diagnosis/stall/next_plan/must_intents/prefer_tactics/...`） |
| **从者（lead）** | `agents/session.py` `ProjectAgent.run_turn` | 本回合计划、写图、汇总、短验证；不亲自打 HTTP |
| **工人（role workers）** | 并发 `PiSession`，角色化 | `recon / web-exploit / src-hunt / rce-hunt / privesc / lateral / flag-hunt / protocol-model / reverse` |
| **复核（finding-review）** | 独立 Pi 角色 | 对每条 finding 做**二次验证 / 二次评级**，不新建条目 |
| **人** | 对话框 steering | 立刻打断当前轮，优先级高于御主 |

### 1.3 核心模块（仅列本对标相关）

- 引擎：`engine/loop.py`（2918 行，`run_project_loop`，攻击图自循环引擎）、`engine/scheduler.py`（并发信号量 + steering，**非 cron**）、`engine/spiral.py`（侦察螺旋账本）、`engine/hunt_clock.py`（配速/空转/卡死/终止）、`engine/supervise.py`（御主门闩）、`engine/advisor_bind.py`（方案 → 局面绑定编译器，1904 行）、`engine/hop_auth_gate.py`、`engine/intranet_reach.py`、`engine/entry_identity.py`、`engine/turn_close.py`。
- 图：`graph/store.py`（3666 行，nodes/edges/findings/intents 四表 + RCE 最优路径）、`graph/hypothesize.py`（1496 行，Intent 自动派生）、`graph/verify.py`、`graph/finding_claim.py`、`graph/rating_rubric.py`。
- 记忆：`memory/store.py`（episode）、`memory/evolve.py`（lesson 蒸馏）、`memory/generalize.py`（去特化）、`memory/methodology.py`（手法白名单）、`memory/achievements.py`。
- Agent 运行时：`agents/pi_runtime.py`（Pi RPC）、`agents/prompts.py`（1136 行）、`agents/tools.py`（2053 行，in-process 工具闭包）、`agents/context.py`。
- 复核：`review/jobs.py`、`review/flags.py`。
- 技能：`skills/recon-spiral`、`recon-fanout`、`src-hunt-playbook`、`kali-kit`、`waf-bypass-methodology`。

### 1.4 与 DSH / SilkSecAgent 的关系

StrikeAgent 保留了 **DSH（DeepSeek 插件宿主）桥接层**（`backend/atkbrain/dsh/pentest.cordis.yml`、`atkbrain-tools.js`、`pi/extensions/atkbrain-tools.ts`、`agents/mcp_http.py` 的 `/projects/{pid}/mcp` 与 `/agent-tools` REST），**但当前实弹猎面已迁移到 Pi RPC 运行时**（`pi --mode rpc`，JSONL）；DSH compose 的 `render_cordis()` 全仓库无调用方，属遗留路径。

**这意味着**：StrikeAgent 与 SilkSecAgent 共享同一套「插件宿主 + 本地工具桥 + JSONL 会话」范式，但 StrikeAgent 把「编排智能」全部放在了 **DSH/Pi 之外的自研 Python 引擎**里——这正是 SilkSecAgent 目前缺失的那一层。它可对标、可借鉴，但**不应整体迁移**（架构形态与许可都不同）。

---

## 二、架构与流程总对比

### 2.1 定位差异

| 维度 | StrikeAgent_AtkBrain-Flash | SilkSecAgent (DSH) |
|---|---|---|
| 首要目标 | **外网打点**（getshell/SRC/CTF），以「一轮接一轮推进到目标」为中心 | **授权范围内漏洞发现平台**，以「可治理、可审计、fail-closed 的工具执行与产出闭环」为中心 |
| 智能主体 | 自研 Python 猎面引擎（御主+从者+工人） | DSH 原生 agent + 自研 14 域插件 + 任务调度器 |
| 循环形态 | **单项目一个长驻协程**，状态驱动，有终止条件 | **任务调度器 60s tick** 领取到期任务，逐任务起 headless worker，任务间空闲 |
| 工作记忆 | **攻击图是唯一真相源**（nodes/edges/findings/intents） | FGS 只活在单任务内；跨任务靠 facts/know/asset 等域表 |
| 推进决策 | `hypothesize` 从图自动派生 Intent，御主在图上选题 | 任务由人/定时/事件创建；**没有「下一步打哪里」的图驱动决策层** |
| 幻觉治理 | 二次复核 + 红队评级 rubric + 图纪律硬约束 | 五要素门 + `vuln_verify_replay` 机械重放 + 六态台账 |
| 学习 | 自动 episode→lesson 蒸馏 + 每轮回灌简报 | L0–L6 已建成但**强门控**，且 kb 消费率低（历史遗留） |
| 安全模型 | Scope/Guard/`_http_blocked` + 平台自保护（代码级） | scope.yml fail-closed + exec 9 步 guard + 审批 kind + sandbox（**更完备**） |
| 部署/规模 | 单体 FastAPI + SQLite + Docker/Kali | 14 域 + 总线 + outbox + 13 systemd 单元 + spool bundle |
| 运行时可插拔 | 绑 Pi/deepseek-flash | DSH 宿主，模型走 Bellkeeper 网关（可换） |

### 2.2 一次「渗透推进」的流程对照

**StrikeAgent（状态驱动循环）**

```
项目启动 → run_project_loop 长驻协程
  while not paused:
    1. 同步目标/猎钟；人工 steering 优先摄入（可打断）
    2. 入口可达性 / 重绑 / 平台到期 守卫
    3. 把图上前置条件刷进 Guard
    4. 选注入来源：人工 > 御主方案；检索跨局经验
    5. 编译本轮战术偏置（prefer/defer/exclude）
    6. 重开误关 Intent；绑定正交化；认领本轮 Intent
    7. 构造指令（图快照 + 意图 + 纠偏）→ 从者 run_turn（内含角色工人并发）
    8. 工人结果落图 → 派生新 Intent
    9. 回合收口 → 问御主（从者整轮打完才问）→ 出新方案
   10. 空转/卡死/墙钟判定 → 终止或继续
  终止：goal_reached / stall / turn_cap / runtime_cap / graph_idle / entry_dead / env_closed / 人工
```

**SilkSecAgent（任务驱动）**

```
spool bundle setup → systemd silksecagent (web)
  task scheduler 60s tick（data/scheduler.lock 单实例）
    领取到期 task → 组装 prompt（persona + phase + FGS hint + kb 三步）
    → exec_spawn_worker headless → 单任务内 LLM agent loop（FGS 记录）
    → task_finish 判定 → 写 task_runs
  任务之间：空闲；下一个任务来自 人工/定时/事件订阅（如 vuln.signal.confirmed → [提交] 任务）
  事件总线 1s dispatcher 投递 async 订阅者；memcore 6h 治理扫描
```

**差异的本质**：StrikeAgent 是「**项目 = 一个持续推进的循环**」，SilkSecAgent 是「**平台 = 一个任务执行引擎**」。前者天然会「自行挖掘」，后者需要人/定时喂任务。

---

## 三、可借鉴能力清单（按价值/成本分级）

> 有用性标注：★★★ = 直接可用且收益高；★★ = 有价值但需适配；★ = 参考意义为主。

### P0 — 立即可吸收（纯知识/契约层，低风险）

| # | 能力 | StrikeAgent 出处 | 对 SilkSecAgent 的用法 | 有用性 |
|---|---|---|---|---|
| P0-1 | **finding 二次复核角色 + 评级 rubric** | `agents/prompts.py` `FINDING_REVIEW_ROLE`、`graph/rating_rubric.py` | 在 `vuln_confirm` 前加一个**独立复核任务**（phase=review）：不得新建条目，只带 `finding_id+node_key`；未证明命令执行**最高 medium**；`redteam_rating` 必须带 ≥40 字理由 | ★★★ |
| P0-2 | **图纪律（落图判断）写进 prompt** | `prompts.py` 攻击图纪律段 | 在 `data-seed` 的 persona/prompt 中固化：「工具结果必须过落图判断，不写点等于本轮没发生」「漏洞节点必须先挂到服务/信息点」 | ★★★ |
| P0-3 | **「基础设施失败 ≠ 方法失败」** | `supervise.py` `_detect_infra`/`classify_probe_payload`（transport/app/ignore） | 在 exec 结果回流与 learning_episodes 里显式区分：入口挂掉（infra）不记方法失败、不换路线；只有 app 级失败才更新 exp_card 置信度 | ★★★ |
| P0-4 | **never-submit / 否证纪律细则** | `prompts.py`「状态码/跳转/Cookie 无差异不否证后端已处理参数」「版本命中或白名单文件写不是 RCE」 | 并入 sec-verification skill，与既有「六态台账 + verify_replay」互补（此前对标 BugHunter 时已列出方向，此处得到第二个独立来源印证） | ★★★ |
| P0-5 | **侦察螺旋圈层账本** | `engine/spiral.py`（`SPIRAL.json`，小/中/大三圈，`empty_plans` 满 6 才升圈） | 作为 `exec`/`ledger` 的一种「扫描覆盖账本」：以**高质量增长**（已验证洞/凭证/立足点/能力边）清零空转，只有到第 3 圈才允许整猎 stall | ★★★ |
| P0-6 | **入口身份比对（防靶机重绑/邻题污染）** | `engine/entry_identity.py`（expected stack ∩ live stack） | 资产/接口域增一个「目标身份指纹」比对；换 IP/换栈时不得把旧题指纹套到新题 | ★★ |

### P1 — 需增量改造（编排层/域增强）

| # | 能力 | 出处 | 改造方向 | 有用性 |
|---|---|---|---|---|
| P1-1 | **攻击图作为唯一工作记忆** | `graph/store.py`（nodes/edges/findings/intents + strategy_key 去重 + RCE 最优路径） | 新增「**项目级攻击图**」域，从单任务 FGS 上提：节点 target/service/info/vuln/credential/foothold/goal，边 LEADS_TO/EXPLOITS/ESCALATES_TO/PIVOTS_TO；与 asset/vuln/fact 域投影互通 | ★★★ |
| P1-2 | **Intent 自动派生（hypothesize）** | `graph/hypothesize.py` | 图上每产生一个服务/危险点/漏洞/凭证，自动泛化出正交后续 Intent（带 `strategy_key` 去重）；替代「等任务被创建」 | ★★★ |
| P1-3 | **参考假说 vs 局面硬约束的分离** | `engine/advisor_bind.py` `compile_binding` + `sanitize_closeout_plan` | 御主（或规划 LLM）输出只作参考假说；编排器按图编译「必须守住」的局面（未消费凭证/未关输入面/已验证洞/跳板禁令/点名 hop_auth）；违反局面的散文被丢弃 | ★★★ |
| P1-4 | **回合制强收口 + 从者整轮打完再问御主** | `turn_close.py`、`advisor_schedule.should_yield_turn_to_advisor()` 恒 False | 在单任务内部约束「本轮小结写完即停，不得拖住回合」；任务之间由编排器统一决策下一轮，不让单任务自行无限续跑 | ★★★ |
| P1-5 | **目标推进循环（自循环本体）** | `engine/loop.py` `run_project_loop` | 新增常驻「猎面编排器」（web profile，类似 scheduler 但目标是 **program** 而非单 task），见 §五.4 | ★★★ |
| P1-6 | **记忆蒸馏「去特化」** | `memory/generalize.py` + `methodology.py` + `evolve.py` | 补进 know 域：episode → lesson 时把含 IP/端口/题面 slug 的制胜链归一为 `entry→service(http)→vuln(lfi)→foothold(rce)→goal` 战术骨架；只留 stack/cue/过程/战术白名单 token | ★★★ |
| P1-7 | **经验回灌简报 + 置信度反馈** | `retrieve_lessons` + `_confidence(wins,fails,uses)` | 任务 prompt 注入「进化经验」块；采纳后回写 wins/fails，只有实测有效才升置信；`uses≥4 & wins=0` 降权 | ★★ |
| P1-8 | **track-agnostic 结构守卫** | `turn_close/advisor_schedule/advisor_bind` 的 `_assert_track_agnostic()` | 核心编排函数加签名断言，禁止红队/SRC/CTF 分叉污染核心逻辑（SilkSecAgent 目前靠约定，无结构保证） | ★★ |

### P2 — 突破性思路（需专门设计）

| # | 思路 | 为什么是突破 | 有用性 |
|---|---|---|---|
| P2-1 | **LLM 不是决策者，是假说生成器；循环把图编译成硬约束** | 从根上解决「LLM 跑偏/说一套做一套/被 prompt 注入带跑」——不是靠更长的 prompt，而是靠**代码层丢弃违规输出** | ★★★ |
| P2-2 | **有意义的终止条件，而非「一直跑」** | `allowed_ring<3` 禁止 stall、空转以高质量增长清零、8 类显式 exit reason → 自循环既不早停也不无限烧钱 | ★★★ |
| P2-3 | **去特化记忆 = 跨目标可迁移的战术骨架** | 一般 RAG/记忆存的是「这道题怎么写」，它存的是「这类入口→这类洞→这类立足点的顺序」，换目标仍适用 | ★★★ |
| P2-4 | **可信度工程：二次评级 + 独立复核 + 硬降级** | 让「AI 报的洞拿着就能用」，而不是「报告好看但一问就虚」，是交付级能力的核心 | ★★★ |
| P2-5 | **攻击图自动派生 Intent 形成有界自循环** | 从「自由发挥」变成「有界、可去重、可复开/否证的动作集合」，是自循环可控的关键 | ★★★ |
| P2-6 | **首跳 MITM + 出口代理池 + 内网可达前置条件** | 把「必须经已登记能力访问内网」变成机制（没 SSRF/shell/tunnel 就不能对内网操作） | ★★ |

### 不是能力，但值得记的「小细节」

- **假否证防护**：未验证的 hop_auth 不允许被否证；HTTP 登录「POST 无 body / 重定向后仍像未登录」不能当口令否证。
- **邻题隔离**：多题共用 `:80` 时只对高位端口做端口标记匹配，避免误判；只连在邻题上的子图被隔离。
- **假收口识别**：`claimed_secret_disproved` / `plan_claims_obtained_secret` 防「御主声称拿到但图上没有」。
- **收到人工指令后抑制御主若干轮**（`human_hold_until = turn + 3`），防止人工干预被 AI 规划立刻覆盖。
- **跨重启续跑**：只接回当时占槽的项目（`hunt_resume.json`），不把集群整表拉起。

---

## 四、突破性思路深度拆解

### 4.1 参考假说 vs 局面硬约束（最有价值的一条）

**问题**：所有 LLM Agent 的通病——模型输出的自然语言「计划」被当成命令执行，一旦模型跑偏或自信过头，整个循环跟着歪；而在 prompt 里加更多「不要跑偏」的约束，边际效用递减且容易被上下文淹没。

**StrikeAgent 的解法**（`advisor_bind.py`）：
1. 御主输出 `SupervisorPlan`（纯 JSON，无工具），**只是参考假说**：`next_plan/must_intents/prefer_tactics` 文案明确标注「排到前沿最前，不是只许打这些」。
2. 循环用 `compile_binding()` 把「图状态」编译成 `AdvisorBinding`——**必须守住**的局面（未消费凭证、未关输入面、已验证洞、跳板禁令、点名的 hop_auth）。局面是**代码从图算出来的，不依赖 LLM 自觉**。
3. `binding_compliance()` 判定上一步执行情况（oracle/executed/ignored/empty）；`ignored` 触发 `tighten_binding()` 加入口禁令并重注；连续 miss 作废绑定、重开多路线。
4. `sanitize_closeout_plan()` 直接把御主散文里「假关闭/离开跳板」的后半句剥掉，替换成 `CLOSEOUT_OVERRIDE`。**LLM 说的不算，图说的算。**

**对 SilkSecAgent 的意义**：这是「审计 fail-closed」思想在 **AI 规划层**的翻版——SilkSecAgent 已经在命令/授权层做了 fail-closed（scope/approval/audit），但 **LLM 的规划输出目前没有任何代码级校验**。吸收这条 = 给 prompt 层也装上 fail-closed。

### 4.2 攻击图作为唯一工作记忆 + Intent 自动派生

- `--no-session` 不续接旧对话；每轮从者都是全新 Pi，只靠「图快照 + Intent 列表 + 纠偏」重建上下文。**跨轮记忆 = 图，不是聊天历史。**
- 每次写点即触发 `derive_intents_for_*`：新服务 → 枚举 Intent；新危险点 → 探测 Intent；新漏洞 → 利用 Intent；新凭证 → 消费 Intent；新立足点 → 后渗透 Intent。Intent 带 `strategy_key` 去重、可 `resolve`（verified/disproved）、可重开。
- 效果：把「智能体只记点不串链」变成「图自动生成有界下一步」，同时天然限制重复死磕（同 `strategy_key` 不重复登记）。

**对 SilkSecAgent 的意义**：SilkSecAgent 有 `fgs`（Fact-Goal-Step）但它是**任务内**的；有 `task_chain` 但需要显式声明。缺的正是「项目级图 + 自动派生下一跳」。这块与 P1-1/P1-2 是同一件事。

### 4.3 自循环的本质与终止条件

StrikeAgent 的循环**不是无限跑**，它有 8 类显式终止原因（`loop.py` → `final_project_status`）：

| 终止 | 触发 |
|---|---|
| `goal_reached` | 夺旗 / 新达成 getshell |
| `runtime_cap` | 墙钟硬停（红队 12h、SRC 6h、CTF 40/120/180min，上限 72h） |
| `turn_cap` | 轮数上限（MAX_TURNS 9999） |
| `graph_idle` | 图连续无新节点/无交旗/无本地进展 |
| `stall` | `no_progress` 达上限；**且只有 `allowed_ring>=3` 才允许** |
| `entry_dead` | 入口连续不可达、重绑仍死，让出槽 |
| `env_closed/unreachable` | 平台到期/不可达 |
| `runtime_review_stop` | CTF 御主运行时审查判停 |

关键设计：
- **时间只是守卫阈值**（挂起检测、冷却、墙钟），不做唤醒源。
- **空转以「高质量增长」清零**（新节点/交旗/本地长计算/工作区新产物），单纯无脑扫会累积空转并最终触发升圈或 stall。
- **卡死检测排除「SDK 心跳」和「有命令在跑」**，避免把长计算误判为卡死。
- **跨重启不丢**：猎钟持久化 + `resume_completed_turn` 重跑被打断的轮，不跳号。

### 4.4 记忆蒸馏「去特化」

`memory/evolve.py` + `generalize.py` + `methodology.py` 的三段式：

1. **触发资格**：只有 `verification_status ∈ {verified,flaky}` 且（`redteam_rating ∈ {high,critical}` 或二次验证成功且 severity ∈ {high,critical}）的 finding / flag 才允许蒸馏；**不蒸失败局**。
2. **去特化**（`generalize.py`）：把 `vuln:path-traversal`、`foothold:app-rce` 等题面 node key 归一为类型骨架 `entry→service(http)→vuln(lfi)→vuln(rce)→foothold(rce)→goal`；服务节点只保留协议 token；战术词表归一（`path-traversal→lfi`、`pickle→deserialization`…）。
3. **清洗与白名单**（`methodology.py`）：只允许 stack/cue/process/tactic 白名单 token；含 IP/端口/路径/题面词的 lesson 直接判不像话丢弃（`scrub_lesson`/`scrub_chain`）。
4. **置信度反馈**：`_confidence(wins,fails,uses)=0.4+0.12·wins−0.14·fails`（clamp 0.18–0.95），`uses≥4 & wins=0` 再降 0.1；每局用到的 lesson 做 `reinforce_lessons`。
5. **回灌**：下一局 `retrieve_lessons(limit=6)` 注入简报「进化经验」；经验还转成 `prefer_tactics`/`avoid` 影响规划。

**对 SilkSecAgent 的意义**：SilkSecAgent 的 L0–L6 有更严的治理门（候选版本层、独立评测、审批发布、回滚），但**蒸馏的「去特化」与「置信度在线反馈」不足**，且历史遗留「kb 消费率低」。可把这条作为 L 链的「质量提升」，不需要推翻治理。

### 4.5 可信度工程：二次评级 + 二次验证

- `report_finding` 首次上报允许证据不全 → 进 `findings_pending_review`。
- 后台 `finding-review` 角色（独立 Pi，`--no-session`）**再打一遍**：不得新建条目、必须带原 `finding_id` + `node_key`；版本命中/白名单文件写**不是 RCE**；任意文件读写默认中危；一般 SQLi/存储 XSS/越权不得抬成高危。
- 硬降级：`coerce_unproven_rce_claim` —— **未证明执行则 severity/rating ≤ medium**。
- 评级必须带 `redteam_rating_rationale ≥ 40 字`；`RATING_RUBRIC` 四级表（严重/高危/中危/低危）供复核引用。
- 只有通过复核、够格的 finding 才进记忆蒸馏与交付报告。

**对 SilkSecAgent 的意义**：SilkSecAgent 现有 `vuln_verify_replay` 只做**机械重放**（sha256 比对 request.txt），能防「改口径」，但防不了「AI 夸大」。补一个独立 AI 复核任务 + rubric + 硬降级，是把「五要素门」升级为「交付级可信度」。

### 4.6 侦察螺旋（不打歪又扩面）

`spiral.py` 用 `SPIRAL.json` 账本管理三圈（小→中→大），档位映射：第 1 圈 top-100/common/whatweb，第 2 圈 top-1000/medium/dnsmap/nuclei，第 3 圈 all/large/nikto。规则：

- `note_empty_plan()`：**高质量增长清零空转；非 infra 空转 +1；满 `empty_plan_cap`（默认 6）且未到大圈才 `allowed_ring += 1`**。
- `redteam_stall_pause_due()`：**只有 `allowed_ring>=3` 之后才允许整猎 stall 暂停**——小/中圈不许因空转停。
- 简报强调「按本圈完整清单做，不要因小圈做过而省略」「第 1 圈禁止抢跑 top-1000/-p-/中档目录/旁站」。

**对 SilkSecAgent 的意义**：直接补「资产重扫/覆盖度」的节奏管理，避免「一上来全端口大字典」或「扫过一次就当覆盖」。与 ledger 的 `coverage-latest.md`、`radar-queue` 天然契合。

---

## 五、关键问题：自行持续挖掘 vs 定时任务

> 用户原问：「自行挖掘是否可以实现，自行持续挖掘是否比定时任务更好？」

### 5.1 先澄清：StrikeAgent 的「自循环」到底是什么

它**不是**一个「每 5 分钟跑一次扫描」的定时器。事实是：

- 一个项目 = **一个长驻协程**（`asyncio.create_task(run_project_loop(...))`），从启动一直跑到终止条件满足。
- **轮与轮之间没有定时器**：`agent.run_turn()` 返回就立刻进入下一轮。
- **它也不是「无脑一直跑」**：有 8 类终止条件、空转阈值、墙钟/轮数上限、`allowed_ring` 门槛。
- **它的「续跑」靠持久化 + 启动重拉**，不是靠调度器：`hunt_clock.py` 存 turn/elapsed/idle，`hunt_resume.py` 重启后只接回当时占槽的项目。

一句话：**StrikeAgent 的自循环 = 一个由「攻击图 + 目标状态」驱动、有界、可中断、可续跑、有终止条件的项目推进循环。**

### 5.2 定时任务的本质与边界

SilkSecAgent 现在的模型：`task scheduler` 60s tick 领取 `next_run_at<=now` 的任务，起 headless worker 执行，任务之间空闲。它的优点：

- **简单、可治理、幂等**（每任务有预算、有 `task_runs`、可 cancel/reap、可审批）。
- **适合周期性/可拆分/独立**的工作：资产重扫、候选 TTL 治理、报告、备份、知识刷新、代理池刷新。
- **成本可预测**（每次跑固定预算）。

它的边界（也正是「自行挖掘」要解决的）：

- **任务之间无记忆推进**：一个 recon 任务跑完，系统不会自动决定「因为发现了 Swagger，所以下一步该测未授权接口」——除非人/事件再造一个任务。
- **FGS 只活在任务内**：任务一结束，决策图就断了，无法跨任务累积成攻击链。
- **无法表达「本轮没打完」**：定时任务是「一次性/周期性」语义，而渗透推进是「上一步结果决定下一步」的状态机语义。
- **空转/跑偏无机制**：定时器只会按时再来，不会因为「连续 6 轮无高质量增长」而升圈，也不会因为「还没到第 3 圈」而拒绝停止。

### 5.3 结论：分层，不是替代

**「自行持续挖掘」与「定时任务」不是二选一。** 正确形态是三层：

```
第 3 层  猎面编排循环（新增）      ← 「下一步打哪里」由攻击图/目标状态驱动，有终止条件
             ↑ 读图/派生 Intent，调用 ↓
第 2 层  任务执行引擎（已有）        ← task 域 + scheduler + exec worker，负责「把一件事干完」
             ↑ 事件订阅 + 定时触发 ↓
第 1 层  维护/心跳（已有）           ← TTL 治理、记忆 sweep、代理刷新、备份、报告
```

- **定时器**留在第 1 层做「心跳/维护/触发源」，以及第 2 层做「周期性任务续期」——**不要用定时器表达渗透推进**。
- **自循环**放在第 3 层：由 `exec.run.completed` / `vuln.signal.confirmed` / `asset.upserted` 等事件 + 状态变化驱动，而不是「每 60s 检查一次该不该打」。
- **定时任务仍然必要**：作为兜底心跳（比如「无事件且未终止且无人工暂停时，每 N 分钟评估一次是否该推进下一 Intent」），以及处理「事件不会来」的维护工作。

**对「比定时任务更好吗」的直接回答**：在「多轮、有状态、需要根据上一步结果决定下一步」的渗透推进上，**状态/事件驱动明显更好**（更准、更省、不空转、能终止）；在「周期性、独立、幂等」的工作上，**定时任务仍然更好**（更简单、更可审计）。两者叠加才对，取代是错的。

### 5.4 在 SilkSecAgent 上的具体设计（可实现性论证）

「自行挖掘」在 SilkSecAgent 上**可以实现**，且不需要推翻现有架构。具体形态：

**新增「猎面编排器」（hunt orchestrator）**，作为一个常驻组件（与 task scheduler 同级，仅 web profile，单实例文件锁）：

1. **状态源**：项目级攻击图（nodes/edges/findings/intents）+ 现有 `asset/endpoint/vuln/fact` 域 + `scope.yml`。
2. **唤醒源**（事件优先，心跳兜底）：
   - 订阅 `exec.run.completed`、`vuln.signal.confirmed`、`asset.upserted`、`endpoint.queued`、`task.finished`；
   - 兜底心跳（如 5–15 分钟）评估「是否该推进」；
   - 人工 chat steering（复用 DSH 会话）→ 立刻打断当前任务并覆盖规划。
3. **每轮决策**：
   - 用 `hypothesize` 从图派生/重算 ready Intent；
   - 编译「局面硬约束」（未消费凭证/未关输入面/已验证洞/跳板禁令/授权到期）；
   - （可选）调一次无工具规划 LLM 产出参考假说；
   - 用**确定性规则**把「参考假说 + 局面」合成下一批任务 → 通过现有 `task_create`（actor=scheduler/orchestrator）派发。
4. **执行**：仍走现有 `exec_spawn_worker`（phase=recon/vuln/review），不新增执行通道。
5. **回收**：worker 结束 → 结果落图 + FGS 快照合并进项目图 → 更新空转/圈层账本 → 回到 3。
6. **终止/暂停**：goal（SRC 无 goal，改为「覆盖度达标 / 无 open Intent / 预算耗尽」）、`stall`（需 `allowed_ring>=3`）、预算、scope 过期、入口死、人工暂停。
7. **安全**：编排器的所有派发仍走 bus → scope/approval/exec guard，**不新增任何绕过**；规划输出必须经「局面编译 + 违规丢弃」，绝不把 LLM 原文当命令。

**可行性**：SilkSecAgent 已具备除「项目级图 + 编排器」之外的全部零件（事件总线、任务、exec、scope、approval、knowledge、FGS）。缺的只是 `graph/intents` 两张表和一层循环。**工程量中等，风险主要集中在「成本控制」和「规划幻觉」两条，而这两条恰好都能用 StrikeAgent 的终止条件 + 局面编译来治。**

---

## 六、SilkSecAgent 是否需要大改？

### 6.1 结论

**不需要大改。** 属于「**新增一层编排 + 若干域增强 + 知识质量提升**」的中等增量：

- 现有 14 域 + 总线 + outbox + approval/scope fail-closed + sandbox + 六态台账 + L0–L6 学习链，**全部保留**，这些是 StrikeAgent 没有的工程资产。
- 不需要换运行时（继续 DSH + Bellkeeper 网关），不需要搬 StrikeAgent 代码（AGPL + 架构不兼容）。
- 最大新增是「项目级攻击图 + 猎面编排器」，但它是**旁挂**在现有 task/exec 之上，而非侵入式改造。

### 6.2 必须保留的资产（不可退让）

1. `scope.yml` fail-closed + exec 9 步 guard + 审批 kind + sandbox：**红线**，编排器不得绕过。
2. 总线 11 段 pipeline + outbox + 审计 fail-closed：所有写路径唯一入口。
3. 多进程 + SQLite WAL（已复评定案）：不因引入编排器而改。
4. `task` 的单实例锁与 `task_reap`/`worker_reap`：编排器必须与之协调，不能并存两个调度循环。
5. L0–L6 的「模型不能自评/自发布」治理：**吸收 StrikeAgent 的去特化/置信度时不得放松发布门控**。

### 6.3 缺口（要补的）

| 缺口 | 现状 | 补法 |
|---|---|---|
| 无项目级攻击图 | FGS 只在任务内 | 新增图域（复用 FGS 思路，上提到 program 维度） |
| 无 Intent 自动派生 | 任务靠人/定时/事件 | `hypothesize` 移植（确定性规则，非 LLM） |
| 无目标推进循环 | 任务之间空闲 | 新增猎面编排器（事件驱动 + 心跳兜底） |
| 规划输出无代码校验 | prompt 层无 fail-closed | 局面编译器（图 → 硬约束）+ 违规丢弃 |
| 缺独立二次复核 + 评级 | 只有机械重放 | 新增 review 角色任务 + rubric + 硬降级 |
| 覆盖度/升圈无机制 | 有 coverage/radar 但无升圈门槛 | 螺旋圈层账本 |
| 记忆去特化/置信度弱 | 有 exp_cards 但蒸馏粗 | 移植 generalize/methodology 白名单 + wins/fails 反馈 |
| 成本归因缺失 | `spent_tokens` 恒 0（INV-T13/14 未实现） | 自循环前必须先补，否则持续挖掘会失控 |

> 注：最后一条是**前置阻塞项**——自循环一旦常驻，没有每任务/每项目成本归因与预算闸，风险不可控。StrikeAgent 用墙钟/轮数/空转三重上限，SilkSecAgent 应先补 `budget_tokens`/`spent_tokens` 与项目级预算。

### 6.4 分阶段路线图

**Phase A（低风险，1–2 个会话）— 可信度与纪律**
- A1 二次复核角色任务（P0-1）+ 评级 rubric + 未证明执行硬降级。
- A2 图纪律/否证纪律/prompt 化（P0-2、P0-4）。
- A3 基础设施失败 vs 方法失败分类（P0-3），接 `learning_episodes`。
- A4 螺旋圈层账本接入 ledger/coverage（P0-5）。
- 验收：契约测试 + `sec-v5-accept.sh` + 一次真实 SRC 流水线对照（复核前后误报率）。

**Phase B（中等，3–6 个会话）— 项目级图与编排器 MVP**
- B1 新增图域（nodes/edges/intents），与 asset/vuln/fact 投影互通。
- B2 `hypothesize` 确定性派生 Intent（strategy_key 去重）。
- B3 猎面编排器 MVP：单项目、事件驱动、心跳兜底、只派 `recon/vuln/review` 三类任务，**先手动开关**（默认关）。
- B4 局面编译器 + 违规输出丢弃。
- B5 成本归因与项目级预算（阻塞项，必须在 B3 之前或同时）。
- 验收：单靶场端到端「图驱动推进 N 轮 → 终止」；无绕过 scope/approval 的证据；预算内完成。

**Phase C（较大，视 B 结果）— 自进化闭环**
- C1 去特化蒸馏 + 置信度反馈 + 回灌简报。
- C2 多轮终止条件完备（stall 需 `allowed_ring>=3` 等）+ 跨重启续跑。
- C3 人工 steering 打断/覆盖规划。
- C4 与 L0–L6 治理打通（仍由审批把关发布）。
- 验收：离线回放 + 灰度（单 program）+ 成本曲线 + 记忆质量抽检。

### 6.5 明确不建议做的

- ❌ 整体迁移到 StrikeAgent 的单体 Python + SQLite 直连 + 自研 Pi 运行时。
- ❌ 用「自循环」替换掉 task 调度器（应叠加，不应替换）。
- ❌ 让 LLM 规划输出直接当命令执行（必须先过局面编译）。
- ❌ 在成本归因落地前开启常驻自循环。
- ❌ 放松 scope/approval/sandbox 以「提高自主性」。

---

## 七、落地映射表（域 / 表 / 插件）

| 借鉴项 | 落到 SilkSecAgent 的位置 | 类型 |
|---|---|---|
| 项目级攻击图 | 新域 `attack-graph`（或并入现有 `fgs` 上提）→ 表 `ag_nodes/ag_edges/ag_intents` | 新增域 |
| Intent 自动派生 | 新域 `attack-graph` 的 reactor 订阅（asset/endpoint/vuln/fact/exec 事件） | 新增订阅 |
| 猎面编排器 | 新插件 `sec-hunt-orchestrator`（web profile 常驻，单实例锁 `hunt.lock`） | 新增插件 |
| 局面编译器 | 编排器内纯函数模块（图 → binding），可独立契约测试 | 新增模块 |
| 二次复核 + 评级 | `task`（phase=review 任务）+ `vuln`（评级列/理由列）+ 新 `rating-rubric` 规则 | 增强 |
| 硬降级 | `vuln` 域 `vuln_register_signal`/`vuln_confirm` 不变量（未证明执行 ≤ medium） | 增强 |
| 去特化蒸馏 | `know` 域 `know_episode_record` → `know_revision_propose` 之间加 generalize/scrub | 增强 |
| 置信度反馈 | `know` 域 `exp_cards` 增 wins/fails/uses；`know_feedback_ingest` 扩展 | 增强 |
| 螺旋圈层账本 | `ledger` 域（`SPIRAL.json` 语义落 `data/pipeline/{program}/spiral-*.jsonl`）+ `exec` 扫描记账 | 增强 |
| 入口身份比对 | `asset` 或新 `entry-identity` 查询；与 scope program 绑定 | 增强 |
| track-agnostic 守卫 | 各核心模块加断言（不改行为） | 增强 |
| 成本归因 | `task` 域 `spent_tokens`（INV-T13/T14）+ `exec` 上报 + 看板 | 补欠账 |

---

## 八、明确不借鉴清单

| 不借鉴 | 理由 |
|---|---|
| Pi / deepseek-flash 运行时绑定 | SilkSecAgent 已用 DSH + Bellkeeper 网关，模型可换、有额度/熔断/粘性；换运行时是倒退 |
| 单体 FastAPI + SQLite 直连 | SilkSecAgent 的 14 域 + 总线 + outbox + 审计 fail-closed 是更成熟的工程形态，不应退化 |
| Yakit MITM 作 HTTP 首跳 | 商业/Windows 组件；SilkSecAgent 已有 xray 被动扫描 + mubeng 代理池 + shared-browser，方向一致不必照搬 |
| 控制台「随机入口 + Argon2id + RSA-OAEP」机制 | 面向公网暴露的独立产品；SilkSecAgent 经 edge Caddy + 内网，风险面不同。个别点（如 Swagger 关闭）可参考 |
| 把 `next_plan` 自由散文直接执行 | 与 4.1「参考假说 vs 局面硬约束」原则冲突，是必须避免的反面 |
| 直接复制 AGPL 代码 | 许可 + 架构不兼容；只吸收设计思想 |
| 「一直跑」的伪自循环 | 与 4.3 终止条件设计冲突；无界 = 烧钱 + 失控 |

---

## 九、合规与风险

- **合规**：StrikeAgent 仅面向「已获明确授权的环境」；SilkSecAgent 的 `scope.yml` fail-closed 是更严的合规基线，吸收任何自主能力都**不得**削弱该基线。自循环 = 更自主，合规审查必须更严。
- **成本风险**：常驻自循环最可能失控的是 token 成本。**成本归因 + 项目级预算 + 空转上限**是开启前提（见 6.3 阻塞项）。
- **规划幻觉风险**：用「局面编译 + 违规丢弃 + 独立复核」三层兜底，禁止 LLM 输出直连执行。
- **审计风险**：编排器的每次决策（选了什么 Intent、为什么、丢弃了什么御主假说）都必须可审计落盘，否则 fail-closed 审计链在规划层出现断点。
- **漂移风险**：吸收后须在对应模块文档回填（`05-task`/`07-know`/`14-fgs`/`16-dashboard` + 新增图域与编排器文档），并登记 README。

---

## 十、一句话回答用户四个问题

1. **有哪些能力可以借鉴？** 6 类：攻击图 + Intent 派生、参考假说/局面硬约束分离、二次复核+评级、自循环终止条件、去特化记忆、侦察螺旋；另有若干纪律细则（图纪律、infra vs method、假否证防护、邻题隔离）。
2. **有哪些方法可以吸收？** P0 的 6 项可立即做（纯知识/prompt/规则层）；P1 的 8 项需增量改造（图域 + 编排器 + 记忆增强）。
3. **是否有突破性思路？** 有，最有价值的是 **「LLM 只产假说，循环把图编译成硬约束」** 和 **「有终止条件的图驱动自循环」**——这两条直击所有 LLM Agent 的通病。
4. **自行持续挖掘是否比定时任务更好？需要大改吗？** 不是替代而是分层：**状态/事件驱动负责推进，定时任务负责心跳与周期维护**；自行挖掘可实现且不推翻架构，但**必须等成本归因落地后再开**。SilkSecAgent **不需要大改**，分 Phase A/B/C 三期增量即可。
