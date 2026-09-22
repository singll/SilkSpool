# SilkSecAgent SRC 漏洞发现体系重构方案（审查·评估·设计）

> 日期：2026-09-22（初版 2026-09-21，历经三轮审查后整体重构）
> 性质：**在办专项（研究/决策文档）**，非实施记录；决策落地后按 [README](README.md) 治理规则回填对应模块文档并归档。
> 北极星：**系统自主、持续地发现高质量、可提交的真实 SRC 漏洞（Web / App / 小程序，纯黑盒）**。提交是人的运营动作，不做系统 KPI；0day/打榜/靶场非目标；白盒审计仅预留接口、主线不依赖。
> 证据基线：全部论断以 `spool exec csai` 2026-09-22 运行态实测为准（§二）。
> 对标：StrikeAgent_AtkBrain-Flash + 12 个外部项目（Strix / CyberStrikeAI / HexStrike AI / CAI / PentAGI / pentest-ai / DeepAudit / VulnHuntr / Pentest-Swarm-AI / PentestAgent / NeuroSploit / burpgpt），2026-09-22 在线核实，结论压缩在 §三。
> 总原则：**以减法为主**——不新增域、不盲目扩工具、不接全家桶；架构已够复杂，可靠性优先于能力清单。
> 文件名说明：沿用原文件名（治理不鼓励新建专项文档）；README 索引描述待回填时更新。

---

## 一、一页结论

1. **病灶一句话**：系统握着 96,814 个资产，却只有 357 个端点（平均 1 端点/主机）、11 个带参数、全 program 参数喂料队列合计 1 行——**发现漏斗在第二层就断了，之后所有环节都在为空管道优化**。44 条 confirmed（high 仅 5）几乎全部来自人工点名深挖，自动化产出≈0。
2. **根因四层**：① **无覆盖机制**——系统不知道「测了多少、还剩多少、下一步该测什么」；② **无登录态判定**——未授权漏洞（SRC 最高产类别之一）无从谈起，无法登录时的盲区也无记录；③ **无假设生成**——发现靠「等扫描器报」，不靠「按参数主动构造验证」；④ **进化闭环断裂**——361 条学习记录 0 条蒸馏成经验，收割通道空转，打法无固化通道。
3. **重构主线（五步）**：**覆盖账本 → 登录态判定 → 假设引擎 → 机器验证 → 反馈进化**。前两项是本次重构新增的地基，后三项在此前审查基础上整合。
4. **反馈/优化功能的形态决策（§七）**：**不新增域**。「反馈与优化」作为**逻辑中心**（Feedback Core）落在 know 域内——三个订阅 reactor + 一个统一记分投影，复用 L0–L6 治理与事件总线。域是写入边界的划分，反馈天然消费全域事件、向全域回灌，建新域只会再造一个需要被治理的孤岛。
5. **工程判定**：零新域、零新通道。Phase 0（基础能力补全）全部用现有工具与机制即可启动，1–2 个会话见效；最重的新增是三个纯函数/订阅处理器（覆盖账本、oracle、蒸馏 reactor）。

---

## 二、病灶：运行态诊断（2026-09-22 实测）

### 2.1 发现漏斗实测

```
assets 96,814（web 1,239）
  → endpoints 357（覆盖 328 主机，平均 1 端点/主机）        ← 断层 ①
    → 带 params 的端点 11（2%）；param-queue 全 program 合计 1 行  ← 断层 ②
      → 假设任务：不存在（机制空白）                        ← 断层 ③
        → 机器验证：不存在（confirm 只校验证据引用存在）     ← 断层 ④
          → confirmed 44（high 5 / medium 8 / low 20 / info 11）
```

工具使用偏科铁证：httpx 385 / subfinder 332 / nuclei 192（侦察类），katana 43 / gau 14 / waybackurls 5（端点三件套合计 62）、arjun 13、**sqlmap 2**（验证类近乎闲置）；nuclei 全程仅直产 1 条 confirmed。confirmed 类型集中在信息泄露 19 / RLS 开放 9 / 中间件暴露 3——**SRC 主粮（越权/IDOR、注入、SSRF）为零**。

### 2.2 进化闭环实测

