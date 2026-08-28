# SilkSecAgent SRC 漏洞挖掘体系设计规范

> 版本：v2.1 · 2026-08-27（v2.0 基础上整合 A/B/C/D/E 五组扩展）
> 性质：Living Document，随时修订。基于对 csai 主机 SilkSecAgent（DSH sec-suite）的只读检查与 08-20 ~ 08-27 实际运行数据。
> 适用范围：meituan-src / bytedance 双项目每日 recon+vuln 自动挖掘链路。

---

## 目录

0. [设计原则（五条公理）](#零设计原则五条公理)
1. [总体架构：四层管线 + 变化雷达 + 三条反馈回路](#一总体架构)
2. [可靠性设计：容错、幂等、健康矩阵与覆盖闭环](#二可靠性设计)
3. [输出契约与防幻觉标准](#三输出契约与防幻觉标准)
4. [覆盖矩阵：开放状态机 + 优先级队列](#四覆盖矩阵)
5. [知识单元体系：四类卡片与注册表](#五知识单元体系)
6. [反馈与学习回路](#六反馈与学习回路)
7. [自由探索机制：规定动作 + 自选动作](#七自由探索机制)
8. [登录态测试方法论与账号获取策略](#八登录态测试方法论与账号获取策略)
9. [资产收集与情报源（开放清单）](#九资产收集与情报源开放清单)
10. [SRC 平台运营](#十src-平台运营)
11. [合规与止损红线](#十一合规与止损红线)
12. [落地路线图](#十二落地路线图)

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

> 公理冲突时裁决顺序：P2（真实性）> P1（可靠覆盖）> P3（可进化）> P5（自由探索）> P4（开放扩展）。
> 推论：P2 要求"LLM 不能给自己当法官"——凡能机械校验的，不允许只靠模型自证（§3.2 标准 9）。

---

## 一、总体架构

### 1.1 正向管线（漏洞发现的完整路径）

```
L1 资产层     域名/IP/端口/存活/形态 ──→ assets.tsv（资产台账）
     ↓ 存活站点
L2 接口层     爬虫+历史URL+JS提取 ──→ endpoints.tsv（接口参数面）
     ↓ 按指纹/形态分派
L3 工具矩阵层  漏洞卡驱动的专项探测 ──→ attempts.tsv（尝试台账）
     ↓ 命中
L4 确认层     验证规程+机械复核+证据包 ──→ findings + evidence/{id}/
```

**关键认知：漏洞不在域名上，在接口和参数上。** 当前系统从 L1 直接跳到用 nuclei 扫域名，缺失 L2（接口层）是最大结构性缺口。L2 是激活 dalfox/sqlmap/arjun 等闲置工具的前提。

### 1.2 基础设施层（L3/L4 依赖的常驻能力）

| 设施 | 用途 | 状态 |
|---|---|---|
| mubeng 代理池 8899 | 统一出口 | 已有 |
| xray 被动 7777 + webhook | 流量采集 | 已有（消费见 §6.5） |
| **OOB 带外通道（interactsh server 自建）** | 盲 SSRF/盲 XXE/盲 RCE/DNS 外带/异步回调的接收端 | **缺失，最高优先补齐**。没有它，盲类漏洞物理上不可测——不是没测，是测了也收不到信号 |
| shared-browser + playwright | 登录态维持、截图证据 | 已有 |
| 证据存储 `evidence/` | 可提交性留痕 | 待建 |
| CT 流监控（certstream） | 见 §1.3 | 待建 |

OOB 纪律：payload 中的回连标识必须编码 `run_id`（如 `{run_id}.oob.example.com`），带外命中自动回填 attempts，防止"收到信号不知道是谁打的"。

### 1.3 变化雷达（变化驱动测试）

漏洞的高发窗口是**变化时刻**，不是存量。变化雷达把"diff"从资产台账升级为测试驱动源：

| 变化源 | 监控方式 | 触发动作 |
|---|---|---|
| 新子域上线 | certstream 实时流命中 scope 域 | **插优先队列立即测**——新资产防护基线未收敛、默认页/调试接口窗口期，抢的是上线后 24h |
| 前端发版 | 重要资产 JS bundle 每日 hash + diff | 新增端点/新密钥/新逻辑优先测（"新洞雷达"） |
| 版本/构建号漂移 | banner、Server-Timing、build 号监控 | 相关卡片转 STALE 重测 |
| 配置/行为变化 | title/状态码/指纹特征变化 | §4.5 STALE 规则 |
| SRC 范围变更 | §10.1 平台情报 | 新纳入资产抢首发 |

原则：**变化优先于存量**。当日窗口先给变化雷达的产出，再给静态覆盖队列（§4.4 优先级评分中"变化"是最高权重因子）。

### 1.4 三条反馈回路

```
回路A（日内）：L3 命中 → L4 验证 → 证伪 → PatternCard 证伪条款 + 负账本
回路B（日间）：attempts/卡片使用记录 → 触发器评审 → 卡片升版 → STALE 重测
回路C（长期）：intel/kb/头脑风暴/外部情报 → IdeaCard 留种 → 条件成熟 → 转正
```

### 1.5 与现状的映射

| 任务 | 原内容 | 新内容 |
|---|---|---|
| recon | 子域 diff + 探活 | L1 全量 + 变化雷达产出 + 新增资产 L2 接口层收集 + 注册入口侦察（§8.2） |
| vuln | "未跑过资产跑 nuclei" | 读覆盖矩阵优先级队列 → 按卡片执行 → 探索配额（§七）→ 全部留痕 |

---

## 二、可靠性设计

### 2.1 执行可靠性（失败是可恢复的常态）

| 机制 | 规范 |
|---|---|
| 批次检查点 | 每批 ≤3 目标/≤600s（沿用已验证纪律）；每完成一个目标立即落盘 attempts 行，**不允许攒批写** |
| 幂等 run_id | 每个执行单元唯一 run_id；重跑先查 attempts，已有终态（非 STALE）直接跳过 |
| 工具降级链 | 每类动作注册 ≥2 个实现（子域：subfinder→uncover→fofa API；探活：httpx→curl）；降级时台账记 `tool_fallback` |
| 出口容错 | 000/超时 ≥4 次复探且换出口；代理池健康度开局检查，live_pool 低于阈值当日降级只读模式并告警 |
| 失败留痕 | 失败 run 必须落 meta（exit_code/duration/stderr 摘要），禁止"仅 1 行日志"的失败 |
| 任务熔断 | 单任务失败率 >50% 或连续 3 目标同错 → 停止本批转人工/次日 |

### 2.2 出口×目标健康矩阵

代理 IP 被目标风控标记后，该出口看到的一切都是 403/456——测试结果**系统性失真**，且会污染负账本。规范：

- 维护 `egress-health.tsv`：`egress_ip × 目标域 × 时间 × 响应特征`
- 同一目标的结论性测试（尤其 TESTED_CLEAN/封闭判定）至少 2 个出口交叉验证
- 某出口对某域连续异常 → 该组合冷却 24h；出口全局异常 → 代理池刷新并告警
- 涉及"移除/死亡/封闭"的负向结论，必须通过健康矩阵检查后才允许入账

### 2.3 负账本洗白机制

负账本防重复，但会误伤：WAF 临时拦截被记为"封闭"，之后永不重测——**WAF 一松，漏洞就躺在负账本盲区里**。规范：

- 负账本条目带有效期（默认 30 天），到期自动回队复验
- 每日随机抽查 5% 负账本条目复验（换出口、换时段）
- 条目入负账本时必须带证据（与 TESTED_CLEAN 同标准），无证据条目不生效

### 2.4 蜜罐前置检查

大厂资产中埋有蜜罐/哨兵页面，误碰触发防守溯源（暴露代理池和方法论）。规范：

- 建 PatternCard「蜜罐特征」（异常完美的后台页、 Canarytoken 链接、非常规 banner 组合）
- 主动探测前对目标做蜜罐特征比对；命中 → 降级为纯被动观察并标记
- 保护的是整个体系的**长期生存能力**，优先级等同合规

### 2.5 覆盖闭环（"不漏掉且可知"）

```
资产闭环：  每个 domain ∈ assets.tsv 必有 status
接口闭环：  每个 alive web 资产必有 L2 状态（collected/failed/no-surface）
漏洞闭环：  每个 (资产 × 适用卡片) 组合必有矩阵终态（§四）
复验闭环：  每条 CONFIRMED 有 next_verify 日期，到期自动回队
情报闭环：  每条 N-day/新打法情报必有结论（验证/证伪/无对应部署），不许悬空
想法闭环：  每条 IdeaCard 有终态（promoted/rejected），不许无限 seed（§7.3）
```

**"没有漏"的定义不是"扫过"，而是"台账可证"**：随时可查"资产 X 对漏洞 Y 测没测、何时测、什么结论、证据在哪"。

### 2.6 收尾强制清单

1. 本批所有目标在 attempts.tsv 有终态行（无终态 = 任务未完成）
2. 所有 CONFIRMED 过机械复核（§3.2-9）且有证据包
3. 所有 NOT_APPLICABLE / BLOCKED 有理由值
4. 当日新增 idea 已入库
5. handoff 数字与台账一致性校验通过
6. 变化雷达队列无积压未处置项

---

## 三、输出契约与防幻觉标准

### 3.1 结论分级与证据绑定

| 级别 | 措辞 | 证据要求 |
|---|---|---|
| **结论（fact）** | "存在/不存在/不适用/阻塞" | 必须挂 evidence 指针 |
| **观察（observation）** | "记录到 X 现象" | 必须有原始记录指针，允许未定性 |
| **推测（hypothesis）** | "可能/疑似/或许" | **禁止进结论字段**，只能进 IdeaCard/huntlist 且标注验证所需条件 |

### 3.2 防幻觉十条硬标准

1. **分母明确**：任何覆盖率数字给出分母来源（文件+行数+hash）。没有分母的百分比一律视为幻觉。
2. **TESTED_CLEAN 也要证据**："没发现"与"有漏洞"同级举证（命令/时间/响应特征摘要落盘）。防"没测写成测了没有"。
3. **detect/verify 分离**：命中与确认是两个独立动作；CONFIRMED 必须过 verify 规程 + ≥2 次复现（间隔换出口）。
4. **数字可溯源**：报告中每个统计数字必须有生成方式；禁止"约/大概"进正式报告。
5. **格式机器校验**：标准产物有 schema，收尾自检不通过 = 任务失败。
6. **禁止词清单**：结论区禁止"可能存在/疑似/应该是/理论上/大概率"。
7. **负例即价值**：NOT_APPLICABLE / FALSE_POSITIVE / BLOCKED 与 CONFIRMED 同等正式记录；**0 产出日的报告同样重要**（证明覆盖），防模型为凑产出报噪音。
8. **一致性校验**：handoff/日报汇总数与台账实际行数一致（脚本校验），不一致即异常。
9. **机械复核层（LLM 不能给自己当法官）**：凡能机械校验的一律不靠模型自证——CONFIRMED 证据包含 response hash，由固定脚本重放比对才能标 `src_ready`；报告统计数字由聚合脚本注入，模型只能引用变量不许手写；覆盖视图由台账脚本生成（§4.3）。
10. **对抗性复核**：CONFIRMED 且拟提交的 finding，由独立会话（不同上下文，扮演"证伪者"）尝试推翻：基线巧合？网关统一行为？权限理解错误？影响夸大？复核记录入 `verify-log.md`。机械复核管"事实真不真"，对抗复核管"逻辑对不对"。

### 3.3 Finding 证据包（可提交性标准）

每条 CONFIRMED 强制目录化 `evidence/{finding_id}/`：

| 文件 | 内容 | 防的什么 |
|---|---|---|
| `request.txt` / `response.txt` | 原始报文 + 时间戳 + 出口 IP + response hash | "我测过"的口头声明 |
| `reproduce.md` | 编号复现步骤 + **影响场景具体化**（攻击者能读/改多少用户的什么字段——SRC 定级看影响） | 不可复现、影响夸大 |
| `verify-log.md` | 复验记录（时间/出口/结果/响应哈希）+ 对抗复核结论 | 一次性巧合 |
| `screenshot.png` | 浏览器截图（有界面时强制） | 纯文本脑补 |
| `falsification.md` | 证伪检查逐项打勾（按卡片 falsification 条款） | 基线/网关误判 |
| `dedup.md` | 提交前平台历史查重记录（§10.3） | 重复提交扣信誉 |

finding 必填字段：`vuln_type`(CWE)、`severity`、`affected_url`、`param`、`poc_summary`、`src_ready`(bool)、`card_id@version`。存量缺类型字段的回填至少到类型级。

### 3.4 标准产物清单与格式契约

**格式刚性：核心字段不可缺、列序固定、机器可校验。内容开放：核心列之后允许追加自由列（§5.6）。**

| 产物 | 路径模式 | 核心字段（最左起固定） |
|---|---|---|
| 资产台账 | `assets-{program}.tsv` | domain, status, first_seen, last_seen, source, probe_date |
| 接口面 | `endpoints-{program}.tsv` | url, method, params, auth_required, source, collected_at |
| 尝试台账 | `attempts-{program}.tsv` | ts, asset, card_id, card_ver, tool, result, evidence_path, run_id |
| 出口健康 | `egress-health.tsv` | egress, target_domain, ts, signature, verdict |
| 覆盖视图 | `coverage-{program}-{date}.md` | 按卡片聚合的状态计数表（脚本生成，禁手填） |
| 卡片使用记录 | `card_usage-{date}.jsonl` | card_id, asset, result, card_version, deviation, suggest |
| 开局包 | `brief-{program}-{date}.md` | 昨日状态 / 今日硬指标 / 探索引导 / 禁止项 |
| 交接包 | `handoff-{program}-{date}.md` | 状态快照 / 动作摘要 / 明日队列 / 阻塞求助 / 数据指针 |

交接包"阻塞与求助"按**解锁收益排序**（"补 1 个美团商家账号可解锁 14 条 BLOCKED"），把对人的请求变成精确的最小请求。

---

## 四、覆盖矩阵

### 4.1 状态定义（初始集合，可扩展）

| 状态 | 含义 | 必填附加字段 |
|---|---|---|
| `PENDING` | 未测试 | — |
| `TESTED_CLEAN` | 按卡片规程完整执行，无命中 | evidence_path |
| `CONFIRMED` | 过 verify + 机械复核确认 | finding_id + 证据包 |
| `FALSE_POSITIVE` | 曾命中但证伪 | falsification 记录 |
| `NOT_APPLICABLE` | 无对应攻击面 | `na_reason` |
| `BLOCKED` | 条件不满足暂不可测 | `blocker` |
| `STALE` | 结论过期需重测 | `stale_reason` |
| *（可注册新状态）* | 新状态首次使用须在当日报告说明语义，评审后入词表 | — |

### 4.2 理由词表（开放注册，初始值）

`na_reason`：`no-param-surface`、`no-auth-feature`、`no-upload-feature`、`no-graphql`、`static-site`、`cdn-edge-only`、`scope-excluded`、`tech-mismatch`。

`blocker`：`no-credential`、`no-registration-channel`、`egress-unreachable`、`risk-exceeded`、`tool-missing`、`rate-limited`、`needs-reverse`（需签名/参数逆向，见 §8.5）。

**扩展规则**：词表外允许当场造新值，但①必须是可复用类别而非一次性描述；②当日报告登记新值定义；③每周评审合并近义值。**禁止 other/misc 兜底。**

### 4.3 物理形态

- 事实层：`attempts-{program}.tsv`（append-only）
- 视图层：`coverage-{program}-{date}.md` 由台账**脚本聚合生成**

### 4.4 优先级队列（防组合爆炸）

矩阵单元格随卡片增长而膨胀，机械消化 PENDING 会让低价值目标挤占黄金窗口。每条待办带优先级分：

```
priority = 资产价值(A=3/B=2/C=1)
         × 卡片历史命中率权重(hit/usage 归一化，新卡默认中位)
         × 情报热度(新CVE/新打法 ×2)
         × 变化因子(变化雷达来源 ×3，最高权重)
```

每日 brief 按分取 Top N。BLOCKED 汇总视图回答"补什么条件解锁多少测试面"。**覆盖闭环是长期目标（P1），优先级队列是有限窗口下的调度器——两者不矛盾：闭环保证"最终都测到"，队列保证"先测最可能出洞的"。**

### 4.5 STALE 规则与风暴治理

触发：①资产特征变化；②卡片升版（引用旧版的记录转 STALE）；③超 `retest_after_days`；④新情报涉及该技术栈；⑤负账本条目到期（§2.3）。

**风暴治理**：卡片升版时强制影响评估——波及 >50 单元格则：抽样 20% 立即回归 + 其余按优先级排期，禁止一次性全量转 STALE 挤爆窗口。卡片"升版稳定性"纳入 active 评审（频繁升版的卡要反思是迭代还是规程没想清楚）。

### 4.6 每日 vuln 开局动作

读优先级队列 Top N + 变化雷达产出 + 评审 BLOCKED 解锁条件 + 负账本抽查配额——**而不是重新盘点全部资产**。

---

## 五、知识单元体系

### 5.1 四类卡片

| 卡类 | 管什么 | 示例 |
|---|---|---|
| **VulnCard** 漏洞卡 | 单漏洞的探测/验证规程 | CORS、SQLi、走私、越权… |
| **MethodCard** 方法卡 | 工具用法、管线、工程技巧 | xargs -P8 批探、xray flows 消费管线、JS bundle 测绘、JS diff 发版监控 |
| **PatternCard** 判定卡 | 判定依据/基线特征/证伪规则 | 403+9B=ACL、456=反爬、catch-all 差分、Supabase 五端点、蜜罐特征、厂商体质画像 |
| **IdeaCard** 想法卡 | 未验证的思路种子 | §7.3 |

### 5.2 通用骨架

```yaml
id: VC-001                # 注册表分配，不回收
type: vuln                # vuln / method / pattern / idea（类型可注册新增）
name: CORS 任意起源反射
version: 3
status: active            # draft / active / deprecated
created: 2026-08-22
usage_count: 9            # 机器维护
hit_count: 2
fp_count: 1
last_used: 2026-08-27
changelog:
  - v3 2026-08-26: 增加"404 路径对照"证伪步骤
```

### 5.3 各类型特有字段

**VulnCard**：`cwe / severity_potential / risk_level / applicable_when / not_applicable_when / prerequisites(egress,auth,tools) / detect(steps,fp_baseline) / verify(must_pass,falsification) / retest_after_days / src_notes`

**MethodCard**：`inputs / outputs / steps / pitfalls / cost_notes`

**PatternCard**：`pattern / means / counter_examples / applies_to`

**IdeaCard**：§7.3。

### 5.4 初始卡片清单（种子，不设上限）

**VulnCard 种子（按家族分组，序号随注册递增）：**

| 家族 | 卡片 |
|---|---|
| 配置/暴露面 | VC-001 CORS、VC-002 子域接管（含 NS 接管/云桶接管/接管后 cookie tossing 放大）、VC-003 敏感路径暴露、VC-014 信息泄露（JS 密钥/sourcemap 反解源码树/备份文件/云桶） |
| 注入家族 | VC-004 XSS、VC-005 SQLi、VC-006 CRLF、VC-013 文件上传、VC-0xx SSTI（错误页/邮件模板/报表导出）、VC-0xx XXE（office 文档/SVG 解析入口）、VC-0xx 反序列化（fastjson/shiro/.NET/pickle） |
| 鉴权/会话 | VC-007 未授权访问、VC-008 越权 IDOR（水平/垂直/多租户/跨业务线 SSO 边界）、VC-011 JWT、VC-012 OAuth/SSO 逻辑、VC-015 登录接口安全（枚举/轰炸/验证码/密码重置逻辑）、VC-0xx 会话管理（fixation/登出不失效/改密后会话不失效/并发控制） |
| 中间层攻击 | VC-0xx **HTTP 请求走私 Desync**（多层网关链 CL.TE/TE.TE/H2，可绕过网关鉴权直达内网接口）、VC-0xx **网关路由绕过/URL 解析差异**（`..;/`、`%2e`、双斜杠、尾缀绕过、`;jsessionid`——打已测绘的 401 网关正面对口）、VC-0xx **Web 缓存投毒/欺骗**（未键入头/路径混淆）、VC-0xx **Host 头攻击/密码重置投毒**（重置链接用 Host 构造，经典高危） |
| 协议/新面 | VC-0xx **WebSocket 安全**（鉴权缺失/CSWSH——与 CORS 反射是组合拳/消息注入/越权订阅）、VC-0xx GraphQL、VC-0xx gRPC-Web 反射枚举 |
| 云原生 | VC-0xx **配置中心未授权**（Nacos/Apollo/Consul/Eureka——拿到全部配置=critical）、VC-0xx 中间件暴露（T3/AJP/MQ/Redis/ES）、VC-0xx **日志/监控面未授权**（Kibana/Graylog/Zabbix——日志=信息金矿） |
| 业务逻辑 | VC-016 N-day 组件、VC-017 业务逻辑（价格/数量/库存超卖/优惠券滥用）、VC-0xx **签名与重放缺陷**（签名只验存在性不验正确性/无时间戳 nonce/支付回调伪造）、VC-0xx **数据脱敏检查**（接口返回/导出未脱敏——配 xray flows 正则回扫，稳定产出） |
| 新赛道 | VC-0xx **AI 应用攻击面**（prompt injection 致工具调用越权/LLM SSRF/agent 越权/对话记录 IDOR——coze/ark 在 scope，竞争极少） |

**数量不被限制死**：遇到词表外类型按 §5.5 注册。表格行随注册动态增长。

### 5.5 卡片生命周期

```
draft（即创即用）→ [使用≥3次规程稳定 或 人工评审] → active → [废止评审] → deprecated
```

废止评审线：`usage ≥ 20 且 hit = 0` 强制评审（目标面问题 or 方法失效），结论写 changelog。deprecated 保留历史，引用记录转 STALE。

### 5.6 开放扩展规则（公理 P4 落地）

- schema 只锁结构不锁取值；新卡/新状态/新理由值当场可用，登记义务在当日报告
- tsv 核心列固定 + 自由列开放；自由列被 ≥3 个任务使用可提议升格核心列
- 全局禁令仅两条：不许 other/misc 兜底；不许修改历史 append-only 行（纠错用新行冲正）

---

## 六、反馈与学习回路

### 6.1 使用反馈环（每次任务强制）

每次用卡落 `card_usage-{date}.jsonl`：`{card_id, card_version, asset, result, deviation, suggest, run_id}`。`deviation`（实战与卡片的偏差）是反哺核心原料，有偏差必须记录。

### 6.2 卡片修订触发器

①新绕过/变体 → 补 detect；②误报未拦截 → 补 falsification（考虑沉淀 PatternCard）；③fp_count 上升 → 评审过宽；④到废止线；⑤新情报/新工具；⑥SRC 政策变化 → 更新 src_notes；⑦跨项目经验迁移。

### 6.3 卡片 ROI 排行与资源分配

每月按 `hit/usage/fp` 三率出卡片排行：头部卡加资源（更高优先级权重），尾部卡进废止评审。废止触发器管"死活"，ROI 排行管"资源倾斜"——两者合并才闭环。

### 6.4 预算自适应（反馈控制环）

按近期产出动态调整探索配额：连续高命中 → 探索配额下调，深挖当前方向；连续 3 日零产出 → 探索配额上调（20%→40%）+ 强制切换发散方向（§7.2 换角度）+ 评审是否目标面枯竭需扩 scope。**用数据防"惯性空转"。**

### 6.5 知识流动全景

```
实战中 ─┬─ 新类型/新打法 → 注册新卡(draft)
        ├─ 工程技巧 → MethodCard
        ├─ 判定依据/误报特征 → PatternCard（含 counter_examples）
        ├─ 用不了的灵感 → IdeaCard（留种）
        └─ 与既有卡偏差 → card_usage.deviation → 升版

情报侧 ─┬─ intel/web_search 新 CVE/新打法 → IdeaCard 或 N-day 卡条款
        ├─ kb 开局强制检索 → 命中挂相关卡 changelog
        └─ 外部 writeup/厂商体质复盘（§9.2）→ 优先级权重 + IdeaCard

xray flows ─→ 每日消费管线（MethodCard）：
        参数URL→dalfox/sqlmap；敏感信息/未脱敏字段正则回扫；未授权200重放标注

复盘侧 ─┬─ 每周评审：词表合并/draft 晋升/deprecated 清理
        ├─ 每月：卡片 ROI 排行、STALE 风暴检查
        └─ brief 生成时按当日目标指纹 RAG 预取相关卡片+历史 attempts
            （防重复造轮子、防重复尝试已证伪方向）
```

---

## 七、自由探索机制

### 7.1 任务结构：保底与自由

| 部分 | 内容 | 硬指标 |
|---|---|---|
| 规定动作 | 优先级队列消化、复验到期项、huntlist 判定、台账留痕 | brief 明确列出 |
| 自选动作 | 自由探索 | **≥20% 时间 或 ≥3 条 IdeaCard**（配额随 §6.4 自适应） |

边界：①自选不挤占规定动作；②探索产出**只进 IdeaCard/huntlist，不许直接进 findings**（灵感与漏洞之间隔着验证规程）。

### 7.2 头脑风暴六角度（写进每日 brief）

1. **组合**：两个已确认事实能否组合成新链？（CORS×缓存投毒；SSO continue×开放跳转；接管子域×cookie tossing）
2. **类比**：同类厂商/业务的公开 writeup 怎么打的？（kb 检索）
3. **倒置**：防守方假设反过来会怎样？（"网关一定鉴权"→ 走私/路由绕过试试）
4. **协议下沉**：HTTP 下面还有什么？（WS、T3/AJP/MQ、H2 走私、Host 多面性）
5. **数据追问**：响应里每个字段从哪来、能被谁影响？（Server-Timing→侧信道）
6. **时间维度**：面随时间怎么变？（发版窗口、CT 新证书、大促临时面）

另加两条扩展角度：⑦**生态侧写**：这个资产的供应商/外包/被收购方是谁，它们的系统是否同主体同栈（§9.1 二级资产）；⑧**白盒镜像**：目标用的开源组件源码里这个逻辑怎么写的？（§7.5 白盒路线）

### 7.3 IdeaCard：想法留种与孵化

```yaml
id: IC-007
type: idea
name: waimai CORS 反射 × 登录态缓存投毒组合链
status: seed              # seed / incubating / testable / validated / promoted / rejected
seed_from: 2026-08-27 头脑风暴（方向1：组合）
hypothesis: ...
verification_requires:    # 留种核心：写清缺什么
  - 登录态账号（blocker: no-credential）
  - 缓存键测绘方法
first_testable_when: 凭据到位当日
related: [VC-001, VC-0xx-缓存投毒]
```

流转：seed →（补充方法/先例）→ incubating →（条件满足，每日开局检查 first_testable_when）→ testable →（实测成功）→ promoted（转正为卡或并入 changelog）；证伪 → rejected（写清依据，**rejected 也是知识**）。

### 7.4 思路碰撞制度化

- **跨项目**：美团确认的手法每周对字节资产做适用性扫描（反之亦然）
- **跨时间**：每月用当前卡片库对历史 TESTED_CLEAN 抽样重估（卡片进化后过去的"干净"可能不再干净）
- **外部碰撞**：web_search 定期查"目标厂商+公开 writeup"；监控安全社区（公众号/Twitter/知识星球）新打法——**传播时间差就是机会窗口**

### 7.5 白盒审计路线（摆脱 N-day 依赖的真正路径）

字节自开源大量组件（coze-studio、deer-flow 等曾花精力证伪其 CVE）。反向做：**semgrep（已装未用）+ 模型对开源组件源码审计找 0day → 查线上部署版本**。命中即高危且独占。配套：kb 224 篇文章作为审计模式库；产出新洞 → 沉淀 PatternCard（该类代码模式的识别特征）→ 横向扫其他组件。这是从"等 CVE"到"造 CVE"的升维。

---

## 八、登录态测试方法论与账号获取策略

### 8.1 按"登录后增益"分级

| 分级 | 特征 | 实测示例 | 策略 |
|---|---|---|---|
| A（必投） | 登录后暴露全新功能面：管理后台/商家端/运营端/API 控制台 | admin.erp、cloud-erp、livehub、keeservice、lbs 控制台、carrier proxy | 集中资源搞账号 |
| B（选投） | 登录后多个人数据/订单/消息面 | waimai 订单、火山开发者 user 系列 | 有现成账号就挂 |
| C（不投） | 登录/未登录几乎同面 | 官网、营销页、文档站 | na_reason=no-auth-feature |

### 8.2 账号获取路径（开放清单）

| # | 路径 | 说明 |
|---|---|---|
| 1 | 自行注册穷尽 | 每个 A 级资产必答"注册入口在哪"；**注册入口侦察列为 recon 常规任务**。美团（C端/开放平台/商家版/Keeta 海外）、字节（抖音/巨量试用/火山引擎个人试用/coze/Trae） |
| 2 | SSO 乘数 | 美团 unitivelogin、字节通行证一号通多系统，优先打通主账号 |
| 3 | 开放平台/沙箱 | 开发者 API Key、沙箱、试用额度 → 合法 token 直测 API 面 |
| 4 | **无账号登录面测试** | 登录接口本身：枚举/轰炸/验证码/密码重置逻辑/OAuth 配置（VC-015，无需账号） |
| 5 | 厂商自暴露凭据 | demo 账号、JS 中测试凭据、公开泄露——**红线：绝不用拖库凭据、绝不登真实用户账号**；泄露本身可作为信息泄露提交 |
| 6 | 邀请制申请 | 企业试用/内测，清单交人工批量申请 |
| 7 | 放弃并标注 | `BLOCKED(no-registration-channel)` + 转路径 4 + 定期复评，不许无限占 huntlist |

### 8.3 账号资产管理

凭据入 credentials 表（`program/system/account_type/scope_binding`）；**双账号原则**（水平越权成对注册）；测试数据隔离（只碰自建测试数据）；会话维持（browser profile + xray 7777 代理链）；cookie 失效告警转人工。

### 8.4 登录后挖掘方法

功能全覆盖爬虫（katana 带会话过 xray）→ authz_diff 双账号差分 → 对象 ID 遍历（JS 泄露真实 ID 做种子）→ 业务逻辑 → GraphQL/批量接口 → 角色权限矩阵 → **会话管理专项**（fixation/登出失效/改密后会话/并发控制）。

### 8.5 签名与加密参数的处置

APP API 常见 sign 签名。分级处置：

1. **先测签名实现质量**（无需逆向）：改参数重放看是否真校验（很多只验存在性）、重放旧请求看有无时间戳/nonce、删签名看是否放行——半数实现有缺陷
2. 确实验签的 → `BLOCKED(needs-reverse)`，转人机混合任务（frida 逆向），不硬磕
3. 逆向产出沉淀 MethodCard（该 APP 的签名算法），一次逆向长期复用

---

## 九、资产收集与情报源（开放清单）

### 9.1 资产收集方法（初始清单，随时注册新方法）

| 优先级 | 方法 | 工具/源 | 说明 |
|---|---|---|---|
| P0 | URL/端点历史挖掘 | waybackurls、gau、katana、ParamSpider | 最大缺口；含**僵尸 API 对比**（历史有当前"消失"的接口可能还活着，旧版 /v1 鉴权弱） |
| P0 | JS 端点自动化提取 | subjs + LinkFinder/SecretFinder、katana -jc | 手工验证过效果，须工具化 |
| P1 | **ICP 备案反查** | 备案查询 API/站长工具 | **国内 SRC 利器**：通过备案号反查同主体全部域名/网站，与证书反查互补 |
| P1 | 被动 DNS 多源 | SecurityTrails、VT、OTX、urlscan、RapidDNS、uncover | 解决单源枯竭 |
| P1 | 空间测绘 API | fofa/hunter/quake/censys | 同证书反查 + **favicon mmh3 hash 全网猎捕同主体资产** |
| P1 | 子域爆破+排列 | puredns/dnsx + alterx | 被动源枯竭后的增量主力 |
| P1 | 子域接管 | nuclei takeover / subzy | 含 NS 接管、云桶接管 |
| P2 | ASN/IP+端口面 | asnmap/mapcidr → naabu → httpx | 云原生组件面的载体 |
| P2 | **二级/生态资产** | 供应商、外包商、合资公司、被收购方（摩拜先例） | 从股权关系/备案主体/招聘 JD 发现"为美团服务"的外围系统 |
| P2 | 移动端/小程序 | jadx、小程序解包 | 业务大头在 App |
| P2 | 代码泄露面 | GitHub/GitLab 监控、网盘文库、**内部包名→依赖混淆可行性** | — |
| P3 | 云桶枚举 | S3/OSS/TOS/COS | 配合 JS 提取桶名 |

**警惕伪收敛**："diff=0 多日"只说明现有源没新货；多源 + 备案反查并行后才允许下收敛结论。

### 9.2 情报源（长期喂给回路 C）

| 源 | 频率 | 产出 |
|---|---|---|
| certstream CT 流 | 常驻 | 变化雷达（§1.3） |
| CVE/组件情报 | 每日（现有） | N-day 候选 |
| **招聘 JD / 技术博客 / 会议 PPT** | 月度 | 内部系统名、技术栈、架构图 → 指纹库 + IdeaCard（最被低估的人肉情报源） |
| **厂商"体质"复盘** | 季度 | 历史公开漏洞聚类：哪类洞多发、哪业务线反复出事、修复是否彻底（变体重现）→ PatternCard「厂商画像」→ 喂优先级权重 |
| **安全社区 writeup 监控** | 每周 | 新打法时间差 → IdeaCard |
| SRC 平台公告 | 每周 | §十 |

---

## 十、SRC 平台运营

### 10.1 范围变更监控

监控各 SRC 收录范围/规则页面变化：**新纳入的资产抢首发**（首批测试者命中率最高）；范围缩减即时同步 scope.yml（合规联动）。

### 10.2 活动期策略

双倍积分/季度冲榜期间，集中提交存量 `src_ready` findings；平时按节奏提交保持账号活跃与信誉。

### 10.3 提交前查重（必须步骤）

提交前检索：平台公告、已公开漏洞、公开 writeup，确认非重复——**重复提交扣信誉分**。查重记录落 `evidence/{id}/dedup.md`。

### 10.4 提交稿自动化

`reproduce.md` → 各平台提交模板（标题/影响/复现步骤/修复建议）一键出稿，人工只审不改。影响描述按 §3.3 要求具体化。

---

## 十一、合规与止损红线

自动化系统必须有**机器强制的停止条件**，不靠模型自觉：

1. **够证即停**：证明漏洞存在的最小请求后立即停止——不拖数据（敏感数据采样 ≤ 最小证明量）、不横向移动、不扩大影响
2. **数据红线**：不下载/留存超证明所需的用户数据；证据中的真实用户数据脱敏后落盘
3. **凭据红线**：绝不用拖库凭据、绝不登录真实用户账号、只用自建测试数据做越权验证
4. **速率红线**：全局限速 50 QPS（scope.yml 硬控）；爆破类仅测试环境
5. **风险分级**：intrusive 一律人工确认（scope-guard 现有）；OOB 回连/反连类 payload 视为 active+，需出口与目标双重确认
6. **蜜罐回避**：命中蜜罐特征即退（§2.4）
7. **规则遵从**：robots.txt 与 SRC 规则变更监控（§10.1），规则收紧即时生效

---

## 十二、落地路线图

| 期 | 动作 | 公理 | 收益 |
|---|---|---|---|
| 第一周 | ① 标准产物+schema 校验进任务契约；② attempts/handoff/brief 三件套；③ nuclei info 噪音隔离；④ 存量 findings 回填类型；⑤ **OOB 基础设施部署**（解锁盲类漏洞） | P2 | 留痕/防幻觉 + 整类漏洞解锁 |
| 第二周 | ⑥ 四类卡注册表 + 种子卡（§5.4 全家族）从既有方法论初始化；⑦ 覆盖矩阵聚合脚本 + **优先级队列**；⑧ L2 接口层管线；⑨ 机械复核脚本（response hash 重放） | P1/P3/P4 | 域名级→接口级，覆盖可见可调度 |
| 第三周 | ⑩ **变化雷达**（certstream + JS bundle diff）；⑪ xray flows 消费管线（含脱敏回扫）；⑫ 探索配额与 IdeaCard 进契约；⑬ 出口健康矩阵 + 负账本洗白；⑭ 资产源扩容（备案反查/favicon/多源） | P5/P1 | 从巡逻变伏击；数据质量地基 |
| 第四周 | ⑮ 每周评审机制 + 每月卡片 ROI 排行；⑯ 预算自适应；⑰ SRC 平台运营（范围监控/查重/模板） | P3 | 进化回路 + 信誉资产保护 |
| 持续（需人配合） | ⑱ 凭据策略（§8.2 成对注册 → 浏览器挂 xray → authz_diff）；⑲ 白盒审计路线试点（coze-studio 源码审计） | — | 带回 high/medium 产出 + 0day 能力 |

### 关键原则回顾

1. **没有漏 = 台账可证**，不是"扫过"（P1）
2. **LLM 不给自己当法官**——能机械校验的绝不靠自证（P2）
3. **每次使用都是评审，每次偏差都是升版机会**（P3）
4. **格式锁死、内容放飞；表格会长大，schema 不长**（P4）
5. **规定动作保底、自选动作留种；今天用不了的想法是明天的漏洞**（P5）
6. **变化优先于存量，组合胜过大全**（调度哲学）
7. **够证即停，活得久比打得多重要**（合规哲学）

---

*v2.1 变更说明（2026-08-27）：整合五组扩展——A 组机制优化（优先级队列/机械复核/OOB/变化雷达/STALE 治理/负账本洗白/出口健康矩阵）、B 组新攻击面（Desync/WebSocket/云原生配置中心/AI 应用/cookie tossing/僵尸 API/白盒审计/缓存投毒）、C 组情报维度（CT 流/JD-PPT 情报/平台运营/厂商体质）、D 组运营度量（ROI 排行/提交模板/蜜罐识别）、E 组补充（对抗性复核/签名重放/Host 投毒/脱敏检查/ICP 备案反查/favicon 猎捕/网关路由绕过/日志监控面/RAG 预取/预算自适应/验证止损线）；新增第十章 SRC 平台运营、第十一章合规止损红线。*

---

## 附录：实施状态（2026-08-28 第一批落地）

已在 csai 完成（版本受控源文件在 SilkSpool 仓库 `bundles/dsh/templates/data-seed/`）：

| 项 | 落点 | 状态 |
|---|---|---|
| sec-pipeline 技能 | `/opt/silkspool/dsh/data/skills/sec-pipeline/SKILL.md` | ✅ 已部署 |
| 漏洞卡注册表 + 17 张种子卡 + IdeaCard 模板 | `data/vulncards/`（registry.md、VC-001~029、ideas/） | ✅ 已部署 |
| brief/handoff 模板 | `data/templates/` | ✅ 已部署 |
| 格式校验脚本 pipeline-validate.py | `/opt/silkspool/dsh/scripts/pipeline/` | ✅ 已测试（正反例均正确） |
| 覆盖聚合脚本 coverage-report.py | 同上 | ✅ 已测试 |
| 机械复核脚本 verify-replay.py | 同上 | ✅ 已测试（经 8899 代理重放成功） |
| 台账初始化 | `data/pipeline/{meituan-src,bytedance}/attempts-*.tsv` | ✅ 表头已建 |
| 任务契约接入 | tasks #16/#17/#18/#19 objective 追加「P13-流水线规范」（DB 已备份 backups/asset-graph.pre-pipeline-*） | ✅ 已生效（下次调度起） |
| OOB interactsh-server v1.3.1 | `/opt/silkspool/dsh/oob/`（service 文件 prepared 未启用） | ⏸ 待 DNS 委派（需选一个域如 oob.singll.net 做 NS 委派指向 141.11.43.99，然后启用 systemd unit） |

**待人工事项**：见专门登记文档 [secagent-manual-tasks.md](secagent-manual-tasks.md)（H-001 OOB 域名 NS 委派、H-002 双项目成对凭据、H-003 存量回填 vuln_type）。

### 第二批落地（2026-08-28）

| 项 | 落点 | 状态 |
|---|---|---|
| L2 接口层收集 l2-collect.sh（katana+waybackurls+gau→endpoints.tsv） | `scripts/pipeline/` | ✅ 实测：单目标采 6593 端点/913 参数 URL 入队 |
| 参数面消费 surface-consume.py（dalfox/sqlmap 队列 + 敏感信息回扫） | 同上 | ✅ 已测试 |
| 变化雷达·JS 发版监控 js-watch.py | 同上 | ✅ 已测试 |
| 变化雷达·CT 新子域 ct-watch.py（certspotter 轮询，含 429 退避） | systemd `ct-watch.service` 常驻 | ✅ 运行中（公共 calidog websocket 已验证不可用，改轮询设计） |
| **重要纠偏** | xray flows/*.jsonl 只有扫描统计计数、无请求内容——"11.2 万条 flow 死库"实为统计计数，流量内容从未被记录。参数面改由 l2-collect 直接产出 | 已更新认知，skills 中注明 |
