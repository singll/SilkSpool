# SilkSecAgent 外部 Skill 仓库对标与优化方案

> 日期: 2026-09-05
> 对标对象: MyuriKanao/src-hunter-skill（已归档 v1.2.1）· SnailSploit/Claude-Red（v0.3.0）· elementalsouls/Claude-BugHunter（v2.1.0）
> 结论性质: 方案文档，非实施记录。实施项落地后按惯例更新 `README.md` 待办与 `silksecagent-system-complete.md`。

---

## 一、三仓库画像（一句话）

| 仓库 | 形态 | 一句话定位 | 对 secagent 最有价值的部分 |
|---|---|---|---|
| **src-hunter-skill** | 单 skill + 64MB 分层知识库 | 黑盒 SRC 挖洞的"流程控制器 + 强制按需读文件"知识体系 | 阶段 checkpoint 门控、信号路由表、反幻觉引用约束、三层合规红线、8 段式 playbook 结构 |
| **Claude-Red** | 78 个纯提示词 skill | 红队方法论注入（零代码、零执行层） | trigger-by-description、Quick Workflow/Cheatsheet 首尾结构、MINDMAP 覆盖审计、one-skill-one-surface 治理、CI 用 LLM 审 skill |
| **Claude-BugHunter** | 83 skill + 双 Python 引擎 + eval | 工程化程度最高的漏洞挖掘框架（确定性优先） | 消融评测方法论、7 问验证门、防误报纪律规则、对抗性严重度校准、阴性账本、研究→策展知识管道 |

三者与 secagent 的关系：**secagent 是唯一的执行平台**（工具沙箱 + 审批 + 记忆治理 + 状态机），三个仓库都是"知识/流程层"产品。因此借鉴方向不是架构替换，而是**把三家的知识组织协议、验证纪律、评测方法论移植进 secagent 已有的骨架**。

## 二、能力对照矩阵

| 能力域 | src-hunter | Claude-Red | BugHunter | secagent 现状 (v4.6.1) | 差距 |
|---|---|---|---|---|---|
| 工具执行/沙箱 | ✗ | ✗ | 半（CLI 包装） | ✅ 31 工具 + bwrap + run_cli 单入口 | **secagent 领先** |
| 授权/scope 硬管控 | 流程 checkpoint | ✗（ROE 文字） | ✅ 代码级 allowlist + deny-wins | ✅ scope-guard 8 步 fail-closed + 审批 kind | secagent 领先，但缺**动词级 deny 语义** |
| 知识规模 | 19 playbook + 2887 H1 报告 + payload 字典 | 78 skill | 83 skill + 681 报告模式 | 56 rules + 18 vulncards + 334 kb_docs | **量级差 5-10 倍**，且缺真实案例引用层 |
| 知识消费机制 | 信号路由表 + 强制 Read | description 触发 | skill_map 表面映射 | kb_search 注入（97% 零使用，T-14 未验收） | **最大差距**：三家都解决了"何时读什么"，secagent 还没解决 |
| 验证纪律 | 7 种幻觉类型 + 差分证明 | 证据纪律 skill | 7 问门 + never-submit + 5 条防误报规则 + 软404基线 | sec-verification 铁律 + 六态台账 + verify_replay | 有骨架缺**细则**（never-submit/统计采样/body-diff 均无） |
| 严重度可信度 | — | — | ✅ 对抗性校准（验证方覆盖提交方） | review 角色存在但**未制度化**"以验证方为准" | 缺一条硬规则 |
| 跨任务记忆 | ✗ | ✗ | ✅ 阴性账本 negatives.jsonl | ✅ exp_cards 生命周期 + 负知识自动捕获 | secagent 领先，但缺 **host×栈×漏洞类 阴性矩阵** |
| 知识自进化 | ✗（归档） | CI LLM 审查 | ✅ 收割→缺口→人工策展→引用核验 | candidate→active→cooling 状态机 | 缺**外部语料入口**和**引用核验** |
| 评测 | ✗ | ✗ | ✅ 消融 eval + 假阳性 eval | ✗ | **完全缺失**，且 T-14/T-15 验收正需要它 |
| 报告工程 | 三段式 + 4 平台模板 | 9 段式 + 证据纪律 | 4 平台 + 写作铁律 + 证据脱敏 | vuln-report-format rule（1 篇） | 单薄，无平台差异/脱敏细则 |
| 子代理契约 | — | — | ✅ scope 不隐式继承的血泪条款 | spawn_worker（scope 继承机制未审计） | 需显式契约化 |