| 环节 | 实测 | 判定 |
|---|---|---|
| episode → 经验卡 | 361 条 learning_episodes，**card_id 关联 = 0**；353 条是 `run_ok_no_verdict`（只记跑完、不记学到什么）；44 张 exp_cards 全部人工/种子来源；knowledge_revisions 全程 5 条、published 1 | **断** |
| 缺口感知 → 主动学习 | know_gaps **0 条**；`data/harvest/` 空目录、无 candidates.json | **断** |
| 打法固化 | tools.d 自 2026-08-25 起一个月零新增；「成功打法→脚本/manifest」通道在设计上不存在 | **断** |
| 知识消费 | kb_docs 413 篇 **85% 零使用**；know_exposures 3 条、know_feedback 4 条 | **卡** |
| 成本归因 | `spent_tokens` 恒 0（INV-T13/T14 未实现） | **缺** |

### 2.3 覆盖与登录态实测

- 522 端点中 `auth_required` 标注仅 52 条、`roles_seen` 仅 5 条——**系统不知道哪个接口要登录**；
- credentials 表仅 1 条——**meituan-src / bytedance 两个真实 program 无任何登录凭据**，意味着登录后攻击面从未被触碰，且**没有任何地方记录这个盲区**；
- 无任何覆盖率度量：「这个 program 测了多少、还剩多少」全系统无人能答。

### 2.4 必须保留的护城河（不可退让）

scope.yml fail-closed + exec 守卫链 + 审批 kind 注册表；14 域 + 总线 + outbox + 审计 fail-closed；vuln 状态机与 INV-1~10 不变量；L0–L6 知识治理（模型不能自评/自发布——12 个对标项目无一做到）；eval 物理隔离；31 工具 manifest + bwrap 沙箱 + 凭据隔离。**问题从来不在工具与治理，在编排、覆盖与反馈。**

---

## 三、外部对标压缩结论（12 项目 + StrikeAgent）

> 逐项分析见前三轮审查（已合并入本文结论）。评判标准唯一：对「自主发现更多、更准的真实 SRC 漏洞（纯黑盒）」有无正交贡献。

**值得吸收的五个思想**（按收敛证据排序）：

| # | 思想 | 收敛证据 | 落点 |
|---|---|---|---|
| 1 | **机器验证优于模型声明**：oracle 差分判定（攻击 vs 对照），模型无权宣布 verified | pentest-ai（machine oracle）、Strix（PoC）、StrikeAgent（二次复核+硬降级）三方收敛 | Phase 2 |
| 2 | **input→sink 污点路由**：参数形态决定打哪类洞，是假设引擎的路由表 | VulnHuntr（白盒调用链的黑盒化） | Phase 1 |
| 3 | **有界推进 + 覆盖驱动**：状态/事件驱动、有空转账本与终止条件，LLM 只产假说、代码编译硬约束 | StrikeAgent、PentAGI（reflector）、Swarm（事件唤醒） | Phase 0/3 |
| 4 | **去特化记忆 + 真实反馈**：经验剥离目标细节成战术骨架，置信度由 wins/fails 校准；SRC 平台裁决是我们独有的终极裁判 | StrikeAgent；双裁判为本方案强化 | Phase 4 |
| 5 | **被动流量/视觉分流**：App/小程序端点面的主力来源（主动爬虫对小程序基本无效） | burpgpt（flows 信号路由）、CyberStrikeAI（视觉判读） | Phase 1 |

**明确不吸收**（减法红线）：MCP 生态（CyberStrikeAI/HexStrike/PentestAgent——信任边界外移）；工具数量军备（HexStrike 150 工具产出寥寥，证明工具≠发现）；agent 自我繁殖/swarm 大并发/435 专科 agent（PentestAgent/Swarm/NeuroSploit——成本与治理失控）；Langfuse/Grafana 全家桶（PentAGI）；auto-fix/C2/WebShell/CI 门禁（越出授权 SRC 边界）；FAIR 量化（SRC 赏金就是现成价值信号）；CAI 框架本体（已归档，仅取其 prompt-injection 防护研究结论）。

---

## 四、地基一：覆盖账本（Coverage Ledger）——回答「测了多少、还剩多少、下一步测什么」

