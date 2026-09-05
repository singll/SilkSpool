# SilkSecAgent SRC 漏洞挖掘体系 · 持续推进文档

> 版本：v3.5 · 2026-09-05（由设计规范 v2.1 + 人工待办文档合并而来，为唯一持续推进入口）
> 性质：Living Document。历史设计文档与实施报告见本目录其他文件；本文档只保留**当前状态、待办、未完成的详细内容、工作规范**。
> 体系运行位置：csai `/opt/silkspool/dsh/`；版本受控源文件在 SilkSpool 仓库 `bundles/dsh/templates/`。
> **系统是什么、怎么转**（插件/脚本/流程/提示词/状态机/DSH+pi 架构完整解剖）见 [silksecagent-system-complete.md](silksecagent-system-complete.md)。

---

## 目录

1. [当前状态速览](#一当前状态速览)
2. [待人工事项（Human Action Required）](#二待人工事项human-action-required)
3. [待推进清单（未完成，详细）](#三待推进清单未完成详细)
4. [体系工作规范（执行层参考）](#四体系工作规范执行层参考)
5. [已完成记录（里程碑日志）](#五已完成记录里程碑日志)

---

## 一、当前状态速览

**系统在跑什么**（csai，全部已验证）：

- 双项目每日链路：recon 03:00 → vuln 04:00（interval 任务 #16/#17/#19 + #37，objective 已 Slice 化硬指标 + sec-pipeline 规范）
- **DSH 平台版本**：0.1.2-rc.1（2026-09-04 从 0.1.1-rc.2 升级，详见 `dsh-0.1.2-rc.1-upgrade-plan.md` §十）；**0.1.3-alpha.1 不升**（SessionHandle 破坏性变更 + 官方性能回退，升级前置=两处 sessionPersistence 重写）；每次升版必做：重打 dsh-llm-deepseek reasoning_content patch + 确认 node_modules 属主；`dsh-version-watch.sh` 每日监控 dist-tags.latest
- 数据规模（2026-09-04）：assets **80,648** / endpoints **103** / findings **64**（信号面 9 + 待验证候选 55）/ facts **1,096**（可见域 1,096，排除 note 速记 630）/ blackboard **43** 键（timeline/ephemeral 兼容层）/ tasks **20** / approval_requests **4**（待审批 1）
- 台账体系：`data/pipeline/{program}/attempts-*.tsv`（六态）、`endpoints-*.tsv`（接口面）、`radar-queue.jsonl`（变化雷达）
- **流程守卫（P15）**：interval 日任务标 `done` 前引擎硬校验纪律产物（台账 24h 增量 / card_usage / handoff-{date}.md），缺失即拦截——纪律不再依赖提示词自觉
- **噪声闸门（P15）+ 完整性闸门（v4.2）**：info 级模板指纹自动打 `noise=1`；缺复现步骤/影响或标题<10 字符的登记一律归「待验证候选」——漏洞列表只呈现经 LLM 验证流登记、字段完整可复核的信号（机器直灌不冒充漏洞），补全后重登记可就地升级
- **统一审批中心（v4.3 + v4.4 判据结构化 + v4.5 整域通配与异步化）**：`approval_requests` 通用表 + `APPROVAL_KINDS` kind 注册表，现 4 种 kind——`scope-wildcard`=**整域授权**（subject=裸 apex，如 catpaw.com；批准写回 `["*.example.com","example.com"]` 双条目 + 种子任务，判据仅限 控股/全资 或 收购/财团，evidence≥30 字主体核证级；v4.5 新增，根因=09-04 批准的裸 apex 无通配、次日 recon 对 www 子域照样被拒）；`scope-domain`=**单子域授权**（subject=完整子域，evidence≥30 字具体归属证据；apex 提请会被 validate 拒绝并引导改提 scope-wildcard）；`exclude-exception`=排除例外评估（批准=移出排除+并入 scope+durable fact）；`tool-intrusive`=**侵入工具放行**（v4.5 异步审批：runCli 遇 intrusive 被拒自动落库带工具/参数/目标，批准写项目 `rules.allow_intrusive_tools` 白名单，下个调度周期重试自然放行，agent 不重试）；`task-budget-extend`=**任务预算延长**（v4.5：worker 跑满 3600s 被杀时 scheduler 自动提请，批准写 tasks.budget_timeout_sec≤7200，下周期 runWorker 取 max）；agent 工具 `approval_request` 提请，看板「审批」tab 渲染判据/工具/预算 chip；批准前 fail-closed 不变
- **srcskill 实战先验吸收（v4.4，两批完成）**：首批 `rules/src/equity-gate.md`（股权范围闸：五档判据口径 + 默认不入池 + 独立SRC判定 + 人工判例表含 H-004 zhaopin 教训）+ `rules/src/technique-index.md`（打穿短表 87 行，开局先扫「认什么」列对现场特征）+ sec-pipeline 插件接线；第二批知识库 46 篇手法模块全量导入 `rules/techniques/`（idor/ssrf/xss/…详解层）+ 2 篇方法论 `rules/srcskill/`（dig-scope-workflow / vuln-report-format，引用路径已改写），rules 总量 56 篇；**可见性补齐**：知识 tab「静态先验 rules」分区（rulesList/rulesRead 只读两件套）+ vault `静态先验/` 子树同步 keeper
- **事实治理（v4.3）**：countFacts/factSearch 同口径（行数=总数）；看板事实 tab 默认隐藏 note 速记 + 生命周期 facet（长期/时效/时间线）
- **报告（v4.3）**：buildReport 按 severity 多选/source 筛选生成、按项目分节、文件名语义化；报告列表按项目分组可筛
- **资产准入（P15）**：未分级资产禁入主动扫描队列（`asset_query level_in=S,A,B`）；全库已分级（grade-assets，域外参考站保持 NULL 永不进队）
- **FGS 决策图（P17 + v4.5 跨任务沉淀）**：`fgs_nodes` 表与 `fgs_add/update/list/next/export` 工具已落地，scheduler 在任务 prompt 中注入 FGS 使用说明；**v4.5 起任务 done 时 fact 类节点自动沉淀为 durable facts**（fact_key=`fgs/{task_id}/{node_id}`，幂等刷新 last_validated_at）——FGS 不再是一次性记忆，决策链结论跨任务可检索（看板知识 tab 体检视图显示沉淀数）
- **知识体系自进化（v4.5）**：① kb 消费端激活——调度任务 prompt 注入 kb_search 检索指令 + AGENTS.md 受管区块检索建议段（278 篇 kb_docs 此前 268 篇 uses=0 死库存）；② 知识体检视图（memcore status().knowledgeHealth → 看板知识 tab 顶部：各存储点 count/零使用占比/到期预警）；③ kb revalidate_by 导入时 ±15 天抖动 + 存量同日到期回填散布（防 2026-11-23 集体塌方）；④ memcore sweep 三处死循环治理（vault-export 命中授权域的卡自动 exportable=0 降级不再刷日志、objective-lint 排除终态任务、lint 命中 done 任务#4 的刷屏根除）
- 漏洞卡注册表：`data/vulncards/`（18 张卡，含 VC-034 Supabase 开放数据面 = 08-20 战役 retro）
- 脚本：`scripts/pipeline/`（l2-collect / surface-consume / js-watch / ct-watch / pipeline-validate / coverage-report / verify-replay / **grade-assets / data-quality / discipline-audit**）
- 常驻服务：`ct-watch.service`（CT 新子域雷达，certspotter 轮询，30min 间隔）、xray 被动 7777、mubeng 代理池 8899
- 技能：sec-pipeline（流水线纪律+守卫+五要素登记）+ sec-runtime-discipline（9 条公共纪律）+ 原有 sec-verification/sec-task 等
- 新工具：`vision_triage`（截图→视觉模型分诊）、`submission_draft`（CONFIRMED→SRC 提交草稿+查重）、`approval_request`（统一审批提请）、`data_quality`/`discipline_audit`/`grade_assets`（治理 CLI，均已 manifest 化）
- 看板：`ops` 端点（纪律健康度五指标，告警时顶部红条）+ 十视图（含统一审批 tab，待审批数进徽章）
- **代码与数据清理**：2026-09-01 批次修复 scheduler `session_id` 回填缺失、scope 首次创建崩溃、pipeline 输出格式/覆盖矩阵 bug、parser 静默失败；清理 407 条孤儿资产、235 条外部/孤儿端点、310 条噪声 finding、17 条旧版一次性任务、20 条过期 blackboard 日更日志，facts 归属归一化

**当前最大瓶颈**（按解锁收益排序）：

1. **无凭据** → 越权/逻辑/登录态面全部 BLOCKED（H-002）
2. **无 OOB** → 盲 SSRF/盲注/盲 RCE 物理上不可测（H-001，公网 NS 委派必须域名服务商操作）
3. 高价值面多为登录态后（美团 carrier proxy/admin.erp、字节 saiyan/live_console/火山 ark）

**下一看点**：下一日 Beijing 03:00/04:00 interval 任务自动续排；FGS 图待首次产生运行节点。

### 纪律健康度速查（文档-现实校验，每次迭代末必跑）

```bash
spool exec csai "python3 /opt/silkspool/dsh/scripts/pipeline/discipline-audit.py"   # 五指标+告警
spool exec csai "python3 /opt/silkspool/dsh/scripts/pipeline/data-quality.py"       # SQL 断言集
```
看板等价：`ops` RPC 端点（健康时静默，脱节时顶部红条）。判据：**机制上线 ≠ 机制生效，连续 N 天有产物才算生效**。

---

## 二、待人工事项（Human Action Required）

> 新增待办按格式追加；完成後移入「已完成记录」。每日 handoff 的「阻塞与求助」段引用本表编号。

### H-001 OOB 带外域名 NS 委派 【P0】

- **解锁**：VC-009 SSRF 及全部盲类卡片的 `BLOCKED(tool-missing)`（盲 SSRF/盲 XXE/盲 RCE/异步回调）
- **待做**：
  1. 选定 OOB 专用域，建议 `oob.singll.net`
  2. DNS 添加：`ns1.oob.singll.net` A → `141.11.43.99`；`oob.singll.net` NS → `ns1.oob.singll.net`
  3. 告知 agent 域名已生效
- **现状**：interactsh-server v1.3.1 已部署 `/opt/silkspool/dsh/oob/`，unit 备好（`interactsh.service.prepared`，域名占位符 `OOB_DOMAIN_TBD`）
- **做完后接入**（告知域名即可，agent 代办）：
  1. unit 替换域名 → `/etc/systemd/system/interactsh.service`，`systemctl enable --now interactsh`
  2. 防火墙放行 53/udp、53/tcp、8088/tcp（8443/8025/8389 可选）
  3. 自验证：DNS 查询 `test-<random>.<域名>`，interactsh 日志出现记录即通
  4. 相关 `BLOCKED(tool-missing)` 台账条目转 PENDING；payload 回连标识编码 run_id（`{run_id}.<域名>`）

### H-002 SRC 测试账号注册（双项目成对凭据）【P0】

- **解锁**：全部 `BLOCKED(no-credential)`——VC-008 越权、VC-017 业务逻辑、登录态后 huntlist（美团 carrier proxy/admin.erp/lbs/keeservice；字节 saiyan/live_console/ark）
- **待做**（每项目至少成对 2 个账号，水平越权必需）：
  1. 美团 C 端主账号 ×2（手机号，unitivelogin SSO 一号通）
  2. 字节/抖音 C 端账号 ×2 + 火山引擎个人试用 ×1-2（解锁 ark/console）
  3. 可选：美团开放平台开发者、Keeta 海外（邮箱即可）、coze/Trae 账号
- **红线**：仅用自注册/官方试用账号；绝不用拖库凭据；测试只操作自建数据
- **做完后接入**：
  1. 凭据入 DSH credentials 表（**不写明文进台账/报告**）
  2. 告知 agent 哪些系统有凭据 → agent 关联 scope.yml rules + 记 `cred:<system>` 黑板指针
  3. 首次登录需人配合一次（扫码/短信），之后 shared-browser profile 持久化 + xray 7777 代理链自动维持
  4. `BLOCKED(no-credential)` 批量转 PENDING，按优先级队列消化；VC-008 启用 authz_diff 双账号差分

### H-003 存量 findings 回填 vuln_type 【已完成 2026-08-28】

- ✅ 全部 findings 已按关键词映射回填（vuln_type+cwe），`data-quality.py` 断言 0 缺失；后续新 finding 由噪声闸门+objective 字段要求保持覆盖。

### H-004 待审批：zhaopin.com 授权边界确认【2026-09-04 提请】

- **是什么**：审批中心（看板「审批」tab）待审批 1 条：`zhaopin.com` 提请加入 meituan-src 授权（审批 #2）。
- **归属证据**：智联招聘 2021 私有化财团由红杉中国与美团牵头（美团控股）；meituan.com 下有 ide.zhaopin.meituan.com 等 126 个内部部署域印证。
- **⚠️ 需人工确认的边界**：智联招聘**或另有自身 SRC 归属**（第三方 SRC 平台可能有独立收漏洞渠道）——批准前请确认其归属边界，避免越权测试。
- **操作**：看板「审批」tab → 批准（自动加入 meituan-src scope）或驳回（附原因）。

### H-005 存量待审批子域三条处理【2026-09-05 提请，v4.5 部署后处理】

- **是什么**：09-04 批准的 catpaw.com/tabbit.com/wow.fun 只落了裸 apex（当时无 scope-wildcard kind），次日（09-05）recon 任务对 `www.catpaw.com` 等子域探活被 fail-closed 拒绝，agent 补提了 3 条子域级 pending 审批（#6/#7/#8，www.catpaw.com / www.tabbit.com / www.wow.fun 类）。
- **v4.5 部署后的正确处理**（二选一）：
  1. **推荐**：看板驳回 3 条子域请求（备注"改提整域"）→ 人工按整域归属分别提 `scope-wildcard`（catpaw.com / tabbit.com / wow.fun，equity_basis 按实际控股关系选 控股/全资 或 收购/财团）→ 批准后 `*.x.com + x.com` 双条目入 scope，全子域一次覆盖。
  2. 或：直接批准 3 条子域请求（只覆盖单子域，下个子域还会再提——不推荐）。
  3. 也可以让 agent 在下个周期重新提请（v4.5 的 approval_request 工具描述已教判定口径），但人工看板直提更快。
- **配套**：处理完 `spool sync pull csai` 回收 scope.yml 管理机副本；若按方案 1，批准动作会自动入队 `[审批入队]` 种子任务（首轮全子域资产收集）。

---

## 三、待推进清单（未完成，详细）

> 按建议顺序排列；完成一项移入「已完成记录」。

### T-0 调度异常调查与修复【已完成 2026-08-28】

- ✅ 根因修复（三处，代码级）：① taskClaimDue 认领时 `started_at=COALESCE` 永不清零 → 已改为每次认领刷新；② taskReapStale 默认 1h 宽限与 3600s 超时同量级 → 改为超时+15min，且 last_run worker 进程活着即跳过回收（防双重派单）；③ task_runs 记录失败从静默改为 stderr 可见。
- ✅ next_run 已重锚定（#16/#17→北京 03:00、#18/#19→北京 04:00，ops 断言 drift=0）。task_runs 的历史 duration_ms ~24h 行是旧 bug 产物，统计时剔除即可。

### T-1 验收 P13+P14 运行质量（每日）

- 检查 attempts 台账是否按六态落行、N/A 和 BLOCKED 是否带理由、handoff 是否生成且数字一致
- 发现执行偏差 → 修订 sec-pipeline 技能或任务 objective（deviation 即卡片/规范升版原料）
- 连跑 3 天稳定后，把「P13 规范」标记为正式机制

### T-2 L2 接口层全量铺开

- l2-collect 已对单目标验证（6593 端点/目标），需对两项目全部存活 web 资产（美团 127 + 字节 276）铺开
- 纪律：单批 ≤3 目标/≤600s，逐日增量；产出 endpoints.tsv 后跑 surface-consume queue 建参数队列
- 完成后 dalfox/sqlmap 首次批量跑（VC-004/VC-005 卡规程，限速止损）
- 配套：endpoints 做僵尸 API 时间维对比（wayback 历史有而当前"消失"的接口优先测）

### T-3 子域接管全量首扫（VC-002）

- 全量 CNAME 导出（美团 6309 + 字节 3546 域）→ 外部指向筛选 → nuclei takeover + 人工复核
- 一次性的高价值动作，从未做过

### T-4 每周评审机制

- 固定动作：词表合并（na_reason/blocker 新值）/ draft 卡晋升评审 / deprecated 清理 / STALE 风暴检查 / IdeaCard first_testable_when 检查
- 每月加：卡片 ROI 排行（hit/usage/fp 三率）→ 头部加资源、尾部废止评审
- 候选落点：挂在现有「每周知识复盘与记忆治理」任务（#24）里加一个段落

### T-5 出口×目标健康矩阵 + 负账本洗白

- egress-health.tsv 台账进日常探测流程；负向结论（封闭/死亡）须 2 出口交叉验证
- 负账本条目 30 天有效期 + 每日 5% 抽查复验

### T-6 预算自适应

- 连续 3 日零产出 → 探索配额 20%→40% + 强制换发散角度 + 评审是否扩 scope；连续高命中 → 反向收紧
- 落点：brief 生成逻辑

### T-7 凭据到位后的启用链（依赖 H-002）

- 浏览器挂 xray 7777 → katana 带会话全功能爬 → authz_diff 双账号差分 → VC-008/VC-017 批量执行
- 会话管理专项（VC-033 待建）：fixation/登出失效/改密后会话/并发控制

### T-8 OOB 到位后的启用链（依赖 H-001）

- VC-009 SSRF 全参数面回扫；盲类 payload 模板（盲注/XXE/RCE 回连）进卡片库
- 回连标识 run_id 编码 → 命中自动回填 attempts

### T-9 白盒审计试点（0day 路线）

- semgrep + 模型对字节开源组件（coze-studio/deer-flow 等）源码审计 → 查线上部署版本
- kb 224 篇作为审计模式库；产出 PatternCard 横向扫其他组件

### T-10 资产源扩容日常化

- ICP 备案反查（同主体全域名）、favicon mmh3 hash fofa 猎捕、被动多源（uncover/fofa API）
- 二级/生态资产：供应商/外包/被收购方（从股权/备案/JD 发现）
- "diff=0 多日"伪收敛警惕：多源并行后才允许下收敛结论

### T-11 情报与平台运营

- 月度：招聘 JD/技术博客/会议 PPT 情报 → 指纹库 + IdeaCard
- 季度：厂商体质复盘（历史公开漏洞聚类 → PatternCard 画像 → 喂优先级权重）
- 每周：SRC 范围变更监控（新纳入抢首发）、提交前查重（dedup.md 进证据包）、活动期集中提交
- 提交稿自动化：reproduce.md → 平台模板

### T-12 待建卡片（注册即用，按 §四卡片规范建）

VC-006 CRLF / VC-010 GraphQL / VC-011 JWT / VC-012 OAuth-SSO / VC-013 文件上传 / VC-017 业务逻辑 / VC-018 中间件暴露 / VC-022 AI 应用攻击面（coze/ark 在 scope，竞争极少）/ VC-023 Cookie 作用域（cookie tossing）/ VC-025 Host 头攻击（密码重置投毒）/ VC-026 签名与重放 / VC-028 日志监控面未授权（Kibana/Graylog）/ VC-030 SSTI / VC-031 XXE / VC-032 反序列化 / VC-033 会话管理。
（~~VC-034~~ ✅ 已建：Supabase/PostgREST 开放数据面，08-20 战役 retro，v1 2026-08-28）

### T-13 签名逆向（APP API 前置，人机混合）

- 先测签名实现质量（改参重放/时间戳/删签名——半数实现有缺陷，无需逆向）
- 确实验签的 → frida 逆向（人机混合任务），产出 MethodCard 长期复用

### T-14 kb_docs 消费激活验收（v4.5 部署后一周）

- 部署后观察：调度任务 worker.log 出现 kb_search 调用（每日）；一周后看板知识 tab 体检视图 kb zero_use 占比显著下降（当前 268/278 ≈ 96% 零使用）
- 若一周后仍接近全零使用 → 检索指令注入位置不对（考虑移入 persona 而非 prompt 模板）或检索词画像不匹配（调 prompt 中的关键词建议）

### T-15 FGS 沉淀质量验收（v4.5 部署后次日）

- 次日 vuln 任务 done 后：`sqlite3 /opt/silkspool/dsh/data/asset-graph.db "SELECT COUNT(*) FROM facts WHERE fact_key LIKE 'fgs/%'"` > 0
- 抽查 2-3 条：summary 是否结论性（非 step 感想）、body 是否带证据、confidence=confirmed 是否合理
- 沉淀量异常大（>50 条/任务）→ 收紧 persistFgsFacts 的证据门槛（detail 长度/类型过滤）

### T-16 scan-burst 审批设计（v4.5 仅登记未实现）

- 突破 rate_limit_qps（50）的批量探测授权：批量扫（如全子域 nuclei）时的临时升速申请
- 设计要点：kind=scan-burst，payload 带 qps 目标值/时长窗口/资产范围；批准写 scope.yml defaults 或项目 rules 的 burst_qps 字段，scheduler 在窗口内按新限速派发；窗口过期自动回落
- 依赖：先看 tool-intrusive 白名单机制的实际使用频率，若审批中心活跃度低则本项优先级后移

### T-17 CyberStrikeAI knowledge_base 死库存处置（仅登记）

- `hosts/csai/knowledge_base/`（70 目录 23MB）+ config.yaml 由 spool sync 管理但**无任何运行时消费者**（/opt/silkspool/csai/ 下只剩 backups）
- 选项：① 篮选有价值内容经 kb_import 灌入 kb_docs（走消费端激活通路）② 维持现状仅归档 ③ 删除（需用户单独批准）
- 不默认删除——历史库存可能有回流价值，等 T-14 验收后再决策

---

## 四、体系工作规范（执行层参考）

> 本节是长期有效的工作标准，agent 执行层以 csai 上的 sec-pipeline 技能为准（内容一致）。

### 4.1 五条公理

P1 流程可靠优先（容错/幂等/覆盖闭环）> P2 无证据不结论（LLM 不给自己当法官）> P3 万物皆可进化（版本化+反馈回路）> P5 保底+自由（规定动作+探索配额）> P4 格式刚性内容开放（schema 锁结构不锁取值）。

### 4.2 管线架构

```
L1 资产层 → L2 接口层 → L3 工具矩阵层 → L4 确认层
外加：变化雷达（CT 新子域/JS 发版/版本漂移，变化优先于存量）
三条反馈回路：日内证伪 / 日间卡片升版 / 长期想法孵化
```

### 4.3 覆盖六态与台账

可落行的六种终态：`TESTED_CLEAN(要证据) / CONFIRMED(要证据包) / FALSE_POSITIVE / NOT_APPLICABLE(要 na_reason) / BLOCKED(要 blocker) / STALE`；**PENDING 是"未落行"的隐含态**（覆盖矩阵中尚未出现的组合），不在台账工具枚举中（attempts_log 强制枚举校验）。
台账 `attempts-{program}.tsv` 核心列固定：`ts/asset/card_id/card_ver/tool/result/reason/evidence_path/run_id`，完成一个目标立即一行；开放注册新状态/新理由值（禁 other/misc）；覆盖视图由 sec-pipeline 插件 `coverage_report` 工具生成（禁手填；同名旧脚本在退役观察期）。
STALE 触发：资产变化/卡片升版/超 retest 期/新情报/负账本到期；升版波及 >50 单元格先抽样 20% 回归。

### 4.4 防幻觉十条

①分母明确 ②CLEAN 同级举证 ③detect/verify 分离+双出口复现 ④数字可溯源 ⑤格式机器校验 ⑥禁止词（可能/疑似/应该/理论上/大概率）⑦负例即价值（0 产出日同等重要）⑧一致性校验 ⑨机械复核（hash 重放才标 src_ready）⑩对抗性复核（独立会话证伪）。

### 4.5 卡片体系

四类卡：**VulnCard**（探测/验证规程）、**MethodCard**（工具技巧）、**PatternCard**（判定依据含 counter_examples）、**IdeaCard**（思路种子：必写 verification_requires + first_testable_when，seed→incubating→testable→promoted/rejected）。
通用骨架：id/type/name/version/status + usage/hit/fp 统计 + changelog。每次使用经 `card_usage_log` 落 `card_usage-{日期}.jsonl`，**deviation 必填**（偏差=升版原料）。升版 bump version；draft 用 ≥3 次或评审转 active；usage≥20 且 hit=0 强制废止评审。

### 4.6 任务结构

规定动作（brief 硬指标必须完成）+ 自选动作（≥20% 时间或 ≥3 条 IdeaCard；产出只进 ideas/huntlist 不许直接进 findings）。发散八角度：组合/类比/倒置/协议下沉/数据追问/时间维度/生态侧写/白盒镜像。收尾六查：台账终态/证据包/理由值/idea 入库/handoff 一致/radar 无积压。

### 4.7 登录态策略

按增益分级（A 管理后台必投/B 个人数据选投/C 官网不投）；账号七路径（注册穷尽/SSO 乘数/开放平台沙箱/无账号登录面测试 VC-015/厂商自暴露凭据合规用/邀请制/放弃标注）；双账号原则+数据隔离红线；签名问题先测实现质量再决定是否逆向（BLOCKED(needs-reverse)）。

### 4.8 合规止损（机器强制）

够证即停（不拖数据/不横向）；证据脱敏；绝不用拖库凭据、绝不登真实用户账号；限速 50 QPS；intrusive 一律人工；蜜罐命中即退；规则变更即时生效。

---

## 五、已完成记录（里程碑日志）

| 日期 | 里程碑 | 记录 |
|---|---|---|
| 2026-09-05 | **v4.5 审批通配/异步化 + 工具信封修复 + 知识体系自进化** | ① sec-pipeline 8 工具信封修复（execute 全部改返回纯对象，renderJSON 保留为双参 render 回调——此前的 `invalid output: "value" must be an object` 服务端实际写入成功仅传输层报错，exp 卡 #6 与黑板 env-issue 记载的根因）；② **审批通配符化**：新 kind `scope-wildcard`（整域 `*.example.com + example.com` 双条目写回 + 种子任务；judgment 仅 控股/全资 或 收购/财团、evidence≥30 字主体核证级）+ scope-domain 加 apex 检测（裸 apex 提请被拒并引导改提通配）+ 子域单域证据门槛升到 30 字；③ **异步审批扩展**：kind `tool-intrusive`（runCli intrusive 拒绝点自动落库带脱敏参数，批准写项目 rules.allow_intrusive_tools 白名单，checkRisk 白名单放行，agent 纪律第 13 条禁重试）+ kind `task-budget-extend`（scheduler 超时分支自动提请，批准写 tasks.budget_timeout_sec≤7200，runWorker 取 max(默认,值)）；④ **FGS 跨任务沉淀**（cairn-y §5.8 落地）：任务 done 时 fact 节点自动转正 durable facts（fgs/{task_id}/{node_id} 幂等）；⑤ **kb 消费激活**：调度 prompt 注入 kb_search 检索指令 + AGENTS.md 检索建议段（268/278 篇零使用死库存）；⑥ 知识体检视图（knowledgeHealth → 看板知识 tab）；⑦ memcore sweep 三处死循环治理（vault-export 拒绝卡自动 exportable=0 + memcore_events 留痕、objective-lint 排除终态任务、kb revalidate ±15 天抖动 + 存量同日到期回填散布）；⑧ 新增 taskGet/budget_timeout_sec/allow_intrusive_tools（serializeScope 支持）；⑨ 文档：H-005 存量子域审批处理指引、T-14~T-17 登记（kb 验收/FGS 验收/scan-burst 设计/CSAI 知识库处置） |
| 2026-09-04 | **v4.6 DSH 本体升级 0.1.1-rc.2 → 0.1.2-rc.1（B0'/B1'/B2' 完成，B3' 观察中）** | ① 升级五坑全根因修复并回写模板：pnpm 11 无 TTY 清目录中止（实测认 `CI=true` 而非 npm_config_confirm_modules_purge）→ CI 又默认 frozen-lockfile（`--no-frozen-lockfile`）→ pnpm-workspace patch 声明钉旧版（ERR_PNPM_UNUSED_PATCH，对 0.1.2-rc.1 的 dsh-llm-deepseek 重打 reasoning_content patch + 声明升版，**每次升版必做**）→ session_projcache 存储版本 3≠5 crash-loop（幂等升版钩子 projcache_fix 入 dsh-upgrade.sh）→ root 属主 node_modules 致 pnpm RetryOperation 死循环（chown 归位）；② 验证 V1-V10 全过：**edge 走方案 A 零改动**（Caddy Host 改写继续绕过 0.1.2 一次性 token，判定取 hostname）、157 插件 id 组合树、sec-* 双 profile 全在、7 preset persona 完好、spawn_worker pong、web_fetch 实测直连公网（0.1.2 无禁用开关，靠纪律收口）；③ F-6/F-7 纪律：sec-runtime-discipline 新增第 10 条（web_fetch 仅限非目标域公开资料，禁对 scope 资产使用——绕 scope-guard 且出口不经 mubeng）+ 第 11 条（worker 禁自主切 provider，覆盖只由派单方经 `--patch` 指定）；④ F-7 上报关闭：**plugin-package-inventory-deepseek `enabled: false`**（web+headless 双 profile cordis.patch.yml，dump-config 验证；键名经探查=该插件由 dsh-base 挂载、zod `enabled` 默认 true；session-log 上报确认默认关）；⑤ F-8 版本钉：setup.sh DSH_VERSION → 0.1.2-rc.1 + dsh-version-watch.sh KNOWN 同步且版本获取改 dist-tags.latest（替代 versions[-1] 的 alpha 误报）+ radar 清 5 条陈旧事件；⑥ settings-mirror-patch 模板改双模式（0.1.2 起模式串 `ctx.remote.$host.isLoopback`，线上已手工重放）；⑦ 0.1.3-alpha.1 不升（SessionHandle 破坏 + 官方性能回退），升级前置=两处 sessionPersistence 重写。详见 `dsh-0.1.2-rc.1-upgrade-plan.md` §十 |
| 2026-09-04 | **v4.4 srcskill 首批吸收（P19'+P20'）** | ① sec-pipeline 插件接线：manifest.yaml + setup.sh §8.4 正式部署（此前 8 工具仅开发未接线）；② 批准→种子入队闭环：scope-domain onApprove 自动创建 `[审批入队]` once 任务（+5min，只做资产收集禁漏洞探测）+ radar-queue.jsonl 追加 scope-approved 事件（双通道 best-effort 不阻塞批准）；③ 股权判据结构化：scope-domain 提请强制 equity_basis/independent_src/corroboration 三字段（payload 存储，看板渲染判据 chip）；④ 新 kind `exclude-exception`（排除例外评估：validate 强制 subject 在排除清单内，批准=移出排除+并入 scope+durable fact）；⑤ rules 先验两篇：equity-gate.md 股权闸（含判例表 4 例）+ technique-index.md 打穿短表 87 行（手法族列映射 vuln_type 词汇表）；⑥ 纪律更新：sec-runtime-discipline 第 2 条扩 exclude-exception 与判据要求、sec-pipeline §2 增开局扫技术索引；⑦ 修部署链路缺口：sec-pipeline/sec-runtime-discipline 技能源在 data-seed/skills/ 但不经任何通道下发（改了不生效）——已按既有模式接入 seed-skills.sh heredoc（幂等刷新；注意 spool pushTemplates 按文件名平铺推送，manifest 不能列嵌套路径） |
| 2026-08-27 | 体系检查与设计 v1.0→v2.1 | 对 csai 只读检查：确认"高覆盖低产出"（近 6 天仅 +1 low；high/medium 全来自 08-20 手工战役）、工具闲置（20+ 装 5 用）、kb 闲置、xray 无消费。产出五公理设计规范（本目录保留 v2.1 历史版于 git 历史） |
| 2026-08-28 | P13 第一批落地 | sec-pipeline 技能、17 张漏洞卡+注册表、3 个核心脚本（validate/coverage/replay 均实测）、brief/handoff 模板、tasks #16-#19 objective 接入（DB 已备份）、OOB interactsh 二进制部署待 DNS |
| 2026-08-28 | 第二周批次落地 | l2-collect（实测单目标 6593 端点/913 参数 URL）、surface-consume（队列+7 类敏感回扫）、js-watch、ct-watch 常驻（calidog 不可用改 certspotter 轮询+429 退避） |
| 2026-08-28 | **重要纠偏** | xray flows/*.jsonl 11.2 万行全是扫描统计计数，**请求内容从未被记录**——参数面改由 l2-collect 直接产出 |
| 2026-08-28 | 文档整合 | sec/dsh 文档集中至 doc/secagent/；本 README 为唯一持续推进入口 |
| 2026-08-28 | DSH 升级规划 + B0 执行 | `dsh-0.1.2-upgrade-arch-plan.md` 产出；B0 排查全过（无 APIProxy 依赖）；**B1 暂缓：0.1.2-alpha.1 未发布 npm**（GitHub 仅源码），用户决策等 beta；已部署 dsh-version-watch 每日监控 npm |
| 2026-08-28 | 发现调度异常（已查明） | tasks #16-#19 next_run 漂移根因：**task_runs 持续 ~24h 才关闭 → 每日触发时前次运行仍"打开" → 调度器生成"宿主重启/超时回收"恢复行并多次推进 next_run**；实际链条每日正常执行一次（恢复行是记录产物非真实执行）。修复（重锚定）待 0.1.2 升级窗口一并处理，登记 T-0 |
| 2026-08-28 | B2 提示词去重（P14） | 新建 sec-runtime-discipline 公共纪律技能；4 个日任务 objective 重写（3569→1226 等，~70% 精简，纪律全部归技能单一事实源）；**收尾 note 强制【项目·角色·MMdd】格式**（执行历史左侧可分辨哪天哪个任务）；#24 周复盘挂入每周卡片评审段（T-4 完成） |
| 2026-08-28 | B3 sec-pipeline 插件化 | 新插件 8 工具上线（attempts_log/card_usage_log/radar_read/pipeline_validate/coverage_report/verify_replay/surface_queue/surface_scan，全部单测通过含反例拦截）；l2-collect 注册为 run_cli manifest；objective 工具引用更新；旧脚本进入 1 周只读退役期 |
| 2026-08-28 | B4 sec-suite 拆分（第一批） | 主文件 2051→1874 行，webhook.js/scheduler.js 卫星拆出（依赖注入、行为不变、node --check 全过）；重启冒烟通过（调度循环正常启动）；taskChain/reportBuild 留待下批 |
| 2026-08-28 | B4 sec-suite 拆分（第二批） | 主文件 1874→1507 行（101.7KB→72.1KB），dashboard-rpc.js 卫星拆出（planChain/taskChain/handleDashboardRpc 全部 38 个 case，initDashboardRpc 依赖注入）；发现 reportBuild 实际逻辑本就在 asset-db.js 卫星（taskChain 仅转发）；重启冒烟通过（0 错误、调度正常、webhook 正常）；剩余主体为 run_cli/scope/sandbox 引擎（拆分候选：scope.js/sandbox.js/run-cli.js，视后续需要） |
| 2026-08-28 | B5 TrueNAS/vault 沉淀 | spool nas 修复（新增 insecure 配置 + uptime 字符串解析）；csai 直挂 NFS 被 EPERM（keeper 正常，根因未明）→ **keeper 中继方案**落地：csai vault-export-build（卡片 YAML→md）→ operator vault-sync cron 每 30min → keeper `/mnt/NAS/data/knowledge/vault/SilkSecAgent/`（卡片库/报告/覆盖视图/交接，首批 18 文件已同步） |
| 2026-08-28 | **P15 纪律落地批**（评估报告驱动） | ① 流程守卫：interval 任务标 done 前引擎硬校验台账/卡记录/交接包（asset-db taskUpdate，缺失即拦截，冒烟双向验证）；② 噪声闸门：findings.noise 列 + info 级自动隔离（存量 314 回填），query/report/KPI 默认排除；③ 资产准入：assets.level_in 查询 + grade-assets.py 全量分级（79,155/79,258，域外 103 保持 NULL）；④ 修三断链：taskClaimDue started_at 刷新 + reap 宽限期+活 worker 跳过 + 调度 run 会话反查回填（session_id/meta.json/task_runs）；T-0 重锚定 drift=0；⑤ ops 健康度：asset-db.opsHealth() + 看板 `ops` RPC + 红条横幅 + discipline-audit.py/data-quality.py；⑥ H-003 vuln_type 回填清零；垃圾 playbook 清理；facts 空 category 归位 |
| 2026-09-01 | **P17 落地 + 代码/数据清理** | ① P17 FGS 决策图框架落地（`fgs_nodes` 表 + 工具 + scheduler prompt 注入）；② 修复 scheduler `findWorkerSessionId` 缺失 `await` 导致 `session_id` 写入 Promise 字符串的 bug、scope 首次创建 `copyFileSync` 崩溃、pipeline `renderJSON` 输出格式与覆盖矩阵 bug、parser 静默失败；③ 清理 407 条孤儿资产（按域名后缀归属 bytedance/meituan-src/legacy-archive）、235 条外部/孤儿端点、310 条噪声 finding、17 条旧版一次性任务、20 条过期 blackboard 日更日志，facts 归属归一化；④ 主文档 README/system-complete 刷新到 2026-09-01 状态 |
| 2026-09-04 | **v4.2 漏洞列表信号面规范** | ① addFinding 完整性闸门：缺复现步骤/影响或标题<10 字符的登记自动归「待验证候选」（noise=1），漏洞列表只呈现字段完整可复核的信号；弱指纹命中补全后 UPDATE 原行就地升级；② finding_add schema 强制五要素 + 标题规范；③ xray webhook 标题规范化、不再冒充漏洞；④ 看板「仅待验证候选」筛选 + 已定案行紧凑化；⑤ 修复 queryFindings 未透传 noise（行数≠总数同类病）；⑥ csai 存量 40 行不完整登记降级候选（单测 6/6） |
| 2026-09-04 | **v4.3 事实治理 + 报告归类 + 统一审批中心** | ① countFacts/factSearch 口径对齐 + 看板事实 tab 生命周期 facet + 默认隐藏 note 速记（1096→630）+ factStats by_mem_class/by_status；② buildReport severity 多选/按项目分节/文件名语义化 + 报告列表按项目分组筛选；③ 统一审批中心：approval_requests 通用表 + APPROVAL_KINDS kind 注册表（首个 scope-domain）+ approval_request 工具 + 看板「审批」tab；④ 历史候选域名 4 条导入待审批（单测 30/30）；⑤ 纪律：sec-runtime-discipline 补第 2 条授权提请 + 第 9 条事实生命周期 |
| 2026-09-04 | **v4.4 srcskill 第二批吸收（知识库全量 + 可见性）** | ① 46 篇手法模块 + 2 篇方法论经 seed_rule 通道导入 `data/rules/{techniques,srcskill}/`（逐字全量、幂等；technique-index 补 86 处模块引用闭环）；② 看板知识 tab 新增「静态先验 rules」分区：dashboard-rpc rulesList/rulesRead（只读、防路径穿越、512KB 上限），rules 层首次有 UI 观测入口；③ vault-export-build.sh 增静态先验段（rules/ 整树 + tombstone 进 `vault-export/SilkSecAgent/静态先验/`，vault-sync 实测 91 文件同步 keeper）；④ memcore 导出桥修两处部署/设计缺口：setup.sh 此前从不调用 sec-memcore-plugin-setup.sh（插件代码 08-25 起改了不生效——已补 8.5 调用）+ 暂存目录误用整树 `vault-export/`（会连 SilkSecAgent 树一起 rsync 进 经验卡/——改独立 `vault-export-cards/`），EXPORT_REMOTE 归位 `安全经验/SilkSecAgent/经验卡/`；⑤ keeper vault 目录统一（散卡归位、08-28 重复树备份后清理，备份 /tmp/old-silksecagent-tree-backup-20260904.tgz）；⑥ vault-export-build.sh 接入 manifest+install_scripts 版本受控通道（此前纯手工部署） |
| 2026-09-04 | **历史候选域名首批评议** | 审批中心首批 4 条候选：catpaw.com（CatPaw AI Agent 主域）/ tabbit.com（AI 浏览器主域）/ wow.fun（美团官方跳转域）已批准入 meituan-src scope（审批 #3/#4/#5，audit 留痕）；zhaopin.com（智联招聘，或另有自身 SRC 归属）保持 pending 待人工确认边界（H-004）；scope.yml 已 spool sync pull 回收并补回注释 |
| 2026-09-04 | **v4.5 加载链重构 + 全量治理缺口修复** | ① seed-skills.sh 17,442→128 行巨石重构：56 篇规则 + 8 个 sec-* 技能正文全部外移为版本受控文件 `templates/data-seed/{rules,skills}/`（正文与 doc/srcskill、线上 data/rules 三份并存必然漂移的问题根治；md5 逐篇校验与线上零漂移）；② **spool 引擎修复**：pushTemplates 此前按 basename 平铺推送——嵌套路径模板同名互相覆盖（v4.4 的「manifest 不能列嵌套路径」限制解除）：含子目录的模板现保留相对路径部署（EnsureDir + SFTP），8 个 SKILL.md 覆盖问题根治、edge-static/browser.html 不再依赖手工归位（root 属主残留文件 sudo rm 后归位）；EnsureDir 改为无条件归位属主（既有 root 属主目录致 SFTP permission denied）；install_scripts 兼容新旧两种落点；③ 纪律文本单一来源（G5）：memcore 纪律 4 处重复收敛——7 个 preset persona 尾巴（×6 逐字+1 变体）改一句指针 + **persona_version=2 版本检测**（旧 preset 版本不一致自动重建 agent.cordis.yml，此前只补工具行 persona 收敛永不生效）；sec-knowledge 删与 AGENTS.md 受管区块逐字重复段改指针 + 新增规则先验层加载口径；sec-blackboard 标注 facts 优先；④ vault 主同步链路（G1 复核）：operator crontab 实际已有 vault-sync 每 30min（/opt/SilkSpool/scripts/vault-sync.sh，与仓库源 md5 一致，17:00 实测 91/91 文件）——此前「无调度器」结论过期，无需接线；⑤ retention.sh 扩第 4 段（G2/G3）：datasnap tgz + import-staging 90 天兜底清理；⑥ 部署面清理（G4）：datasnap tgz 归位 backups/datasnap/、import-staging 540M 删除、23 份 settings.yaml.bak 清除（**根因修复**：setup.sh 每次运行无限堆积备份→改滚动保留 1 份）、插件 bak×3/Caddyfile bak/asset-graph db bak/httpx pre-s2bak/空 draft 删除；data 目录 2.6G→539M；⑦ **afrog intel 假警报摘除（G7 根因）**：旧代码 `afrog -up` 是不存在的 flag（每日 update_failed），且 afrog 3.x 本地无模板库（pocs 目录仅 .DS_Store 残留，运行时从云端取 poc）——从 intel-refresh.sh 引擎列表摘除，nuclei 13203 正常；⑧ dsh-upgrade.sh 修 pnpm 无 TTY 中止（ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY，npm_config_confirm_modules_purge=false）；另 0.1.2-rc.1 已上 npm（本批未升核心，另列任务） |

### 历史文档索引（本目录）

- `silksecagent-system-complete.md` — **系统全景文档（以运行代码为真相源，长期有效）**：全部插件/脚本/流程/提示词/状态机/DSH+pi 融合架构解剖
- `dsh-secagent-plan-v6.md` — P11 时代主计划（历史快照，运行时现状以全景文档为准）
- `dsh-upgrade-0.1.1-rc.2-report.md` — DSH 升级报告（2026-08-23，升级/回滚手册仍有效）
- `silksecagent-assessment-2026-08-28.md` — 体系评估快照（主要缺口已由当日 P15/P16 批修复，见文末追加说明）
- `sec-memcore-implementation.md` / `sec-memory-governance-design.md` — 记忆基架设计与实施
- `XFF-SECURITY-RESEARCH.md` — XFF 伪造影响研究
- 挖掘体系设计规范 v2.1 完整版 — 见 git 历史 `doc/secagent-src-mining-optimization.md`（已并入本文档 §四）