## 三、差距分析（按根因归组）

### G1 知识消费断路（对应 T-14/T-15）
kb_docs 334 篇 97% 零使用、FGS 39 节点沉淀为零。三家仓库的共同答案是**知识不靠"检索指令注入"被消费，靠"路由表"被消费**：
- src-hunter Phase 4 的 19 行信号路由表：入口信号（指纹/端点/参数特征）→ 必读文件，命中才读；
- BugHunter 的 skill_map.py：攻击表面 → skill → 首条 curl 的确定性映射；
- Claude-Red 的 description 密集触发词：内容再好，触发描述不命中就不会进上下文。

secagent 当前的 kb_search prompt 注入是"泛检索指令"，没有"信号→文件"的确定性映射层——这是死库存的根因。

### G2 验证纪律有骨架无细则
secagent 有六态台账、verify_replay、防幻觉十条，但缺 BugHunter 用真实事故换来的细则：
- **never-submit 清单**（self-XSS、仅 DNS 回调 SSRF、单独 open redirect、仅 introspection 等——一个 NO 即杀）；
- **条件有效需成链表**（低危信号单独不报，成链才报）；
- **OOB-Or-It-Didn't-Happen**（盲类必须有 interactsh 回调，报错回显 URL 不算证据——直接依赖 H-001 落地）；
- **Marker Discipline**（注入标记 8+ 位随机、先查基线响应是否天然含该词）；
- **Body-Diff Rule**（绕过主张必须有响应体差异，仅状态码变化不算）；
- **Statistical-Sample Rule**（时序侧信道 n≥10 交错采样、均值差 ≥2σ）；
- **软 404 基线**（每主机先打两条假路径记"状态码+字节长+body hash"三元组作对照）；
- **多工具复现门槛**（Critical/High 须两个独立工具栈复现）。

### G3 知识量级与可信引用
- secagent 56 rules vs 三家合计 180+ skill；最缺的不是量，是**三类内容**：① 统计驱动的入口点数据（src-hunter 的参数频率表/注入向量分布）；② 真实案例引用层（2887 H1 报告按 CWE 可查）；③ payload/绕过字典（Payloader 305 条 + waf-bypass 263 变体）。
- src-hunter 的反幻觉约束值得直接移植："给 payload 前必须能查到文件出处；引用案例说不出文件路径就别引"——这与 secagent "无证据不结论" 原则同源，但把它落到了**知识引用**层面。

### G4 无评测，改进不可证
BugHunter 用消融实验得出"hunt skill 对可基准化任务增益 ≈0"并据此把 LLM 预算移到确定性框架——这个方法论本身比它的 83 个 skill 更值钱。secagent 的 T-14（kb 消费激活验收）、T-15（FGS 沉淀验收）目前都只能靠人肉观察，正是缺一个 oracle 评测框架的表现。

### G5 知识治理缺防膨胀与防泄漏规则
- Claude-Red 的 "one skill one surface + 超面即拆分、原文件降级为总览" 对抗单体膨胀病；sec-memcore 的 R1-R7 是写入校验，没有**拆分/降级**治理。
- BugHunter 研究管道里的 `scan_identifiers.py`（防真实客户名泄入知识库）+ `verify_citations.py`（433 引用 0 错配）——secagent 处理真实目标数据，知识入库前的**标识符脱敏**目前无守门。

### G6 子代理授权契约未显式化
BugHunter 的血泪条款：子代理 scope 不隐式继承——目标列表**逐字传入**、新发现资产一律 report-only、**deny 按动词优先于路径关键词**（否则 `refund/batch/status` 被读形关键词放行）、"read-only" 必须展开成动词清单（真实事故：被告知 READ-ONLY 仍向 `generate*` 端点发 `{}` 在生产创建记录）。secagent 的 spawn_worker 是否满足这四条未审计过。

## 四、优化方案

> 原则：全部增量落在既有骨架上（审批 kind、memcore 原语、六态台账、看板），不引入新框架、不整包搬运外部仓库。

### P0 — 验证纪律与报告细则（纯知识层，零代码，立即可做）