### 4.1 覆盖矩阵（per-program，单一事实源）

落在 ledger 域（不新建域），三个维度交叉记账：

| 维度 | 粒度 | 记账内容 |
|---|---|---|
| **资产面** | host × 爬取状态 | 未爬 / 爬取成功（端点数）/ 爬取失败（原因分类） |
| **参数面** | endpoint × 参数状态 | 无参数 / 已补参（arjun/flows/JS）/ 已入喂料队列 / 已被测试消费 |
| **漏洞类面** | endpoint 或 host × 七类主粮（IDOR/注入/XSS/SSRF/文件/信息泄露/鉴权） | 未测 / 已测（verdict: verified/rejected/inconclusive）/ 不可测（缺前提，注明原因） |

### 4.2 派生指标（看板可查，回答「估算多少已覆盖」）

- **爬取覆盖率** = 已成功爬取 host / web 资产 host 总数；
- **参数覆盖率** = 带 params 端点 / 端点总数（基线 2%）；
- **登录覆盖率** = 已登录态测试端点 / 需登录端点总数（基线 0%）；
- **漏洞类覆盖率** = 七类主粮中已测类数 / 7（per host、per program 两档）。

### 4.3 覆盖缺口队列（回答「接下来覆盖什么」——比估算更重要）

覆盖账本的**输出不是报表，是队列**：每个「未爬/无参数/未测类/登录盲区」格点自动生成一条覆盖缺口项（strategy_key 幂等去重），按优先级（高危类 × 高价值资产 × 新资产面）排序，作为 Phase 3 Intent 派生器的输入。**系统对「下一步该测什么」的回答从「不知道」变成一张可执行、可审计、可排优先级的清单。**

### 4.4 登录盲区摘要（回答「没法登录时怎么办」）

当 program 无可用凭据（credentials 表为空）或凭据失效时，账本自动生成**登录盲区摘要**并在看板显著呈现：

> 「meituan-src：未登录状态已覆盖 X/Y 端点；判定需登录的端点 Z 个（占 W%）**完全未测**；其中高价值功能点 N 个（支付/订单/用户中心…）。→ 需要：登记登录凭据（scope 域 cred_add，引用形态）。」

这条摘要同时是一个**人工行动项**（看板一键跳 cred_add 引导），并作为该 program 一切「覆盖率」数字的分母修正——**未登录态下的 100% 覆盖必须被明确标注为「仅公开面 100%」**，防止虚假安全感。

---

## 五、地基二：登录态判定与未授权发现（Auth-State Engine）

### 5.1 端点登录态分类（endpoints 表既有 `auth_required`/`roles_seen` 列，补齐判定器）

| 状态 | 判定方式（确定性优先，LLM 辅助） |
|---|---|
| `public` | 无凭据请求返回 200 且含业务数据（非模板页） |
| `login_required` | 无凭据请求 → 302 至登录页 / 401/403 / 响应体与登录页高相似度（simhash） |
| `role_required` | 有低权凭据可访问、但行为表明存在更高权面（经 credentials.role 差分） |
| `unknown` | 判定证据不足，**显式标记、不许猜** |

判定器 = 纯函数（无凭据探测一次 + 响应特征），exec 守卫链内被动/主动随 program risk 配置；结果落 endpoints 列，进覆盖矩阵。

### 5.2 业务语义标注（未授权发现的关键，且必须留人工通道）

未授权访问漏洞的本质是「**应该登录却没拦**」，而「应该不应该」是业务判断，机器只能给建议。设计三层：

1. **自动建议**：路径词表（admin/internal/manage/pay/order/user…）+ 响应语义（含他人数据/管理面特征）给出 `should_auth` 建议与置信；
2. **LLM 业务理解**：对存疑端点，结合页面功能描述（视觉判读/响应文本）生成业务归类建议——**只产假说，不入库为事实**；
3. **人工裁定通道**：看板端点视图增加 `should_auth` 人工标注（actor=dashboard，走 endpoint 域既有命令，审计留痕）。**人工裁定 > 自动建议**，裁定结果即成为后续 IDOR/未授权假设的硬前提。人工同时可反向标注「此类接口本就该公开」（防误报批量产生）。

