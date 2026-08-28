# SilkSecAgent 体系全面评估报告

> 评估日期：2026-08-28 ｜ 评估方式：文档审读（doc/secagent 全部 7 篇）+ spool exec 对 csai 运行时实测取证
> 实测面：asset-graph.db 13 张表逐表计数、tasks/task_runs 调度数据、pipeline 台账、vulncards 卡库、每日链 worker 产物（meta.json/worker.log）、systemd 7 个 unit、代理池端到端、AGENTS.md 受管区块、scope.yml、tools.d 工具清单
> 性质：本文为一次性快照评估（证据均标注实测来源），结论供 P15+ 迭代决策使用。README.md 仍是唯一持续推进入口。

---

## 目录

- [0. 评估方法与证据基线](#0-评估方法与证据基线)
- [1. 总评记分卡](#1-总评记分卡)
- [2. 功能评估：好设计与缺失设计](#2-功能评估)
- [3. 性能评估](#3-性能评估)
- [4. 工具评估](#4-工具评估)
- [5. 架构评估](#5-架构评估)
- [6. 流程评估：资产收集与漏洞挖掘](#6-流程评估)
- [7. UI 评估](#7-ui-评估)
- [8. 对 DSH 的利用评估](#8-对-dsh-的利用评估)
- [9. 对 DSH+pi 的利用评估](#9-对-dshpi-的利用评估)
- [10. 提示词纪律评估](#10-提示词纪律评估)
- [11. 自学习流程与方法评估](#11-自学习流程与方法评估)
- [12. 卡片与沉淀物质量评估](#12-卡片与沉淀物质量评估)
- [13. 生成流程合适性评估](#13-生成流程合适性评估)
- [14. 补充维度评估（10 项）](#14-补充维度评估10-项)
- [15. SRC 挖掘能力提升建议（路线图）](#15-src-挖掘能力提升建议路线图)
- [16. 结论](#16-结论)

---

## 0. 评估方法与证据基线

评估遵循一条原则：**文档声称什么不重要，csai 上实际在跑什么才重要**。所有关键判断都有一手实测证据：

| 取证点 | 实测结果（2026-08-28） |
|---|---|
| assets 表 | **79,258 行**（bytedance 52,867 / meituan 25,987 / _legacy 106 / vulhub 6）；level 分级：S 49 / A 632 / B 5,129 / C 6,669 / **空 66,779（84% 未分级）**；对比 08-22 的 10,138 行，6 天膨胀 **7.8 倍** |
| endpoints 表 | 330 行；TSV 侧 bytedance 6,594 行、**meituan 0（l2-collect 未铺开到美团）** |
| findings 表 | 357 行：high 6 / medium 10 / **info 316（占 88%）**；high/medium **全部产生于 08-20 手工战役**，自动化管线 8 天零 high；vuln_type 为空 **353/357（99%）**（H-003 未做） |
| facts 表 | 1,057 行：note 425 / target 271 / asset 235 / finding 71 / recon 21 / infra 16 / **空 category 10**；blackboard 残 292 键（双记忆存储并存） |
| 语义层 | exp_cards **仅 2 张 active**；playbooks 20（含 `tool:diag2/diag3` 垃圾条目）；kb_docs 254；credentials **1**；fingerprints 87 |
| 纪律台账 | attempts TSV：美团/字节**仅表头 0 数据行**（dsh-ops 2 行）；**card_usage.jsonl 全库不存在**；handoff/brief **仅模板无实例** |
| 调度 | tasks #16-#19 interval：last_run=08-27 19:30-21:30 UTC（=北京 08-28 03:30-05:30，链路当天有跑）；**next_run 漂移至 08-29/08-31**（T-0 未修复，部分任务明日将跳跑）；**task_runs 表最大记录停在 08-26 22:00**（当日运行未落库，可观测断链） |
| 任务产物 | #18 meta.json：duration_ms=3,600,221（**3600s 预算硬顶打满**）、exit 0、**session_id=null**（看板跳链数据缺失）；worker.log 尾部仅 1 行有效业务日志 |
| 漏洞卡 | 17 张实体卡 + IC-000 模板；**ideas/ 下 0 张真实 IdeaCard**（"自选动作 ≥3 条 IdeaCard"从未兑现） |
| 常驻服务 | silksecagent / edge / xray(7777) / proxy-rotator(8899) / shared-browser(9222) / ct-watch 全 active；retention/backup/intel/proxy-refresh timer 全 enabled |
| 端到端 | 代理池出口实测 US Virginia（轮换网关工作）；OOB interactsh **未安装启用**（H-001 DNS 未配） |
| 记忆基架 | AGENTS.md memcore 受管区块自动生成正常（Top 卡带 score/adopted；env-issue 4 条在挂）；sweeper 6h 运转 |
| 合规 | scope.yml fail-closed + 解析后校验 + 看板授权视图 + spool sync 协同注释齐备；tools.d 27 个 manifest |

---

## 1. 总评记分卡

评分口径：5 分制。5=设计优秀且落地被验证；4=设计好、落地有缺口；3=能跑但质量/纪律打折；2=有架子、实效差；1=缺失。

| 维度 | 得分 | 一句话判语 |
|---|---|---|
| 功能完备度（平台侧） | **4.5** | 数据脊柱/调度/看板/合规/记忆基架全齐，工程完成度高 |
| 漏洞产出实效 | **2** | 8 天自动化零 high，全部高分靠 08-20 手工；"高覆盖低产出"未反转 |
| 资产收集 | **3** | 广度炸裂（7.9 万）但 84% 未分级、无 alive 门控，噪声资产淹没有效目标 |
| 纪律执行（台账/卡片/交接） | **1.5** | 六态台账 0 行、card_usage 0 条、IdeaCard 0 张、handoff 0 份——纸面纪律与执行完全脱节 |
| 性能与资源效率 | **3** | 每日预算打满 3600s、产出比极低；压缩比/沙箱/代理池工程质量好 |
| 架构 | **4.5** | 分层清晰、插件解耦实证优秀（升级零被动改动）、数据外置 |
| 工具链 | **3.5** | 27 manifest 齐、stdin 卡死根治；但 20+ 装机 5 在用的闲置未变 |
| UI/看板 | **4** | 五视图+跳链+授权管理+知识 tab 设计到位；跳链数据断链 |
| DSH 利用 | **4** | 深度超预期（工作区/会话上下文/组合树全用上），绕坑经验成体系 |
| DSH+pi 利用 | **4** | 单轨纪律正确；spawn_worker/视觉模型等 pi-ai 能力只用了一半 |
| 提示词纪律 | **3** | 防幻觉十条/五公理设计优秀；objective 仍臃肿、纪律靠提示词多于靠代码 |
| 自学习 | **3** | memcore 架构业界少见的完整；但 2 张卡/0 反馈回路说明闭环未转起来 |
| 卡片与沉淀物 | **3.5** | 卡片 schema/质量高；使用记录/迭代证据/沉淀量全部不足 |
| 流程合适性 | **3** | P13 规范方向对，但执行产物（台账/交接/日报）未按规范落地 |
| 可观测性 | **2.5** | task_runs 断链、报告噪声淹没信号、worker.log 几乎无业务日志 |
| 安全合规护栏 | **4** | fail-closed/沙箱/审计/retention 实测在位；egress-guard/Authelia 两件持续欠账 |
| **综合** | **3.2** | **"平台工程"已接近优秀，"漏洞挖掘实效"还停在起点。体系最大的风险不是缺能力，而是纪律只在文档里。** |

---

## 2. 功能评估

### 2.1 好的设计（值得保持并强化）

1. **六态覆盖模型 + 机器生成覆盖视图**（README §4.3）：`PENDING/TESTED_CLEAN/CONFIRMED/FP/NA/BLOCKED/STALE` 每态强制理由值、禁 other/misc、coverage-report 禁手填——这是把"覆盖率"从口号变成可审计数据结构的正确设计。BLOCKED 解锁收益表（coverage-latest.md 实测输出）把"缺凭据/缺 OOB"量化为单元格数，管理视角极佳。
2. **漏洞卡四类体系**（VulnCard/MethodCard/PatternCard/IdeaCard）：实测 VC-002（子域接管）质量很高——applicable_when/not_applicable_when 前置判适用、detect/verify 分离、falsification 证伪清单、`src_notes` 写放大路径（cookie tossing/CSP 绕过）用于提级、retest_after_days、changelog 版本化。这是可以直接给人类 SRC 手用的规程。
3. **fail-closed 授权真相单一源**：scope.yml 为唯一权威 + scope-guard 硬校验 + 解析后 DNS 校验 + 看板原子写 + spool sync 协同（连"界面写入后需 pull 回收"的坑都写进了文件头注释）。合规红线的工程化程度远超一般自建平台。
4. **记忆基架（memcore）**：fail-open 旁路设计、permanent 禁直写、三问写入纪律、自动晋升托底（无复盘好用的卡照样浮现）、AGENTS.md 受管区块自动生成——实测区块内容健康（Top 卡带 adopted=27 的真实信号，env-issue 自动在挂）。"提示词负责智慧、代码负责纪律"的原则落到了实处。
5. **双项目台账分目录**（data/pipeline/{program}/）+ ct-seen/js-watch-state 等状态文件按项目隔离，radar 语义（变化优先于存量）正确。
6. **升级保护**（dsh-upgrade 报告）：数据快照 + 深冒烟（组合树校验）+ 三段自动回滚，把 rc 版升级成本压到"一条命令"。

### 2.2 缺失的设计（按对产出的影响排序）

1. **纪律执行无代码强制（最大缺口）**：台账六态、card_usage、IdeaCard 产额、handoff 生成，全部靠提示词约束 agent 自觉，结果实测全部为 0。设计规范 §4.8 自己写过"合规止损（机器强制）"，但**产出纪律恰恰没有机器强制**。缺一个与 scope-guard 同级的"流程守卫"：finding_add/收尾时校验台账行是否存在、卡使用是否落 usage、无 handoff 则任务不标 done。
2. **findings 噪声门控缺失**：316 条 info（ssl-issuer/wildcard-tls/dns-saas 这类模板指纹）直接进 findings 表和日报，把 6 条真 high 淹没。缺"info 级默认落 fact 不落 finding + 模板白名单 + 同模板同目标去重"的入口闸门。
3. **资产分级/alive 门控缺失**：7.9 万资产 84% 无 level，nuclei 全量跑等于把预算摊薄到垃圾上。缺"未分级资产不进主动扫描队列"的准入规则（现在的 score 排序有基础，但 66,779 个空值绕过了它）。
4. **凭据/登录态体系缺失**（H-002 未动）：credentials 表只有 1 行，越权/逻辑/登录态面全部 BLOCKED——这是产出瓶颈第一位，README 判断正确但 0 进展。
5. **OOB 缺失**（H-001 未动）：interactsh 二进制躺了 5 天等 DNS。全部盲类卡片不可测。
6. **SRC 提交链路缺失**：report_build 生成内部报告，但"平台模板提交稿/dedup 查重/活动期策略"（T-11）无任何落地。挖到→交上去之间断链。
7. **业务逻辑/越权自动化缺位**：authz_diff 工具在但无用武之地（没凭据）；VC-008/VC-017 建卡也依赖 H-002。当前工具矩阵偏"扫描器编排"，对 SRC 高价值逻辑漏洞没有抓手。

---

## 3. 性能评估

**实测证据**：
- #18 vuln 任务 duration=3,600,221ms——**预算硬顶打满，exit 0**。即每日 4 点任务以"时间烧完"而非"目标完成"收场，产出与耗时无相关性。
- spawn_worker 纪律（≤3 目标/≤600s）写在 objective 里，但无代码强制；父 worker 3600s 硬上限与子任务排队叠加，实际有效扫描窗口被管理开销蚕食。
- run_cli 压缩比 1146x、全量落盘+≤20 行摘要的 I/O 设计优秀；httpx stdin 卡死根治后 ProjectDiscovery 系工具正常。
- onnxruntime 每次加载报 pthread_setaffinity 错误（线程亲和参数不兼容 LXC），embedding 服务能跑但日志噪声大、启动开销存在。
- task_runs 出现多条 86,940,185ms（~24h）duration 行——README T-0 已澄清是关闭时机产物非真实时长，但**它仍会污染任何按 task_runs 做的统计**，且 08-28 起当日运行干脆不落 task_runs（新断链）。
- 资产表 7.9 万行 + kb 向量 + WAL 模式下单文件 DB 尚无性能压力，但 6 天 7.8 倍的膨胀斜率若无门控，一个月后 l2/coverage 全表扫描会成为瓶颈。

**判语**：单点工具性能工程良好；**系统级"产出/焦耳"极低**——每日 2 个任务 × 1h 预算 × 8 天 = 16 小时自动化预算，产出 high=0。性能问题本质是调度问题（预算烧在低价值资产上）而不是速度问题。

**建议**：① 任务收尾强制"预算消耗 vs 覆盖增量"记账进 handoff，连续 3 日低效自动触发 objective/队列复审（对应 T-6 自适应）；② 给 nuclei/l2 加"仅 level S/A/B + 存活"准入 WHERE，直接砍掉 ~84% 无效扫描面；③ 修 onnxruntime 显式线程参数消除启动开销。

---

## 4. 工具评估

**实测**：tools.d 27 个 manifest（nuclei/httpx/subfinder/dnsx/naabu/katana/ffuf/dalfox/sqlmap/arjun/crlfuzz/graphql-cop/gitleaks/trufflehog/semgrep/codeql/osv-scanner/waybackurls/gau/observer_ward/wafw00f/tlsx/afrog/fofa_search/echo-test/l2-collect + 1 个备份残留）。

**好**：manifest 驱动统一了 target_param/风险级/超时/沙箱，sec-pipeline 插件化后 8 个管线工具进了工具面（attempts_log/pipeline_validate/coverage_report/verify_replay 等），"脚本→工具"的治理方向正确。

**缺**：
1. **"20+ 装 5 用"未反转**（08-27 检查结论至今成立）：dalfox/sqlmap/arjun/graphql-cop/semgrep/codeql/gitleaks/trufflehog 均无日常消费记录。工具在库里 ≠ 在战斗里。
2. **httpx.yaml.pre-s2bak 备份残留在工具目录**——小事，但反映 tools.d 缺生命周期管理（对应 T-12 外还应有一条"工具 retirement 流程"）。
3. **缺的关键工具/能力**：CNAME 全量导出与外部指向筛选（T-3 依赖，dig/dnsx 有但无 pipeline 化）、wayback 历史接口对比（僵尸 API，T-2 配套）、favicon mmh3/fofa 猎捕（T-10，fofa_search.yaml 在但没有日常消费）、app 签名质量探测（T-13 前置）。
4. **工具产出→卡片反馈断链**：工具跑完不落 card_usage（0 条），哪张卡的规程被哪个工具执行了无数据，卡片 ROI 排行（T-4 月度）无米下锅。

**建议**：每个 manifest 加一个 `last_used_at` 记账（run_cli 写 meta 时顺带更新），季度清点直接按数据退役；T-3/T-10 的两个一次性高价值动作尽快 pipeline 化。

---

## 5. 架构评估

**好**（多数已在升级报告中实证）：
- **L1→L4 管线分层**（资产/接口/工具矩阵/确认）+ 变化雷达旁路 + 三条反馈回路，是文档体系里最成熟的部分；
- **领域数据与 DSH 存储完全解耦**（node:sqlite 单文件，rc 升级零被动改动实证）；
- **依赖反转的 memcore 旁路**（存储插件不感知治理层，缺席透传）——这是全体系最优雅的一个设计决策，实测 fail-open 验证过；
- **工具单入口**（sec-cli-adapter→CLI）与**浏览器单入口**（dsh-browser→流量总线）的两条"只有一条路"纪律，杜绝了旁路失控；
- 调度器自建（setInterval+SQLite 事务认领）不绑 DSH 内部 API，升级免疫。

**问题**：
1. **双记忆存储并存**：facts（1,057）与 blackboard（残 292 键）同时在写——objective 仍指示 `blackboard_set scan:...`，而新体系用 facts。"blackboard 只读观察期"实际上没只读。应设硬截止日切平。
2. **findings 与 facts 职责渗漏**：info 模板指纹进 findings（应落 fact/指纹表），而 finding 类事实（71 条）又镜像进 facts——同一漏洞两处落、口径不一（vuln_type NULL 99% vs facts 里 finding 类有内容）。
3. **调度可观测层断裂**：tasks.last_run_at 有值、task_runs 不再写入、results/<run_id>/meta.json 又是一份——三个真相源互不一致（08-28 当天：tasks 说跑过、task_runs 说没跑、results 说跑过）。应收敛为 task_runs 单一执行账本 + 修写路径。
4. **workspace 目录双份产物**（~/美团SRC/data|results|tmp 与 /opt/silkspool/dsh/data/results/）语义重叠，worker 在工作区写文件的范围没有边界约束（文档自己承认靠 scope-guard 兜底）。

---

## 6. 流程评估

### 6.1 资产收集

**实测链路**：subfinder/amass 枚举 → httpx 探活 → 入库分级 → l2-collect 接口面（bytedance 6,594 端点/913 参数 URL 已验证）→ surface-consume 参数队列（140KB）→ CT 雷达（certspotter 轮询，ct-seen 21-75KB/项目）。

**好**：变化雷达（CT 新子域每日有增量）、JS 发版监控、l2 接口面提取的"参数队列"思路（为批量 XSS/SQLi 提供弹药）都是对 SRC 实战有直接价值的资产化设计。

**断点**：
1. **收集无收敛门控**：6 天 7.8 倍膨胀（10,138→79,258），84% 无分级。资产收集从"攻击面地图"退化成了"子域字典"。缺：枚举→解析→探活→人工/模型分级→入攻击队列的五级漏斗，且每级有配额与淘汰。
2. **meituan 的 l2 面为零**（T-2 只做了字节单目标验证），两个项目覆盖不对称。
3. **负账本/egress-health（T-5）未启动**：DNS 伪造（keeta.com/mobike.com 区 NXDOMAIN）这类出口污染只能在 env-issue 里靠人注意，无自动化交叉验证。
4. **同主体扩张（ICP 反查/favicon hash/供应商生态，T-10）全部未启动**——当前资产的"广度"是子域枚举的广度，不是企业攻击面的广度。对美团/字节这种体量，真正的增量在生态侧（收购域/外包/供应链）而非主域子域第 5 万个爆破结果。

### 6.2 漏洞挖掘

**实测产出**：自动化 8 天 info 316/low 24/medium 1（Azure Functions host.json 暴露，08-23）；high 全部来自 08-20 手工战役（Supabase RLS 系列——说明**挖掘品味存在但未流程化**）。

**断点**：
1. **nuclei 通用模板 = 已被全网扫烂的面**。08-20 那批 high 全是"指纹联动人肉验证"（看到 Supabase→测 RLS→测 anon CRUD→提权）——这个"指纹→专项假说→验证链"过程就是应被卡片化/自动化的核心资产，但它还活在会话历史里，未变成 VC 卡（VC-032 反序列化/VC-022 AI 面都还没建）。
2. **参数队列（14 万字符）无消费者**：dalfox/sqlmap 首扫（T-2 配套）未跑，弹药囤着不打。
3. **无凭据 → 越权/逻辑面 0 覆盖**：SRC 实际 bounty 大头在逻辑/越权，当前体系对这块的贡献是 0（H-002 是第一优先级，判断正确）。
4. **每日 vuln 任务 objective 的"研究模式"条款**（100% 覆盖时必须产出 ≥3 条思路）设计很好，但实测 worker.log 显示时间烧在 nuclei 通用扫上，从未触发研究模式——覆盖 100% 的前提在 7.9 万未分级资产下永远不会成立，条款形同虚设。

---

## 7. UI 评估

**好**：
- 五视图（漏洞/资产/事实/任务/授权）+ 知识 tab + 报告只读 tab，信息架构覆盖了全部领域实体；
- "万物可跳"（行级 ctx.sessions.open 跳链）+ "详情在会话看"的信息架构纪律正确，避免看板变成第二个日志查看器；
- 授权视图带原子写+备份+审计+sync 协同提示，把最危险的操作做成了最安全的 UI；
- 服务端分页在 7.9 万资产规模下是必要的（做对了）。

**缺**：
1. **跳链数据断链**：#18 meta.json session_id=null，"新数据 100% 带 session"的验收承诺未持续成立——跳链 UI 在、数据不在，等于按钮焊死。
2. **无"今日产出"首屏**：看板没有回答运营者每天最关心的问题——"昨天自动化挖到了什么？台账动了几个格子？哪个 blocker 解锁了哪些卡片？"KPI 卡停留在实体计数，缺产出视角。
3. **findings 视图无信号分层**：info 洪水（88%）与 6 条 high 同屏无视觉隔离，看板复刻了数据库的噪声而不是消化它。
4. **台账/覆盖矩阵无一等公民视图**：coverage-latest.md 只躺在文件里，六态矩阵这个体系的"仪表盘中的仪表盘"反而没有 UI。

---

## 8. 对 DSH 的利用评估

**利用深度：好于典型第三方插件集成，多处打穿了文档面之外的能力**：

| DSH 能力 | 利用方式 | 评价 |
|---|---|---|
| 工作区（workspaceRegistry） | Program↔Workspace 1:1 绑定、调度 worker cwd=工作区自动归组会话 | 用法正确，"项目=工作区"单一概念收敛到位 |
| 会话上下文（exec.agent.id） | run→session 映射→看板跳链 | 设计对；实测 session_id=null 断链，需修 |
| 工具面（ToolRunContext/manifest） | 27 manifest + 8 管线工具 | 深度定制充分 |
| 组合树/profile/sidecars | 调度器收敛宿主面（sidecars:false）、fail-open 注入模式 | 对 cordis 生命周期的理解到位 |
| dsh-schedule | 主动判定"会话内提醒"语义不适用任务调度而自建 | **正确的负向决策**（多数集成者会硬塞） |
| dsh-browser fork | 流量总线→xray 被动 | 已用；但被动流量的内容级利用（flows 只存统计）是浪费 |
| 预览内部 API（slots/sessions inject） | 看板跳链 | 唯一脆弱面，已用深冒烟+pin 兜底，认知诚实 |

**未利用/欠利用**：
1. `ctx.jobs` 后台作业注册表——调度执行不进 jobs，UI/审计可见性放弃了一半（文档 §十自己列为"后续增量"，应提级，因为 task_runs 已断链，jobs 是现成的替补账本）；
2. 视觉模型做资产分诊（升级报告 §4.1 的 P12 提案）——7.9 万资产 + 9222 常驻浏览器在位，只差一个 manifest，是 DSH 能力利用的最低垂果实；
3. dsh-session-query-sqlite（trajectory FTS）——复盘检索底座"已在用"但无任何日常消费证据（worker 不检索历史会话）。

---

## 9. 对 DSH+pi 的利用评估

**架构判定正确**：pi-ai 作为 DSH 的 LLM 底座单轨、无双轨、无 pi-bridge——避免了双 LLM 栈漂移。spawn_worker 走 DSH headless（≤4 并发、只回尾部）与 pi-ai 多供应商路由+两级熔断组合，实测每日链稳定跑通 8 天。

**好**：
- 模型故障熔断 + headless 挂起看门狗（failover 只认显式失败）是踩坑后补的正确保险；
- token 账本（dsh-bill）在位；
- 开局 exp_search 检索 + 用卡回执（exp_feedback）写进了每个执行型 objective——记忆层与 LLM 层的接口设计干净。

**欠利用**：
1. **视觉通道零使用**（见 §8.2）——pi-ai 的 vision 模型对"资产视觉分诊/登录页识别/后台识别"是现成弹药；
2. **并发 web_search/子代理报告唤醒父任务**（rc.2 免费能力）未用于 intel_hunt 的情报驱动象限；
3. **预算语义粗糙**：3600s 时间顶是唯一硬约束，无 token 预算/成本预算双维度，"贵模型烧在低价值判断"无法被发觉；
4. spawn_worker 的"只回尾部"在长任务下会截断中间关键证据——子代理结构化产物（写文件+回 path）的纪律只在部分 objective 里出现。

---

## 10. 提示词纪律评估

**设计层（好）**：
- 五公理优先级明确（流程可靠>无证据不结论>万物进化>保底+自由>格式刚性内容开放）；
- 防幻觉十条含金量高：CLEAN 同级举证、detect/verify 分离、双出口复现、机械复核（hash 重放才标 src_ready）、对抗性复核（独立会话证伪）、负例即价值——这套纪律若真被执行，产出可信度有保证；
- B2 去重方向正确（纪律归技能单一事实源，objective 引用不内联）。

**执行层（三个实测反例）**：
1. **objective 仍然臃肿**：#18 的 objective 实测 ~2,600 字，包含完整工作流 10 步+派单纪律+记忆纪律——"每日 04:00 执行、scope.yml 唯一权威、interval 禁自续排、代理池纪律、覆盖优先级、研究模式条款…"全部内联。B2 宣称 70% 精简的是旧任务，P13 新任务又长回来了。**纪律的单一事实源在实际调度内容里没有成立**。
2. **提示词约束 ≠ 行为**："完成一个目标立即落台账一行"、"每次使用落 card_usage"、"收尾六查"、"研究模式 ≥3 条思路"——实测全部 0 执行。提示词对 agent 的行为塑形在 1 小时高强度任务里让位于"把时间花在扫描上"的局部最优。**结论：产出纪律必须下沉为代码守卫（工具层校验），不能停留在 objective 措辞。**
3. **收尾 note 格式纪律**（【项目·角色·MMdd】）执行了（tasks #16-#19 note 可辨识），这是提示词纪律少数生效的点——因为它简单、单一、无依赖。

**校准建议**：objective 控制在 300 字内（只留：目标、当日硬指标、红旗禁令、三句话工作流），其余全部进 sec-pipeline 技能；每个"必须 X"条款要么配工具级强制（不做 X 就交不了差），要么从 objective 删除——**提示词里不应存在无力执行的律令**，那是纪律通胀的源头。

---

## 11. 自学习流程与方法评估

**架构**（memcore + 卡片体系）：五原语（validateWrite/visibilityFilter/transition/recordSignal/sweep）、candidate→active 双通道晋升（评审加速+自动托底）、评分公式、cooling/自愈复活、fail-open——设计在同类自建系统里属于第一梯队，"复盘是加速器不是单点"的容错哲学尤其正确。

**实测运转**：
- sweeper 6h 正常、AGENTS.md 受管区块自动生成正常、objective lint 首跑 12 命中后修掉了 4 个 interval objective 的易腐事实——**止血和基架是真的在转**；
- 但语义层产出：exp_cards 2 张 active、playbooks 20（1/3 是 diag 垃圾）、exp_feedback 回执 0 条实际记录、kb 回流 224 张后无标注消费、vault 双向桥导出 2 卡——**"学习"的进料（每天 16h 自动化运行）与出料（2 张卡）严重失衡**。

**根因**：
1. 每日任务的"蒸馏检查"步骤（objective 第 8.5 步）排在预算耗尽之后——3600s 打满时蒸馏永远没机会执行（实测 duration=3600221ms 佐证）；
2. recordSignal 的信号源（exp_search 命中+1、exp_feedback 回执）依赖 agent 自觉回执，无代码埋点；
3. 周复盘（#24）单点承载碎片合并/质量审计/卡片评审，而它上周日 05:00 的运行无产物可查。

**改进**（按杠杆排序）：
1. **把蒸馏从收尾挪到中段**：objective 强制"每完成 1 个目标的验证链，立即评估是否 exp_store/pb_save"，而不是攒到收尾；
2. **信号埋点代码化**：exp_search 工具返回行时自动 recordSignal(searched)，卡片被 objective 显式引用时自动 adopted——不依赖回执自觉；
3. **复盘产出物化**：#24 每周运行必须落 review-YYYY-Www.md（评审了哪几张卡/合并了哪些碎片/数据对比），有产物才算跑过；
4. 08-20 的 Supabase RLS 战役必须 retro 成卡（"云数据库指纹→RLS→anon CRUD→提权链"是全体系最有价值的未沉淀知识）——这是对"自学习是否有货"的试金石。

---

## 12. 卡片与沉淀物质量评估

| 沉淀物 | 数量 | 质量 | 缺口 |
|---|---|---|---|
| VulnCard | 17 active/draft + 16 规划 | **高**（schema 完整、falsification/retest/src_notes 实战向） | 使用记录 0、deviation 0、无一张卡被实战迭代过 v2+（VC-001 v3 是手工战役产物） |
| IdeaCard | **0**（仅模板） | — | "自选动作 ≥3 条 IdeaCard"从未兑现；发散八角度无产物 |
| MethodCard | 0 独立实体 | — | 工具技巧散落在 playbooks（tool:nuclei 31/26 是唯一健康样本） |
| PatternCard | 0 | — | 厂商体质画像（T-11 季度项）未启动 |
| 经验卡 exp_cards | 2 active | **高**（#3 探活基线分类 adopted=27 是真金） | 供给断粮（见 §11） |
| playbooks | 20 | 参差（diag2/diag3 垃圾混入） | 无清理纪律执行 |
| kb_docs | 254 | 未验证 | taintguard 标注后无消费证据 |
| 台账/覆盖 | dsh-ops 2 行 | — | 双项目 0 行（见 §10） |
| handoff/brief | 模板 2 份 | — | 实例 0 份 |
| 报告 | 每日 1 份 | **低**（模板噪声 64 条/份，无信号分层） | 无"今日值得人看的 3 件事" |
| vault 沉淀 | 2 卡 + 18 文件 | 中 | 单向为主，回流无消费 |

**判语**：**卡片 schema 是资产，卡片库不是**。17 张卡的规程质量足以支撑实战，但"使用→偏差→升版"的进化回路零数据，卡片体系当前只是静态文档库。最紧急的一件事：让 pipeline_validate/attempts_log 工具在收尾时**硬校验**台账行数>0，否则任务不可标 done——一行代码能救活整个沉淀体系。

---

## 13. 生成流程合适性评估

评估对象：P13 双链（recon 03:00 → vuln 04:00）及其产物生成流程（brief→执行→台账→coverage→handoff→report→蒸馏）。

**合适**：
- recon→vuln 的先后依赖正确（先探活建图再挖）；latest-only 不补跑符合日常运营语义；
- brief（开局盘点：asset_stats+覆盖台账+S/A 优先）→ 执行 → 收尾六查的骨架是标准 PDCA，方向无误；
- "规定动作+自选动作（20% 探索配额）"的预算分配结构正确。

**不合适/失衡**：
1. **时间预算与任务宽度不匹配**：30-60 分钟窗口 vs "7.9 万资产覆盖 100%"的隐含目标——任务结构上注定烂尾。应改为"每日 Slice"：从覆盖矩阵取 top-N BLOCKED/PENDING 格子作为当日硬指标（数量化、可完成），而不是开放式"覆盖面目标"；
2. **产物生成顺序颠倒**：report_build（第 8 步）在台账落行（不存在的一步）之前——报告先于证据账本生成，必然产出"64 条模板噪声"式的无根报告。正确顺序：台账→coverage 重算→handoff→报告（报告只引用台账终态）；
3. **双项目串行 03:00/04:00 但预算相同**：美团 2.6 万资产 vs 字节 5.3 万资产用同样的 1h 预算，粒度失当——应按队列深度/资产分级动态分预算；
4. **每日报表内容无消费者适配**：现在只有一种日报（全量表格），缺三种视图：给人看的摘要（3 件事）、给复盘看的偏差清单、给提交用的草稿。

---

## 14. 补充维度评估（10 项）

### 14.1 可观测性与可审计性 ★★☆
task_runs 断链（08-28 运行未落库）+ 三真相源不一致 + worker.log 几乎无业务日志（被 onnxruntime 噪声淹没）+ 报告无信号分层——"系统在干什么"只能靠翻文件拼凑。audit.jsonl 与 scope 校验的审计是好的，但**运营可观测**（调度健康度、产出率、预算消耗率）没有仪表。建议：sec-suite 加 `/silksec-dashboard` 的 ops 视图：任务成功率、next_run 漂移告警、台账增量、卡使用数——五个数字一屏。

### 14.2 安全与合规护栏 ★★★★
fail-closed+解析后校验+bwrap+审计+retention 实测在位，红线纪律（拖库凭据/真实用户账号/破坏性 payload）写入 objective。持续欠账两件：egress-guard 网络层出口白名单（S9 运行期供应链约束缺口）、Authelia forward-auth（S6 公网弱认证——3080 边缘只有密码，这是全平台当前最大的单点安全风险：拿到密码=拿到全部 SRC 凭据+内部漏洞数据）。建议把 S6 提到 P15 首位。

### 14.3 数据治理与质量 ★★☆
空 level 66,779 / 空 category 10 / 空 vuln_type 353 / 垃圾 playbook / _legacy 106 未清 / 双记忆存储并存 / findings 噪声 88%。缺一个**每周数据质量守卫**（SQL 断言集：空值率、孤儿外键、_legacy 增量、双写偏差），进 #24 周复盘。

### 14.4 可靠性工程 ★★★
升级保护/备份 timer/恢复脚本齐备（好）；但 T-0 调度漂移 4 天未修（明日部分任务将跳跑）、readonly-db env-issue 挂着影响 worker 写库、task_runs 写路径坏了没人发现（直到本次评估）——**故障自愈有了，故障自察没有**。建议：ct-watch 同款"调度健康 watchdog"：next_run 漂移 >25% 周期、task_runs 断写、台账 0 增量，任一命中即黑板 env-issue + 看板横幅。

### 14.5 成本与资源效率 ★★★
LLM 账本在位（dsh-bill）；代理池自建轮换+评分+坏代理上报闭环成熟（出口实测可达）；token 双预算缺失（见 §9）。LXC 内 embedding 线程亲和问题小而烦。总体：成本可见但不可控。

### 14.6 知识供给与情报运营 ★★☆
kb 254 张回流是存量；intel_hunt/指纹→N-day 链路在但指纹仅 87 条；T-11 的周/月/季情报节奏（JD 情报/技术博客/厂商体质/范围变更监控/查重）零启动。对 SRC 竞争性挖掘，**情报是杠杆率最高的维度**（新纳入范围抢首发、活动期加权），当前完全空白。

### 14.7 人机协同 HITL ★★☆
shared-browser（9222 人机共用+登录态持久化）是好设计；但 chicheng-push 未装 → intrusive 审批/高危确认只能人坐电脑前，HITL 断点实际不可达（半夜跑出的 high 没法推给人确认）。Matrix 通知（Bellkeeper 桥）也未接入本体系。

### 14.8 评测与回归体系 ★★☆
Vulhub 靶场 + eval-run.js + eval-live 打标在位，回归意识好；但靶场 6 资产规模太小，覆盖不了卡片库的 17 类漏洞形态；eval-live.jsonl 无近期数据——活评测没有日常运行。建议：每张新卡入库时在 Vulhub 对应场景跑通一次 detect/verify 作为验收（卡片 CI）。

### 14.9 文档-现实偏差度 ★★（需警惕）
README 质量很高，但实测存在系统性"提前 declaring"：B2 说 objective 精简 70%（新任务又长回 2,600 字）；"台账六态落行"作为 T-1 验收项写在纸面（实际 0 行）；"每次使用落 card_usage"（0 条）；"执行历史自动落 task_runs（看板可见）"写进 #18 objective（当日未落）。**偏差模式一致：把"机制上线"当成"机制生效"。** 建议 README 增加一节"纪律健康度"（每次迭代末跑一次本报告 §0 的取证脚本，数据说话），并把"验收"定义为"连续 N 天有产物"而非"功能已部署"。

### 14.10 SRC 提交链路 ★
dedup 查重、平台模板转换、活动期策略、报告措辞（放大面/影响量化）全部未建。08-20 那批 high 若已提交，其报告措辞资产（RLS 缺失+数据量量化+提权放大）应沉淀为提交模板。当前"挖到→提交"靠人，链路断裂在最后一公里。

---

## 15. SRC 挖掘能力提升建议（路线图）

### 15.1 诊断总纲

当前体系是"**平台先行、纪律空转、产出待爆**"。8 天自动化的教训：覆盖不是产出，工具在库不是工具在手，机制上线不是机制生效。提升路线遵循一个原则：**每一分新增投入必须直接缩短"从资产到可提交报告"的路径**。

### 15.2 P15「纪律落地」周（最高优先，全部是代码活）

| # | 动作 | 解决 |
|---|---|---|
| 1 | **流程守卫**：task 收尾硬校验——attempts 台账当日增量>0、card_usage 落行、handoff 文件存在，任一缺失任务不可 done + 看板红条 | 台账/卡/交接全部 0 的死结 |
| 2 | **findings 噪声闸门**：info 级默认落 facts/指纹表不进 findings；同模板+同目标 7 天去重；报告只列 high/medium+新增 low | 88% 噪声淹没 |
| 3 | **资产准入**：未分级资产禁入主动扫描队列；跑一次批量分级（httpx 标题/指纹/视觉三路合成 level）；_legacy 清零 | 84% 空级资产摊薄预算 |
| 4 | **修三断链**：task_runs 写路径、session_id 捕获、调度重锚定（T-0）| 可观测地基 |
| 5 | **H-001 OOB + H-002 凭据**推进（人工侧，agent 代办接入）| 解锁盲类+越权两大卡片族 |

### 15.3 P16「产出转化」双周

1. **把 08-20 战役 retro 成卡**：Supabase RLS→anon CRUD→提权链做成 VC-034（云数据库面），配合指纹 fp 联动自动化——已证明能出 high 的路径先自动化；
2. **T-3 子域接管全量首扫**（一次性高价值，6,309+3,546 域 CNAME 外部指向筛选）；**T-2 配套的 dalfox/sqlmap 首扫**打掉 14 万字符参数队列存货；
3. **视觉分诊 manifest**（P12 提案落地）：9222 浏览器截图→vision 模型→page_type/has_login/interesting 写 facts——给 7.9 万资产装上"值得打"的过滤器；
4. **每日 Slice 化**：vuln 任务改为"今日硬指标=消化覆盖矩阵 top-10 BLOCKED 格子 + top-20 PENDING"，完成即胜，剩余时间进研究模式（原条款此时才真正可触发）；
5. **SRC 提交半自动化**：finding CONFIRMED→生成平台模板草稿（含复现步骤/影响量化/放大面）+ dedup 检索，人只做最终审校。

### 15.4 P17「深度与情报」月

1. **凭据到位后的越权产线**（H-002 解锁后）：authz_diff 双账号差分批量跑 VC-008/VC-017——SRC bounty 主战场；会话管理专项（VC-033）；
2. **企业面扩张**（T-10）：ICP 备案反查同主体、favicon mmh3 fofa 猎捕、供应商/被收购方发现（股权/备案/JD）——对美团/字节体量，生态侧资产密度远高于主域子域；
3. **情报节奏**（T-11）：周（范围变更监控+新纳入抢首发+提交查重）、月（JD/博客/PPT→指纹与 IdeaCard）、季（厂商体质画像→优先级权重）；
4. **白盒试点**（T-9）：semgrep+模型审计字节开源组件（coze-studio 等）→PatternCard 横向扫线上版本；
5. **卡片 CI**：新卡入库必须在 Vulhub 对应场景过 detect/verify 验收；playbooks 垃圾清理进周复盘。

### 15.5 持续机制（嵌入现有周复盘 #24）

- 纪律健康度五指标看板化：台账日增量 / card_usage 周增量 / IdeaCard 月增量 / handoff 生成率 / next_run 漂移；
- 卡片 ROI 月排行（hit/usage/fp）→ 头部加资源、尾部废止（T-4 已规划，需数据来料）；
- 数据质量 SQL 断言集（§14.3）；
- 文档-现实校验脚本（§0 取证命令固化，迭代末必跑）。

### 15.6 一句话战略

**从"扫全量"转向"打重点"**：用分级+视觉分诊+情报把 7.9 万资产压缩成每天真正值得打的 50 个靶标，用代码守卫把纸面纪律变成不可能不执行的流程，用 OOB+凭据解锁两大高价值卡片族，用"指纹→假说→验证链"的卡片化复制 08-20 手工战役的成功模式——这条链打通后，"每日链"才从扫描器变成真正的漏洞挖掘系统。

---

## 16. 结论

SilkSecAgent 的**平台工程**（架构/合规/记忆基架/升级保护/防幻觉设计）达到自建安全自动化平台的第一梯队水准，多个单项设计（memcore fail-open、卡片 falsification、升级深冒烟、scope fail-closed 全链）可以直接作为方法论输出。

但 2026-08-28 的运行时实况是：**纪律性设计几乎全部停留在文档层**——台账 0 行、卡使用 0 条、IdeaCard 0 张、handoff 0 份、task_runs 断写、next_run 漂移未修，而 8 天自动化产出的 high 为 0。体系当前的真实能力 ≈ "一个治理良好的扫描器编排平台"，距离"持续产出可提交漏洞的挖掘系统"还差最后也最关键的一层：**把纪律从提示词搬进代码，把覆盖从数字变成格子，把 08-20 的挖掘品味变成卡片。**

P15 五件事（流程守卫/噪声闸门/资产准入/断链修复/OOB+凭据）预计一周内可全部落地，且每一件都有实测数据佐证其杠杆——建议按此顺序立即开工。

---

*证据快照：本报告 §0 表格中全部数字取自 2026-08-28 spool exec csai 实测；历史对比基线取自 doc/secagent/README.md 与 dsh-upgrade-0.1.1-rc.2-report.md 的 08-22/08-23 记录。*
