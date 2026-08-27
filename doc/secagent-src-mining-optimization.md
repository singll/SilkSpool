# SilkSecAgent SRC 漏洞挖掘体系设计规范

> 版本：v2.0 · 2026-08-27（v1.0 全面重构）
> 性质：Living Document，随时修订。基于对 csai 主机 SilkSecAgent（DSH sec-suite）的只读检查与 08-20 ~ 08-27 实际运行数据。
> 适用范围：meituan-src / bytedance 双项目每日 recon+vuln 自动挖掘链路。

---

## 目录

0. [设计原则（五条公理）](#零设计原则五条公理)
1. [总体架构：四层管线 + 三条反馈回路](#一总体架构四层管线--三条反馈回路)
2. [可靠性设计：容错、幂等与覆盖闭环](#二可靠性设计容错幂等与覆盖闭环)
3. [输出契约与防幻觉标准](#三输出契约与防幻觉标准)
4. [覆盖矩阵：开放状态机](#四覆盖矩阵开放状态机)
5. [知识单元体系：四类卡片与注册表](#五知识单元体系四类卡片与注册表)
6. [反馈与学习回路](#六反馈与学习回路)
7. [自由探索机制：规定动作 + 自选动作](#七自由探索机制规定动作--自选动作)
8. [登录态测试方法论与账号获取策略](#八登录态测试方法论与账号获取策略)
9. [资产收集方法清单（开放）](#九资产收集方法清单开放)
10. [落地路线图](#十落地路线图)

---

## 零、设计原则（五条公理）

本规范所有条款从以下五条公理推导，任何后续修订不得违背：

| # | 公理 | 含义 |
|---|---|---|
| P1 | **流程可靠优先** | 步骤必须容错、幂等、可断点续跑；覆盖必须闭环——每个可以发现漏洞的点最终都有终态结论，不允许"漏掉且无人知晓" |
| P2 | **无证据不结论** | 一切输出（有漏洞/无漏洞/不适用/阻塞）必须挂可核查证据与覆盖率分母；用大模型最怕的幻觉倒逼形式化标准 |
| P3 | **万物皆可进化** | 每条漏洞卡、方法、判定依据、思路都是带版本和反馈回路的活体，实践中持续反哺优化 |
| P4 | **格式刚性、内容开放** | 输出格式必须机器可校验（字段结构刚性），但取值集合开放注册（卡片数、状态、理由词表均可扩展），绝不用固定枚举限制能力上限 |
| P5 | **保底 + 自由** | 每次任务 = 规定动作（硬指标，必须完成）+ 自选动作（探索配额，必须产出但方向自由）；当下用不了的想法也要入库留种 |

> 公理间冲突时的裁决顺序：P2（真实性）> P1（可靠覆盖）> P3（可进化）> P5（自由探索）> P4（开放扩展）。

---

## 一、总体架构：四层管线 + 三条反馈回路

### 1.1 正向管线（漏洞发现的完整路径）

```
L1 资产层     域名/IP/端口/存活/形态 ──→ assets.tsv（资产台账）
     ↓ 存活站点
L2 接口层     爬虫+历史URL+JS提取 ──→ endpoints.tsv（接口参数面）
     ↓ 按指纹/形态分派
L3 工具矩阵层  漏洞卡驱动的专项探测 ──→ attempts.tsv（尝试台账）
     ↓ 命中
L4 确认层     验证规程+复现+证据包 ──→ findings + evidence/{id}/
```

**关键认知：漏洞不在域名上，在接口和参数上。** 当前系统从 L1 直接跳到用 nuclei 扫域名，缺失 L2（接口层）是最大结构性缺口——127+276 个存活站的参数面从未系统性收集。L2 是把 dalfox/sqlmap/arjun 等闲置工具激活的前提。

### 1.2 三条反馈回路（正向管线之外的生命线）

```
回路A（日内）：L3 命中 → L4 验证 → 证伪 → PatternCard 证伪条款 + 负账本
回路B（日间）：attempts/卡片使用记录 → 触发器评审 → 卡片升版 → STALE 重测
回路C（长期）：intel/kb/头脑风暴 → IdeaCard 留种 → 条件成熟 → 转正为正式卡片
```

### 1.3 与现状的映射

当前链路 recon(03:00)→vuln(04:00) 保留为调度骨架，任务内容重构：

| 任务 | 原内容 | 新内容 |
|---|---|---|
| recon | 子域 diff + 探活 | L1 全量 + 新增资产 L2 接口层收集 + 注册入口侦察（§8.2） |
| vuln | "未跑过资产跑 nuclei" | 读覆盖矩阵 PENDING/BLOCKED/STALE 清单 → 按卡片执行 → 探索配额（§七）→ 全部留痕 |

---

## 二、可靠性设计：容错、幂等与覆盖闭环

### 2.1 执行可靠性（每一步都可能失败，失败必须是可恢复的常态）

| 机制 | 规范 |
|---|---|
| 批次检查点 | 每批 ≤3 目标/≤600s（沿用已验证纪律）；每完成一个目标立即落盘 attempts 行，**不允许攒批写**——被杀时进度不丢 |
| 幂等 run_id | 每个执行单元有唯一 run_id；重跑时先查 attempts，已有终态（非 STALE）的直接跳过 |
| 工具降级链 | 每类采集/探测动作注册 ≥2 个实现（如子域：subfinder→uncover→fofa API；探活：httpx→curl 脚本）；主工具失败自动降级并在台账记 `tool_fallback` |
| 出口容错 | 000/超时 ≥4 次复探且换出口（沿用现行基线）；代理池健康度开局检查，live_pool 低于阈值当日降级为只读模式并告警 |
| 失败留痕 | 失败 run 必须落 meta（exit_code/duration/stderr 摘要），禁止"仅 1 行日志"的失败（08-24 wmt68eti01fa1 教训） |
| 任务熔断 | 单任务失败率 >50% 或连续 3 目标同错 → 停止本批，转人工/次日，防止烧预算刷垃圾数据 |

### 2.2 覆盖闭环（保证"不漏掉且可知"）

覆盖闭环 = 每个对象在每个维度上都有**终态或明确的非终态理由**：

```
资产闭环：  每个 domain ∈ assets.tsv 必有 status（alive/dead/blocked/na）
接口闭环：  每个 alive web 资产必有 L2 状态（collected/failed/no-surface）
漏洞闭环：  每个 (资产 × 适用卡片) 组合必有矩阵终态（§四）
复验闭环：  每条 CONFIRMED 必有 next_verify 日期，到期自动回队
情报闭环：  每条 N-day/新打法情报必有结论（验证/证伪/无对应部署），不许悬空
```

**"没有漏"的定义不是"扫过"，而是"台账可证"**：任何人随时可查"资产 X 对漏洞 Y 测没测、何时测、什么结论、证据在哪"。

### 2.3 收尾强制清单（每次任务结束前必过）

1. 本批所有目标在 attempts.tsv 中有终态行（无终态 = 任务未完成，不许收尾）
2. 所有 CONFIRMED 有证据包（§3.3）
3. 所有 NOT_APPLICABLE / BLOCKED 有理由值
4. 当日新增 idea 已入库（§七）
5. handoff 已生成且数字与台账一致（§3.4 一致性校验）

---

## 三、输出契约与防幻觉标准

### 3.1 总纲：结论分级与证据绑定

所有产出物中的陈述分三级，级别决定证据要求：

| 级别 | 措辞 | 证据要求 |
|---|---|---|
| **结论（fact）** | "存在/不存在/不适用/阻塞" | 必须挂 evidence 指针（文件路径/run_id/命令+响应摘要） |
| **观察（observation）** | "记录到 X 现象" | 必须有原始记录指针，但允许未定性 |
| **推测（hypothesis）** | "可能/疑似/或许" | **禁止出现在结论字段**，只能进 IdeaCard 或 huntlist，且必须标注验证所需条件 |

### 3.2 防幻觉八条硬标准

1. **分母明确**：任何覆盖率数字必须给出分母来源（资产清单文件 + 行数 + 生成时间/hash），如"覆盖 45/127（alive-20260827.txt, 127 行）"。没有分母的百分比一律视为幻觉。
2. **TESTED_CLEAN 也要证据**："没发现漏洞"和"有漏洞"同级举证——命令、时间、目标响应特征摘要（状态码/长度/关键头）必须落盘。防止模型把"没测"写成"测了没有"。
3. **detect/verify 分离**：命中（detect）与确认（verify）是两个独立动作；CONFIRMED 必须过卡片的 verify 规程 + ≥2 次复现（间隔换出口）。
4. **数字可溯源**：报告中的每个统计数字必须有生成方式（查询语句/文件路径），禁止"约""大概"类数字进正式报告。
5. **格式机器校验**：所有标准产物（assets/endpoints/attempts/handoff）有 schema，任务收尾时自检（必填列、值域、日期格式），不通过 = 任务失败。
6. **禁止词清单**：结论区禁止出现"可能存在、疑似、应该是、理论上、大概率"；这些词只允许出现在 IdeaCard/huntlist。
7. **负例即价值**：NOT_APPLICABLE / FALSE_POSITIVE / BLOCKED 与 CONFIRMED 同等正式记录——防止模型为了"有产出"而拔高结论。
8. **一致性校验**：handoff/日报中的汇总数必须与台账实际行数一致（脚本可校验），不一致即标记异常。

### 3.3 Finding 证据包（可提交性标准）

每条 CONFIRMED 强制目录化 `evidence/{finding_id}/`：

| 文件 | 内容 | 防的什么幻觉 |
|---|---|---|
| `request.txt` / `response.txt` | 原始报文 + 时间戳 + 出口 IP | "我测过"的口头声明 |
| `reproduce.md` | 编号复现步骤，**直接可贴进 SRC 提交框** | 不可复现的运气命中 |
| `verify-log.md` | 每次复验追加一行（时间/出口/结果/响应哈希） | 一次性巧合、WAF 抖动 |
| `screenshot.png` | 浏览器截图（有界面时强制） | 纯文本脑补 |
| `falsification.md` | 证伪检查记录（按卡片 falsification 条款逐项打勾） | 基线/网关统一行为误判 |

finding 必填字段：`vuln_type`(CWE)、`severity`、`affected_url`、`param`、`poc_summary`、`src_ready`(bool)、`card_id@version`。存量 273 条缺 vuln_type 的回填至少到类型级。

### 3.4 标准产物清单与格式契约

**格式刚性：以下核心字段不可缺、列序固定、机器可校验。内容开放：允许在核心列之后追加自定义列（见 §5.6 扩展规则）。**

| 产物 | 路径模式 | 核心字段（最左起固定） |
|---|---|---|
| 资产台账 | `assets-{program}.tsv` | domain, status, first_seen, last_seen, source, probe_date |
| 接口面 | `endpoints-{program}.tsv` | url, method, params, auth_required, source, collected_at |
| 尝试台账 | `attempts-{program}.tsv` | ts, asset, card_id, card_ver, tool, result, evidence_path, run_id |
| 覆盖视图 | `coverage-{program}-{date}.md` | 按卡片聚合的六态计数表（由 attempts 聚合生成，禁手填） |
| 卡片使用记录 | `card_usage-{date}.jsonl` | card_id, asset, result, card_version, deviation, suggest |
| 开局包 | `brief-{program}-{date}.md` | 昨日状态 / 今日硬指标 / 禁止项（§七含探索引导） |
| 交接包 | `handoff-{program}-{date}.md` | 状态快照 / 动作摘要 / 明日队列 / 阻塞求助 / 数据指针 |

交接包五段中"阻塞与求助"按**解锁收益排序**（例："补 1 个美团商家账号可解锁 14 条 BLOCKED"），把对人的请求变成精确的最小请求。

---

## 四、覆盖矩阵：开放状态机

### 4.1 状态定义（初始集合，可扩展）

每个 `资产 × 卡片` 组合处于且仅处于一个状态：

| 状态 | 含义 | 必填附加字段 |
|---|---|---|
| `PENDING` | 未测试 | — |
| `TESTED_CLEAN` | 按卡片规程完整执行，无命中 | evidence_path（§3.2-2） |
| `CONFIRMED` | 过 verify 规程确认 | finding_id + 证据包 |
| `FALSE_POSITIVE` | 曾命中但证伪 | falsification 记录 |
| `NOT_APPLICABLE` | 无对应攻击面 | `na_reason`（词表开放，§4.2） |
| `BLOCKED` | 条件不满足暂不可测 | `blocker`（缺什么，词表开放） |
| `STALE` | 结论过期需重测 | `stale_reason`（资产变化/卡片升版/超期） |
| *（可注册新状态）* | 新状态首次使用须在当日报告说明语义，评审后入词表 | — |

### 4.2 理由词表（开放注册，初始值如下）

`na_reason` 初始集：`no-param-surface`（无参数/表单）、`no-auth-feature`（无会话体系）、`no-upload-feature`、`no-graphql`、`static-site`、`cdn-edge-only`、`scope-excluded`、`tech-mismatch`。

`blocker` 初始集：`no-credential`（缺账号）、`no-registration-channel`（无注册入口）、`egress-unreachable`（出口不可达）、`risk-exceeded`（超 max_risk 需人工）、`tool-missing`、`rate-limited`。

**扩展规则**：遇到词表外的情况，允许当场造新值，但①新值必须是"可复用的类别"而非一次性描述；②当日报告的变更说明区必须登记新值及定义；③每周评审合并近义值。**禁止用 `other`/`misc` 兜底。**

### 4.3 物理形态

- 事实层：`attempts-{program}.tsv`（append-only，稀疏台账）
- 视图层：`coverage-{program}-{date}.md` 由台账**脚本聚合生成**（防手填幻觉）：

```
## 覆盖矩阵摘要（2026-08-27）
| 卡片 | CLEAN | CONFIRMED | FP | N/A | BLOCKED | PENDING | STALE |
|---|---|---|---|---|---|---|---|
| VC-001 CORS 误配        | 112 | 2 | 1 | 8  | 0  | 5 | 0 |
| VC-008 越权 IDOR        | 0   | 0 | 0 | 60 | 14 | 3 | 0 |
| ...（行动态增长，随卡片注册扩展） |
```

### 4.4 重测触发（STALE 规则）

- 资产 title/指纹/状态码特征变化 → 该资产全部 CLEAN 转 STALE
- 卡片版本升级 → 引用旧版的记录转 STALE（方法改进自动触发回归）
- 超过卡片 `retest_after_days` → STALE
- 新情报涉及该技术栈 → 相关资产相关卡片转 STALE

### 4.5 每日 vuln 开局动作

读 PENDING/STALE 清单 + 评审 BLOCKED 的解锁条件是否已满足——**而不是重新盘点全部资产**。BLOCKED 汇总视图直接回答"补什么条件能解锁多少测试面"。

---

## 五、知识单元体系：四类卡片与注册表

### 5.1 为什么分四类

实践中有四种不同性质的"可进化知识"，混在一张卡里会互相污染：

| 卡类 | 管什么 | 示例（从现有沉淀初始化） |
|---|---|---|
| **VulnCard** 漏洞卡 | 单漏洞的探测/验证规程 | CORS 误配、SQLi、越权 IDOR… |
| **MethodCard** 方法卡 | 工具用法、管线、工程技巧 | xargs -P8 批探、xray flows 消费管线、JS bundle 测绘法 |
| **PatternCard** 判定卡 | 判定依据/基线特征/证伪规则 | 403+9B=出口 ACL、456=反爬非漏洞、catch-all 基线差分、Supabase 五端点确认法 |
| **IdeaCard** 想法卡 | 未验证的思路种子（§七） | "CORS+缓存投毒组合""SSO continue 参数开放跳转链" |

### 5.2 通用骨架（所有卡共享，保证可学习可统计）

```yaml
id: VC-001                # {类型前缀}-{序号}，注册表分配，不回收
type: vuln                # vuln / method / pattern / idea（类型也可注册新增）
name: CORS 任意起源反射
version: 3
status: active            # draft / active / deprecated
created: 2026-08-22
# --- 进化统计（机器维护） ---
usage_count: 9            # 每次使用 +1
hit_count: 2              # 产出 CONFIRMED/被成功复用 +1
fp_count: 1               # 引发误报 +1
last_used: 2026-08-27
changelog:                # 每次修订必须 bump version + 写条目
  - v3 2026-08-26: 增加"404 路径对照"证伪步骤（字节边缘网关误报教训）
```

### 5.3 各类型特有字段

**VulnCard**（在通用骨架上扩展）：

```yaml
cwe: CWE-942
severity_potential: [low, medium]     # 在本类目标的现实定级区间
risk_level: passive                   # 与 scope-guard 对齐
applicable_when: [...]                # 决定矩阵 PENDING vs NOT_APPLICABLE
not_applicable_when: [...]            # 引用 na_reason 词表
prerequisites: {egress: 任意, auth: none, tools: [curl]}   # 不满足 → BLOCKED
detect:                               # 探测规程：步骤+工具+FP 基线
  steps: [...]
  fp_baseline: ...
verify:                               # 确认规程
  must_pass: [...]                    # 全过才算 CONFIRMED
  falsification: [...]                # 证伪检查清单
retest_after_days: 30
src_notes: |                          # SRC 提交要点（定级习惯、政策变化）
  ...
```

**MethodCard**：`inputs / outputs / steps / pitfalls / cost_notes`（成本与超时经验）。

**PatternCard**：`pattern`（特征描述）/ `means`（该特征意味着什么）/ `counter_examples`（反例——什么时候这个判断是错的）/ `applies_to`。

**IdeaCard**：见 §7.3。

### 5.4 初始卡片清单（种子，不设上限）

VulnCard 种子（VC-001~018）：CORS 误配、子域接管、敏感路径暴露、XSS、SQLi、CRLF、未授权访问、越权 IDOR、SSRF、GraphQL 滥用、JWT 缺陷、OAuth/SSO 逻辑、文件上传、信息泄露、登录接口安全、N-day 组件、业务逻辑、中间件暴露面。

**数量不被限制死**：任何会话发现词表外的漏洞类/方法/判定模式，按 §5.5 注册新卡。清单是活的，表格行动态增长。

### 5.5 卡片生命周期与注册流程

```
draft（首次提出，可在任务中即创即用）
  → 满足晋升条件 → active（进每日任务契约的可分派集）
  → 失效/被更好卡片替代 → deprecated（保留历史，引用它的矩阵记录转 STALE）
```

晋升条件（满足其一）：① draft 状态被使用 ≥3 次且规程稳定；② 人工评审通过。废止条件：`usage_count ≥ 20 且 hit_count = 0` 时强制评审——是目标面问题还是方法失效（如 WAF 升级），结论写进 changelog。

### 5.6 开放扩展规则（公理 P4 的落地）

- **schema 只锁结构不锁取值**：校验器检查"必填字段存在、类型正确"，不检查"id 是否在固定清单里"
- **注册即生效**：新卡/新状态/新理由值当场可用，登记义务在当日报告变更说明区
- **核心列 + 自由列**：tsv 产物核心列固定（§3.4），之后允许任意追加列；追加列被 3 个以上任务使用后可提议升格为核心列（升版 schema）
- **禁止的全局规则只有两条**：不许用 other/misc 兜底；不许修改历史 append-only 行（纠错用新行冲正）

---

## 六、反馈与学习回路

### 6.1 使用反馈环（每次任务强制）

每次使用任何卡片，落一条 `card_usage-{date}.jsonl`：

```json
{"card_id":"VC-001","card_version":3,"asset":"e.waimai.meituan.com",
 "result":"CONFIRMED","deviation":"该站对 origin 后缀绕过也反射，卡片未覆盖",
 "suggest":"detect.steps 增加 evil{domain} 后缀变体","run_id":"wmt9xxx"}
```

`deviation`（实战与卡片的偏差）和 `suggest`（修改建议）是反哺的核心字段；无偏差可省略，有偏差**必须**记录——偏差就是卡片进化的原料。

### 6.2 卡片修订触发器（满足任一即应升版）

1. 实战出现卡片未覆盖的绕过/变体 → 补 detect 步骤
2. 出现误报且 falsification 未拦截 → 补证伪条款（同时考虑沉淀为 PatternCard）
3. `fp_count` 上升 → 评审判定逻辑是否过宽
4. 达到废止评审线（usage≥20 & hit=0）→ 修订、降优或废止
5. intel/kb 出现新技术（新绕过、新工具）→ 相关卡升级
6. SRC 平台收录政策/定级习惯变化 → 更新 src_notes
7. 另一个项目的经验可迁移（回路 C 的跨项目碰撞）→ 合并条款

### 6.3 知识流动全景

```
实战中 ─┬─ 新漏洞类型/新打法 ────→ 注册新 VulnCard(draft)
        ├─ 工程技巧/工具心得 ────→ MethodCard
        ├─ 判定依据/误报特征 ────→ PatternCard（含 counter_examples）
        ├─ 用不了的灵感 ────────→ IdeaCard（留种）
        └─ 与既有卡的偏差 ──────→ card_usage.deviation → 升版

情报侧 ─┬─ web_search/intel 新 CVE ─→ IdeaCard 或 VulnCard(N-day) 条款
        └─ kb 224 篇 ─→ 开局 kb_search 强制检索 ─→ 命中知识挂到相关卡 changelog

复盘侧 ─┬─ 每周评审：词表合并、draft 晋升、deprecated 清理、统计报告
        └─ STALE 风暴检查：卡片升版是否造成不合理的大规模重测
```

### 6.4 与现有体系的关系

- playbooks（流程级方法论）= 跨卡的编排经验，保留；四类卡 = 原子知识单元
- exp 经验卡 = 软性经验；卡片 = 硬性规程。每日 vuln 任务契约直接引用当日的卡片 ID 清单
- kb 不再闲置：开局 `kb_search(当日目标指纹)` 是硬指标，命中内容以 changelog 形式挂到相关卡片，知识完成从"库存"到"规程"的转化

---

## 七、自由探索机制：规定动作 + 自选动作

### 7.1 任务结构：保底与自由的比例

每个 vuln 任务 = **规定动作（必须 100% 完成）+ 自选动作（必须产出，方向自由）**：

| 部分 | 内容 | 硬指标 |
|---|---|---|
| 规定动作 | 覆盖矩阵 PENDING/STALE 消化、复验到期项、huntlist 条件判定、台账留痕 | 开局 brief 明确列出 |
| 自选动作 | 自由探索（见 7.2 引导） | **≥ 任务窗口 20% 的时间 或 ≥3 条 IdeaCard**，二者取其易 |

**两条边界**：①自选动作不许挤占规定动作（规定动作未完成 = 任务失败）；②自选动作的产出**只能进 IdeaCard/huntlist，不许直接进 findings**——灵感和漏洞之间隔着验证规程（P2 裁决）。

### 7.2 头脑风暴引导（写进每日 brief 的发散框架）

模型自由发挥时，给角度不给结论。六个发散方向，每次任务至少扫一遍：

1. **组合**：两个已确认事实能不能组合成新攻击链？（CORS 反射 × 缓存投毒；SSO continue 参数 × 开放跳转；JS 泄露内网域 × 云元数据）
2. **类比**：本项目的面，别的 SRC/公开案例怎么打过？（kb 检索"同类厂商+同类业务"的公开 writeup）
3. **倒置**：防守方假设是什么？假设反过来会怎样？（"网关一定鉴权"→ 摘除头/改方法/换路径试试；"测试环境不出网"→ DNS 带外试试）
4. **协议下沉**：HTTP 层下面还有什么？（WebSocket 鉴权、T3/AJP/MQ 等中间件协议、HTTP/2 走私、Host 头多面性）
5. **数据追问**：这个响应里的每个字段从哪来、能被谁影响？（Server-Timing 泄露 region/instance → 能否用于侧信道或定位内网面）
6. **时间维度**：面随时间怎么变？（新发版窗口、证书新签发子域、git 提交时间规律、大促/活动临时面）

### 7.3 IdeaCard：想法的留种与孵化

当下验证不了的想法**必须入库**（不许丢弃）， schema 在通用骨架上扩展：

```yaml
id: IC-007
type: idea
name: waimai CORS 反射 × 登录态缓存投毒组合链
status: seed              # seed / incubating / testable / validated / promoted / rejected
seed_from: 2026-08-27 头脑风暴（方向1：组合）
hypothesis: |
  e.waimai 反射+ACAC 已确认；若其某接口响应被共享缓存键覆盖，
  可形成"反射凭证读取 + 缓存放大"链，定级从 low 升至 high
verification_requires:    # 留种的核心：写清楚缺什么
  - 登录态账号（blocker: no-credential）
  - 缓存键测绘方法（需查 kb 或新研）
first_testable_when: 凭据到位当日
related: [VC-001, VC-0xx-缓存投毒(待建)]
```

孵化流转：
- `seed → incubating`：后续会话补充了方法/先例/变体
- `incubating → testable`：验证条件全部满足（凭据到位/工具就绪/目标面出现）——**每日开局检查 IdeaCard 的 first_testable_when，条件满足的自动升格并进当日 huntlist**
- `testable → validated`：实测验证成功 → **转正**（promoted）：想法固化为新 VulnCard 或并入既有卡 changelog
- `→ rejected`：证伪，写清证伪依据（rejected 也是知识，防后人重复）

### 7.4 思路碰撞的制度化

- **跨项目碰撞**：美团确认的手法/判定模式，每周评审时对字节资产做一次适用性扫描（反之亦然）
- **跨时间碰撞**：每月用当前卡片库对"历史 TESTED_CLEAN 资产"做一次抽样重估——卡片进化后，过去的"干净"可能不再干净（STALE 机制已自动化，此处做抽查兜底）
- **外部碰撞**：web_search 不仅查 CVE，定期查"目标厂商 + 公开漏洞报告/writeup"，把外部打法转成 IdeaCard

---

## 八、登录态测试方法论与账号获取策略

### 8.1 按"登录后增益"分级，不为所有资产搞账号

| 分级 | 特征 | 实测示例 | 策略 |
|---|---|---|---|
| A（必投） | 登录后暴露全新功能面：管理后台/商家端/运营端/API 控制台 | admin.erp、cloud-erp、livehub、keeservice 工作台、lbs 控制台、carrier proxy 网关 | 集中资源搞账号 |
| B（选投） | 登录后多个人数据/订单/消息面，IDOR 价值高 | waimai 订单、火山开发者中心 user 系列 | 有现成账号就挂 |
| C（不投） | 登录/未登录几乎同面 | 官网、营销页、文档站 | na_reason=no-auth-feature，维持匿名测试 |

### 8.2 账号获取路径（开放清单，初始七条）

| # | 路径 | 说明 |
|---|---|---|
| 1 | 自行注册穷尽 | 每个 A 级资产必答"注册入口在哪"；把**注册入口侦察列为 recon 常规任务**，产出可行性清单交人工执行。美团（C 端/开放平台/商家版/Keeta 海外邮箱注册）、字节（抖音/巨量试用/火山引擎个人试用/coze/Trae） |
| 2 | SSO 乘数 | 美团 unitivelogin、字节通行证一号通多系统，**优先打通主账号** |
| 3 | 开放平台/沙箱 | 开发者 API Key、沙箱、免费试用额度 → 合法 token 直测 API 面 |
| 4 | **无账号登录面测试** | 登录接口本身是攻击面：账号枚举/短信轰炸/验证码绕过/密码重置逻辑/OAuth 配置/爆破保护——不需要账号，独立成卡（VC-015） |
| 5 | 厂商自暴露凭据 | demo 账号、JS 中测试凭据、GitHub/网盘泄露——**仅用厂商自暴露的；泄露本身即可作为信息泄露提交。红线：绝不用拖库凭据、绝不登真实用户账号** |
| 6 | 邀请制申请 | 企业试用/内测/问卷，清单交人工批量申请 |
| 7 | 放弃并标注 | 确无通道 → `BLOCKED(no-registration-channel)` + 转路径 4 + 定期复评，**不许无限占 huntlist** |

新路径随时注册进本清单（P4）。

### 8.3 账号资产管理

- 凭据入 credentials 表：`program / system / account_type(self-registered|demo|leaked-public) / scope_binding`
- **双账号原则**：水平越权必须同系统双账号成对注册
- 测试数据隔离：只用自建测试数据做 IDOR/逻辑测试，不碰真实用户数据（SRC 红线，写进相关卡 prerequisites）
- 会话维持：shared-browser profile 持久化 + xray 7777 挂浏览器代理 → 一次打通"认证爬虫→被动扫描→authz_diff 差分"；cookie 失效告警转人工

### 8.4 登录后挖掘方法

功能全覆盖爬虫（katana 带会话过 xray）→ authz_diff 双账号差分 → 对象 ID 遍历（JS 泄露真实 ID 做种子）→ 业务逻辑（价格/数量/重放/竞态）→ GraphQL/批量接口 → 角色权限矩阵。各自对应 VulnCard，按卡执行。

---

## 九、资产收集方法清单（开放）

按投入产出排序的**初始**清单（新方法随时注册）：

| 优先级 | 方法 | 工具/源 | 状态 |
|---|---|---|---|
| P0 | URL/端点历史挖掘 | waybackurls、gau、katana、ParamSpider | 最大缺口，从未系统做 |
| P0 | JS 端点自动化提取 | subjs + LinkFinder/SecretFinder、katana -jc | 手工验证过效果，须工具化 |
| P1 | 被动 DNS 多源 | SecurityTrails、VT、OTX、urlscan、RapidDNS、uncover | 解决 certspotter 单源枯竭 |
| P1 | 空间测绘 API | fofa/hunter/quake/censys（fofa.conf 已存在） | 同证书/favicon 反查 |
| P1 | 子域爆破+排列 | puredns/dnsx + alterx | 被动源枯竭后的增量主力 |
| P1 | 子域接管 | nuclei takeover / subzy | 0 成本高收益，从未做 |
| P2 | ASN/IP+端口面 | asnmap/mapcidr → naabu → httpx | T3/ActiveMQ 先例证明价值 |
| P2 | 移动端/小程序 | jadx、小程序解包 | 美团/字节业务大头在 App |
| P2 | 代码泄露面 | GitHub/GitLab 监控、网盘文库 | — |
| P3 | 云桶枚举 | S3/OSS/TOS/COS | 配合 JS 提取桶名 |

**"子域 diff=0 多日"警惕伪收敛**：源单一时 diff=0 只说明"这个源没新货"，不说明"面收敛"。多源并行后才允许下收敛结论。

---

## 十、落地路线图

| 期 | 动作 | 对应公理 | 预期收益 |
|---|---|---|---|
| 第一周 | ① §3.4 标准产物 + schema 校验进任务契约；② attempts/handoff/brief 三件套；③ nuclei info 噪音隔离；④ 存量 findings 回填 vuln_type | P2 | 留痕/接力/防幻觉立即生效，成本≈0 |
| 第二周 | ⑤ 四类卡注册表 + 种子卡（VC-001~018 等）从既有方法论初始化；⑥ 覆盖矩阵聚合脚本；⑦ L2 接口层管线（katana+waybackurls+gau+JS 提取） | P1/P3/P4 | 域名级→接口级，覆盖可见 |
| 第三周 | ⑧ xray flows 消费管线；⑨ 探索配额与 IdeaCard 进任务契约；⑩ huntlist 生命周期（precondition/ttl）；⑪ 资产多源扩容 | P5/P1 | 工具矩阵转动，想法开始留种 |
| 第四周 | ⑫ 每周评审会机制（词表合并/draft 晋升/STALE 风暴检查）；⑬ 卡片反馈环数据首轮复盘 | P3 | 进化回路闭环 |
| 持续（需人配合） | ⑭ 凭据策略：按 §8.2 路径 1/2/3 成对注册账号 → 浏览器挂 xray → authz_diff | — | 唯一能把产出带回 high/medium 的动作 |

### 关键原则回顾

1. **没有漏 = 台账可证**，不是"扫过"（P1）
2. **无证据不结论，没证据的"干净"与"有洞"同罪**（P2）
3. **每次使用都是一次评审，每次偏差都是一次升版机会**（P3）
4. **格式锁死、内容放飞；表格会长大，schema 不长**（P4）
5. **规定动作保底、自选动作留种；今天用不了的想法是明天的漏洞**（P5）

---

*v2.0 变更说明：按五条公理全面重构 v1.0——新增设计原则层、可靠性设计、防幻觉八条标准、卡片体系从单类扩为四类注册表、新增自由探索机制与 IdeaCard 孵化流、所有枚举改为开放注册。v1.0 的覆盖矩阵、账号策略、资产清单等内容保留并融入新结构。*