**未授权假设生成**：`should_auth=true`（人工或高置信自动）∧ 实测 `public` → 直接产高优先假设任务（oracle：双请求差分——无凭据拿到业务数据即 verified）。

### 5.3 凭据缺口与人工供给

- 登录态测试依赖 scope 域 `cred_add`（凭据引用，host 必须 ∈ scope，明文零入库——既有红线不变）；
- worker 执行登录态任务时经凭据引用取会话（cookie/token 注入请求头），全程走 exec 沙箱与审计；
- 凭据缺失/失效 → 自动触发 §4.4 登录盲区摘要 + 一条 dashboard 待办；**系统永远不尝试自行注册/爆破账号**（合规红线）。

---

## 六、假设引擎（Hypothesis Engine）——从「等扫描器报」到「按参数打」

> 前置说明：假设的信息底座由 Phase 0 补齐（端点爆发 + 参数补全），**底座不到的层不许出对应级假设**——这是防幻觉的第一道闸。

### 6.1 三级假设（级别即保底）

| 级 | 信息要求 | 生成方式 | 例子 |
|---|---|---|---|
| **H1 保底假设** | host 存活 + 栈指纹 | 纯确定性规则，零 LLM | Spring→Actuator 暴露；Shiro→默认 key；Weblogic→wls-wsat；通用→敏感路径 ffuf |
| **H2 参数路由假设** | 端点 + 参数清单 | 确定性污点路由表：数值 id→IDOR；查询串→SQLi；回显→XSS；URL 参数→SSRF；file→上传；redirect→开放跳转；`should_auth∧public`→未授权 | `/user/detail?id=123` → IDOR（双身份差分） |
| **H3 语义假设** | 功能画像 + 知识卡片 | LLM 生成但**必须引用卡片与证据**、落 schema、过局面编译，违规丢弃；连败自动退回 H2/H1 | 「先 /init 再 /pay、订单号可枚举未校验归属 → 越权下单」 |

**任何存活资产至少产出 H1**——全系统永不空转；H1/H2 全程零 token；LLM 只在 H3 介入且被代码校验。

### 6.2 生成管线（全确定性优先）

```
端点入库 → 参数补全（arjun/flows/JS 提取，修 param-queue 空队列）
        → 功能画像 + 登录态判定（§五）
        → 路由表匹配（栈→H1；参数形态→H2；功能+卡片→H3 候选）
        → strategy_key 幂等去重（host+param+class 已测组合不重发；连败 N 次黑名单）
        → 假设任务草稿 → 预算闸 → 入队
```

### 6.3 质量保证回路（「质量每次提高」的机制保证）

假设质量 = **命中率**（假设任务 → verified 的转化率）。三条回路让路由表从静态规则变成被结果校准的权重表：① verdict 回写「参数形态 × 栈 × 漏洞类」命中矩阵（know_scores 既有设施），连续不命中的组合自动降权；② H3 引用的经验卡吃 wins/fails，`uses≥4 且 wins=0` 降权；③ 未测组合自动成缺口驱动扩张。**不提高的组合被数据自动淘汰，这就是"每次提高"的结构保证。**

### 6.4 保底四层

B1 产出保底（H1 永不空转）｜B2 降级保底（H3 连败退 H2、H2 无参退 H1，降级落审计）｜B3 幻觉保底（假设永不直接变 finding，oracle verified 才能 confirm）｜B4 预算保底（预算闸 + 连败黑名单）。

---

## 七、反馈与优化中心的形态决策：**不新增域，建 Feedback Core（逻辑中心）**

### 7.1 问题

「学习与增强是否需要一个核心反馈/优化功能，还是新增一个域管控全局？」——这是本次重构唯一的架构形态决策点。

### 7.2 决策：Feedback Core = know 域内的三个 reactor + 一个统一记分投影

**不新增第 15 个域**，理由：