**P0-1 sec-verification skill 升级**（改 `data-seed/skills/sec-verification/SKILL.md`）
- 并入 G2 全部 8 条细则，逐条配"真实事故对照"（可直接引用 BugHunter 公开案例叙事）；
- 新增 never-submit 清单 + 条件有效需成链表；
- 新增 A→B 链信号表（发现 IDOR on GET → 立即查同路径 PUT/DELETE + 兄弟端点；SSRF 回调 → 内网服务；open redirect → OAuth code 窃取；S3 列举 → JS bundle → 密钥）。

**P0-2 严重度对抗性校准制度化**（改 review 角色 prompt + vulncards 写入点）
- 硬规则：hunt 角色自报严重度仅作参考值，**落库严重度以 review/verify 角色复核后为准**；
- 六态台账 reason 字段增加"校准轨迹"（原始值→校准值→依据）。

**P0-3 报告模板升级**（改 `data-seed/rules/srcskill/vuln-report-format.md`）
- 并入写作铁律：禁 "could potentially"、impact 第一句、复现命令可直接粘贴进 shell；
- 补证据卫生节：cookie 脱敏、PII 打码（前2后2+sha256，与既有合规口径一致）、截图顺序、提交后凭证轮换；
- 补平台差异调整节（H1/Bugcrowd/补天/CNVD）。

### P1 — 知识消费路由化（对应 T-14/T-15 的根因修复）

**P1-1 信号路由表**（新增 `data-seed/rules/src/` 一篇 + vuln-hunt 角色 prompt 接线）
- 仿 src-hunter Phase 4：把"指纹/端点/参数/行为信号 → 必读 rule/vulncard/kb 路径"做成显式表（如 Actuator/Swagger/默认端口 → unauth 类卡片；密码重置/支付/验证码 → logic-flaws 规则）；
- 消费路径：vuln-hunt 开局先读路由表（短表，<2K token），命中信号才触发对应知识文件——替代现在的泛 kb_search 注入；
- 这是对 T-14 的结构性修复：消费从"模型自觉检索"改为"信号命中必读"。

**P1-2 rules frontmatter 触发词密集化**（批量改 56 篇 rules 的元数据）
- 仿 Claude-Red：每篇 description 写成密集触发词雷达（"Use when..."场景清单），供路由表和 kb_search 排序共用；
- 顺手做格式统一：正文统一为 8 段式（定位一句话→高频入口→探测手法→Bypass→价值升级链→案例指纹→证据要点→**不要做的事**），源出 src-hunter playbook 结构，与现有 vulncards 结构兼容。

**P1-3 评测框架 MVP**（新增本地 eval 脚本，对应 G4）
- 仿 BugHunter 消融框架：选 1-2 个可自评分 oracle 靶标（Juice Shop `/api/Challenges` 是现成选项），headless worker 跑 knowledge-on/off 双条件，测 solve-rate/turns/token；
- 用途一：验收 T-14（kb 路由注入前后 solve-rate 差）；用途二：以后每批新 rules/vulncards 上线前跑增益回归，**增益≈0 的知识不进种子库**（直接采纳 BugHunter 的实测结论，避免知识库膨胀成负资产）；
- 假阳性 eval 一并做：构造伪漏洞形状的行为靶标，验证 P0-1 纪律规则是否触发。

**P1-4 覆盖度审计进看板**（改 sec-dashboard 知识 tab + memcore status）
- 仿 Claude-Red MINDMAP：WSTG/攻面清单 × 现有 rules/vulncards 交叉表，空行即覆盖缺口；
- 与"知识体检卡"并列一栏"覆盖缺口卡"，复盘角色（#24 周任务）消费它产出补库提纲——同时给 G3 的补库方向提供数据依据。

### P2 — 知识可信引用与自进化管道（对应 G3/G5）

**P2-1 案例引用层**（新增 `data-seed/kb-cases/`）
- 引入按 CWE 分组的真实案例库（H1 已披露报告为主，distill 模式 + 引 URL + 目标泛化，**不搬原文**，规避版权与标识符泄漏）；
- 引用约束进 sec-knowledge skill："引用案例前必须 kb_search 命中实际条目，说不出条目路径就别引"——src-hunter 反幻觉约束的直接移植。

**P2-2 入库守门三件套**（扩展 memcore R1-R7）
- 标识符扫描：候选知识入库前正则扫真实域名/公司名/IP（白名单内的 scope 目标名），命中即拒绝或自动泛化；
- 引用核验：带案例引用的卡片，定期核验引用条目仍存在且内容匹配；
- 防膨胀：单篇 rules 超阈值（建议 30KB）触发拆分提醒，拆分后原文件降级为指向新文件的索引——Claude-Red 治理规则的移植。