1. **域是写入边界的划分，不是功能的划分**。反馈中心天然「消费全域事件、向全域回灌」——它没有自己的新数据形态（命中矩阵落 know_scores、经验卡落 exp_cards、缺口落 know_gaps、权重回落路由表），为它建域等于建一个只转发不持有的壳，再造一个需要被治理的孤岛；
2. **治理复用**：反馈产出的最高风险物是「知识变更」，而 L0–L6 已经解决了「模型不能自评/自发布」——Feedback Core 的产物一律走 revision 候选 → 独立评测 → 审批发布，**新增域反而要重建这套治理**；
3. **先例**：know_episode_record / know_revision_assess 已是 reactor 物理独占的成功模式，Feedback Core 是同型扩展。

### 7.3 组成（全部落在既有域与表上）

| 组件 | 职责 | 落点 |
|---|---|---|
| **蒸馏 reactor** | episode/verdict → 按 `栈×参数形态×漏洞类×验证手法` 聚合去特化 → know_revision_propose 候选（不蒸失败局、不蒸无 verdict 的 episode） | know（新订阅，复用 L 链） |
| **记分 reactor** | verdict/复核/平台裁决 → 命中矩阵 + exp_cards/playbook 的 wins/fails/uses 回写 | know_scores / exp_cards（既有表） |
| **缺口 reactor** | 覆盖账本副产品 → know_gaps（未测类/未覆盖格点）；gap 分两路：有 playbook 派假设任务、无 playbook 产收割投喂清单 | ledger + know_gaps + harvest（既有通道 C19） |
| **统一记分投影** | 命中矩阵、卡片置信度、缺口清单一屏可查（只读查询） | 看板查询（know 投影） |

### 7.4 反馈回路全景（每一环都有表、有事件、有审计，无一环依赖模型自觉）

```
oracle verdict ─┬─→ 蒸馏 reactor → 去特化经验卡(治理发布) ─→ 任务开局按信号路由注入 ─→ 下轮假设更准
                ├─→ 记分 reactor → 路由权重/卡片置信度 ────→ 失效组合自动降权出局
                └─→ 覆盖账本   → 缺口 reactor → 假设任务 / 收割清单 ─→ 发现面变宽
稳定打法 ─→ capsule 重放 ─→ worker 脚本固化 ─→ 审批注册 manifest（唯一工具扩张通道）
```

---

## 八、分 Phase 实施路线（每期可独立验收、可回滚）

### Phase 0 — 基础能力补全：覆盖 + 登录态 + 发现面（1–3 个会话，零新架构）

| # | 动作 | 落点 |
|---|---|---|
| 0-1 | **端点爆发**：1,239 web 资产批量跑端点三件套（katana/gau/waybackurls/ffuf），按 program 分批、尊重 QPS/risk | task + endpoint + exec |
| 0-2 | **参数补全器**：无 params 端点自动派 arjun；flows/JS 经 `endpoint_queue_surface` 提取带参 URL 修复喂料队列 | endpoint + exec |
| 0-3 | **登录态判定器**（§5.1）：无凭据探测 + 响应特征分类 public/login_required/unknown，落 endpoints 列 | endpoint + 纯函数 |
| 0-4 | **覆盖账本 MVP**（§四）：三维记账 + 四指标 + 缺口队列 + 登录盲区摘要，看板呈现 | ledger + 看板 |
| 0-5 | **业务语义标注通道**（§5.2）：自动建议 + 人工裁定（dashboard actor，审计留痕） | endpoint + 看板 |
| 0-6 | **候选池止血 + 评级硬降级**：425 条噪声确定性分流；confirm 增 severity×vuln_type 组合校验（信息泄露 ≤ low、未证明执行 ≤ medium） | vuln + rules |
| 0-7 | **H1 保底假设**：指纹→确定性假设规则（零 token，任何资产必有产出） | 规则层 |
| 0-8 | **成本归因**：worker 上报 token 写 tasks.spent_tokens，看板一列 | task + exec |

**验收**：端点 ≥5,000 或全量爬取尝试+失败分类；参数覆盖率 ≥60%；端点登录态标注率 ≥90%；每个 program 有覆盖率四指标与缺口队列；无凭据 program 有登录盲区摘要；每个 web 资产 ≥1 条 H1。

### Phase 1 — 假设引擎 + 第二发现面（2–4 个会话）

| # | 动作 | 落点 |
|---|---|---|
| 1-1 | **污点路由表**（H2）+ 漏洞类 playbook 补强（任务 prompt 按路由注入，顺带接通知识路由） | endpoint + fact + know rules |
| 1-2 | **H3 语义假设**：LLM 产假说 + 局面编译 + 违规丢弃 + 连败降级 | 派生器内纯函数 + prompt |
| 1-3 | **被动流量分流**：flows 信号路由挑「有趣流量」送 LLM 研判产候选；vision_triage 截图判读发现隐藏功能点 | exec flows + rules |
| 1-4 | **App/小程序抓包 SOP playbook**（微信开发者工具/模拟器代理 → mubeng → xray） | know rules |
| 1-5 | **prompt-injection 最小防护**：不可信内容围栏 + eval 注入用例 ×2 | llm-surface + eval |

**验收**：五类主粮各 ≥1 条假设任务自动产生；H3 违规输出被丢弃的审计证据；小程序端点经 flows 入库的证据。

### Phase 2 — 机器验证：让「确认」等于「证明了」（2–3 个会话，可与 Phase 1 并行）

| # | 动作 | 落点 |
|---|---|---|
| 2-1 | **oracle 五件套**（纯函数）：IDOR/越权（双身份或无凭据差分）、信息泄露（敏感模式+对照）、SQLi（布尔/时间差分）、XSS（标记回显+上下文）、SSRF（OOB 唯一判定）；**oracle 输出是 confirm 的唯一合法证据**（vuln 不变量升级） | exec + vuln |
| 2-2 | **proof capsule**：请求对 + 判定规则 + 结果 + 环境指纹落 evidence，可重放，自带重放命令 | vuln 证据面 |
| 2-3 | **登录态 oracle**：should_auth∧public 的未授权假设用「无凭据拿到业务数据」判定；role_required 用高低权凭据差分 | exec + scope 凭据 |

**验收**：五类 oracle 各 ≥3 真阳 + ≥3 假阳进契约测试；一条经 oracle verified 的真实发现；confirmed 池新增条目 100% 附 capsule。

### Phase 3 — 推进层：覆盖驱动的发现（3–5 个会话）

| # | 动作 | 落点 |
|---|---|---|
| 3-1 | **Intent 确定性派生器**：订阅 asset/endpoint/vuln/exec 事件 + 消费覆盖缺口队列，派生任务草稿（strategy_key 去重），一律过预算闸，绝不自动执行 | 订阅处理器（挂既有域） |
| 3-2 | **局面硬约束编译**：scope/预算/连败/授权时效纯函数校验，违规丢弃落审计 | 派生器内 |
| 3-3 | **空转升圈**：自上次高质量增长（verified/新端点簇/新资产面）的轮数记账，连空 N 轮升圈、满 3 圈允许 stall | ledger |
| 3-4 | **任务预算闸**：per-program 周期 token/任务数预算，超额停派+告警（依赖 0-8） | task |

**验收**：单 program「新资产→端点→参数→假设→oracle verified」无人干预跑通 ≥1 条；预算耗尽自动停派证据；无绕过 scope/approval 证据。

### Phase 4 — 反馈进化：Feedback Core 全量上线（2–4 个会话，硬依赖 Phase 2 oracle）

| # | 动作 | 落点 |
|---|---|---|
| 4-1 | **蒸馏 reactor**（§7.3）：episode→去特化经验卡候选→L2–L4 治理发布 | know |
| 4-2 | **记分 reactor**：双裁判（oracle/复核 + SRC 平台裁决 vendor_status 事件化）回写 wins/fails | know_scores + vuln |
| 4-3 | **缺口 reactor**：覆盖缺口→know_gaps→假设任务/收割清单 | ledger + know |
| 4-4 | **打法固化三层通道**：capsule 重放 → worker 脚本固化（判定归代码）→ 审批注册 manifest（唯一工具扩张通道） | exec + tools.d 评审 |
| 4-5 | **eval 收缩**：候选→verified 转化率、verified 高危占比、新漏洞类型/季度，三指标周更 | eval |

**验收**：第一张蒸馏产出、治理发布的经验卡；know_gaps 非空且 ≥1 条转化为任务/收割项；一个打法走通 capsule→脚本→manifest；一条经验卡因真实反馈置信度变化且可审计。