**P2-3 外部语料收割管道**（新增定时任务，接既有审批架构）
- 流程仿 BugHunter research/reports：H1 Hacktivity 元数据收割 → 对照 P1-4 覆盖表找缺口 → 起草 exp_card candidate（草稿态）→ **人工策展审批**（新增 `knowledge-adopt` 审批 kind，挂进 APPROVAL_KINDS 注册表，看板/工具/RPC 零改动）→ 核验后转正；
- 关键纪律沿用现有原则：**绝不自动写入正式知识**，人工批准前一律 candidate 态。

### P3 — 工程与契约增强（对应 G6 + 既有欠账）

**P3-1 spawn_worker 授权契约显式化**（审计 + 改 sec-suite）
- 四条硬约束：① 目标列表作为数据逐字传入 worker prompt，禁止"目标资产"式指代；② 测程中新发现主机（CT/JS/CNAME）一律 report-only；③ scope-guard 匹配顺序改**动词优先**（refund/settle/create/reset/generate 等先拒，再按路径关键词）；④ "read-only" 展开为动词清单注入；
- 前两条是 prompt 层，后两条是 scope-guard 代码层增强。

**P3-2 阴性账本矩阵化**（扩展 facts / 新增宿主×栈×漏洞类索引）
- 现有负知识是"工具失败"驱动的零散记录；补一层结构化阴性：host × tech_stack × vuln_class → TESTED_CLEAN 时间戳；
- 消费纪律：跳过决策必须留日志、**该栈从未测过的类绝不跳**——覆盖永不静默缩减（BugHunter ledger 纪律）。

**P3-3 既有 P0 欠账联动**（非新工作，标注依赖关系）
- H-001 interactsh NS 委派：P0-1 的 OOB-Or-It-Didn't-Happen 规则物理依赖它，建议升级催办优先级；
- H-005 整域通配补提：不落地则 recon 对子域探活持续被拒，P1 全部消费路由改进无数据可消费；
- 1,785 条未分级资产重跑 grade-assets：确定性批处理，做完才能进主动扫描队列；
- egress-guard（plugins.lock PENDING）与 T-16 scan-burst 审批按原计划推进。

### 实施顺序与依赖

```
P0（1-2 天，纯种子数据改动）──┐
                              ├─→ P1-1/P1-2（3-5 天）─→ P1-3 评测验收 ─→ P1-4
H-001/H-005 人工项（并行催办）─┘                        │
                                                        ↓
                                    P2（收割管道，依赖 P1-4 覆盖表）
P3-1/P3-2（独立，可随时插入）
```

## 五、明确不借鉴清单

| 不借鉴 | 理由 |
|---|---|
| BugHunter 83 skill 全量导入 | 其自家消融实验证明 hunt skill 对可基准化任务增益≈0，还每 agent 多烧 12-15k token——只借鉴其方法论，不搬库存 |
| Claude-Red 的巨型单体 skill（AD/cloud/mobile 等 300KB+ 文件） | 上下文炸弹，与其自己的 one-skill-one-surface 规范冲突 |
| src-hunter 64MB 知识库整包 fork | 已归档不再更新；且 WooYun 数据（2010-2016）年代偏旧，只取统计结论与结构范式 |
| 三家的 MCP/多 harness 集成 | 与 secagent "工具单入口、无 MCP" 设计原则（七原则之二）冲突 |
| Claude-Red 的无线/硬件/后渗透方向（wireless 14 篇、C2、EDR 绕过等） | 超出 secagent "授权 SRC/HV 漏洞发现" 边界（边界即合规） |

## 六、与既有待办的映射

| 既有待办 | 本方案对应项 | 关系 |
|---|---|---|
| T-14 kb_docs 消费激活验收 | P1-1 信号路由表 + P1-3 评测 | 根因修复 + 可证验收 |
| T-15 FGS 沉淀质量验收 | P1-3（评测框架可观测沉淀产出） | 提供观测手段 |
| T-16 scan-burst 审批 | 不变 | 按原计划 |
| T-17 CyberStrikeAI 死库存处置 | P2-1/P2-2 | 走同一套入库守门后再决定去留 |
| H-001 / H-005 / egress-guard | P3-3 | 依赖催办，非本方案新增 |
| T-9 白盒审计 0day 试点 | 本方案不含 | 白盒是独立路线（src-hunter 作者另有 code-audit 体系），待试点后另行对标 |