---

## 九、不做清单（减法红线）

| 不做 | 理由 |
|---|---|
| 新增任何域（含「反馈中心域」「攻击图域」） | Feedback Core 是 know 内逻辑中心（§7）；图存储是待证伪需求 |
| 新增工具 manifest（除 4-4 产出驱动通道外） | 工具已齐，缺的是编排（§2.1） |
| 引入 MCP / 工具多通道 | 违背工具单入口 + manifest 守卫 |
| agent 自我繁殖 / swarm 大并发 / 435 专科 agent | 成本与治理失控 |
| Langfuse/Grafana 全家桶 | spent_tokens 一列够用 |
| auto-fix / C2 / WebShell / CI 门禁 | 越出授权 SRC 黑盒边界 |
| 系统自行注册/爆破账号获取登录态 | 合规红线；登录凭据只能人工登记（cred_add） |
| 以提交率为系统 KPI | 提交是人的运营动作 |
| 成本归因落地前开启任何常驻自循环 | 无预算闸的自主 = 烧钱 + 失控 |
| FGS 上提扩建 / know 六仓加仓加动词 | 冻结结构，只补路由与蒸馏质量 |

---

## 十、北极星指标（每周看板可见）

| 指标 | 方向 | 基线（2026-09-22） |
|---|---|---|
| **周新增 oracle-verified 发现数** | ↑ 主指标 | ≈0（44 条存量靠人工） |
| **爬取覆盖率** | ↑ ~100% | 328/1,239 ≈ 26% 且多数仅 1 端点 |
| **参数覆盖率** | ↑ ≥60% | 11/522 ≈ 2% |
| **登录覆盖率**（登录盲区摘要消减） | ↑ | 0%（credentials 仅 1 条，两真实 program 无凭据） |
| 漏洞类覆盖率（七类主粮） | ↑ | 未测 |
| **假设命中率**（假设→verified） | ↑ 逐轮被 verdict 校准 | 未测（机制不存在） |
| verified 中 high+medium 占比 | ↑ | 13/44 ≈ 30% |
| 新漏洞类型产出/季度 | > 0 | 0（vuln_type 分布数月未变） |
| episode→经验卡蒸馏量 | > 0 | 0（361 episode / 0 关联） |
| 单条 verified 成本 | 先可观测再下降 | 不可观测（spent=0） |
| 护栏：scope 越界 / 平台警告 | = 0 | 0（保持） |

---

## 十一、合规、风险与治理

- **合规基线不动**：scope fail-closed、审批 kind、sandbox、审计链全部保留；端点爆发、oracle 主动差分、登录态探测、Intent 派生任务全部过 exec 守卫链与预算闸，无旁路；主动探测须 program `rules.max_risk`/QPS 覆盖，否则走 tool-intrusive 审批。
- **目标负载风险**：Phase 0 端点爆发是千级目标主动爬取，分批 + QPS + 代理池，防打挂 SRC 目标。
- **凭据安全**：凭据只存引用、明文零入库（scope 域既有红线）；worker 用凭据全程沙箱+审计；系统永不自行获取账号。
- **误报外溢**：oracle + rubric + 复核全过才允许登记 confirmed；平台警告数一票否决。
- **文档治理**：决策后回填 02-vuln（不变量）、03-asset/04-endpoint（覆盖/登录态/参数）、05-task（成本/预算）、07-know（Feedback Core/蒸馏/路由）、10-exec（oracle/flows/固化通道）、11-ledger（覆盖账本）、15-eval（三指标）、16-dashboard（覆盖/盲区/记分投影），本文随即移入 archive；README 索引同步更新。

---

## 十二、一句话方案

**先给系统装上「覆盖账本 + 登录态判定」两只眼睛（知道测了多少、还剩多少、哪些要登录），再给「假设引擎 + 机器验证」一双手（按参数主动构造可证伪的测试并由代码判定），最后把「反馈进化」闭环接上（verdict 蒸馏成卡、缺口驱动收割、打法固化成工具）——零新域、零新通道，让 14 个域第一次真正串联成一台发现机器。**
