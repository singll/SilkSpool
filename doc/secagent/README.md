# SilkSecAgent SRC 漏洞挖掘体系 · 持续推进文档

> 版本：v3.0 · 2026-08-28（由设计规范 v2.1 + 人工待办文档合并而来，为唯一持续推进入口）
> 性质：Living Document。历史设计文档与实施报告见本目录其他文件；本文档只保留**当前状态、待办、未完成的详细内容、工作规范**。
> 体系运行位置：csai `/opt/silkspool/dsh/`；版本受控源文件在 SilkSpool 仓库 `bundles/dsh/templates/data-seed/`。

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

- 双项目每日链路：recon 03:00 → vuln 04:00（interval 任务 #16-#19，objective 已含 P13 流水线规范）
- 台账体系：`data/pipeline/{program}/attempts-*.tsv`（六态）、`endpoints-*.tsv`（接口面）、`radar-queue.jsonl`（变化雷达）
- 漏洞卡注册表：`data/vulncards/`（17 张种子卡 + IdeaCard 模板，开放注册）
- 脚本：`scripts/pipeline/`（l2-collect / surface-consume / js-watch / ct-watch / pipeline-validate / coverage-report / verify-replay）
- 常驻服务：`ct-watch.service`（CT 新子域雷达，certspotter 轮询，30min 间隔）、xray 被动 7777、mubeng 代理池 8899
- 技能：sec-pipeline（流水线纪律）+ 原有 sec-verification/sec-task 等

**当前最大瓶颈**（按解锁收益排序）：

1. **无凭据** → 越权/逻辑/登录态面全部 BLOCKED（H-002）
2. **无 OOB** → 盲 SSRF/盲注/盲 RCE 物理上不可测（H-001）
3. 高价值面多为登录态后（美团 carrier proxy/admin.erp、字节 saiyan/live_console/火山 ark）

**下一看点**：首批按 P13 规范运行的日报产出质量（2026-08-28 03:00/04:00 起）。

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

### H-003 存量 findings 回填 vuln_type 【P2】

- **待做**：确认允许 agent 批量回填（美团 187 + 字节 89 中 273 条缺类型）
- **接入**：agent 按 CWE 批量回填；回填后统计口径生效

---

## 三、待推进清单（未完成，详细）

> 按建议顺序排列；完成一项移入「已完成记录」。

### T-0 调度异常调查与修复【升级窗口处理】

- 根因（2026-08-28 查明）：task_runs 持续 ~24h 才关闭（latest-only 语义）→ 每日触发时前次运行仍"打开" → 调度器生成"宿主重启/超时回收"恢复行并多次推进 next_run（08-30/09-01）。**链条实际每日正常执行一次**，恢复行是记录产物非真实执行
- 待做：① 0.1.2 升级后验证调度器行为是否变化；② 重新锚定 next_run 到次日 03:00/04:00（与升级窗口一并，避免与调度器恢复逻辑打架）；③ 若升级后仍复发，记入 env-issue 并考虑向 DSH 上游报 issue
- 注意：task_runs 的 duration_ms 显示 ~24h 是关闭时机产物，**不是真实执行时长**，复盘时勿误读

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

VC-006 CRLF / VC-010 GraphQL / VC-011 JWT / VC-012 OAuth-SSO / VC-013 文件上传 / VC-017 业务逻辑 / VC-018 中间件暴露 / VC-022 AI 应用攻击面（coze/ark 在 scope，竞争极少）/ VC-023 Cookie 作用域（cookie tossing）/ VC-025 Host 头攻击（密码重置投毒）/ VC-026 签名与重放 / VC-028 日志监控面未授权（Kibana/Graylog）/ VC-030 SSTI / VC-031 XXE / VC-032 反序列化 / VC-033 会话管理

### T-13 签名逆向（APP API 前置，人机混合）

- 先测签名实现质量（改参重放/时间戳/删签名——半数实现有缺陷，无需逆向）
- 确实验签的 → frida 逆向（人机混合任务），产出 MethodCard 长期复用

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

`PENDING / TESTED_CLEAN(要证据) / CONFIRMED(要证据包) / FALSE_POSITIVE / NOT_APPLICABLE(要 na_reason) / BLOCKED(要 blocker) / STALE`。
台账 `attempts-{program}.tsv` 核心列固定：`ts/asset/card_id/card_ver/tool/result/reason/evidence_path/run_id`，完成一个目标立即一行；开放注册新状态/新理由值（禁 other/misc）；覆盖视图由 coverage-report.py 生成（禁手填）。
STALE 触发：资产变化/卡片升版/超 retest 期/新情报/负账本到期；升版波及 >50 单元格先抽样 20% 回归。

### 4.4 防幻觉十条

①分母明确 ②CLEAN 同级举证 ③detect/verify 分离+双出口复现 ④数字可溯源 ⑤格式机器校验 ⑥禁止词（可能/疑似/应该/理论上/大概率）⑦负例即价值（0 产出日同等重要）⑧一致性校验 ⑨机械复核（hash 重放才标 src_ready）⑩对抗性复核（独立会话证伪）。

### 4.5 卡片体系

四类卡：**VulnCard**（探测/验证规程）、**MethodCard**（工具技巧）、**PatternCard**（判定依据含 counter_examples）、**IdeaCard**（思路种子：必写 verification_requires + first_testable_when，seed→incubating→testable→promoted/rejected）。
通用骨架：id/type/name/version/status + usage/hit/fp 统计 + changelog。每次使用落 card_usage.jsonl，**deviation 必填**（偏差=升版原料）。升版 bump version；draft 用 ≥3 次或评审转 active；usage≥20 且 hit=0 强制废止评审。

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

### 历史文档索引（本目录）

- `dsh-secagent-plan-v6.md` — 平台总体计划（主计划）
- `dsh-upgrade-0.1.1-rc.2-report.md` — DSH 升级报告（2026-08-23）
- `sec-memcore-implementation.md` / `sec-memory-governance-design.md` — 记忆基架设计与实施
- `XFF-SECURITY-RESEARCH.md` — XFF 伪造影响研究
- 挖掘体系设计规范 v2.1 完整版 — 见 git 历史 `doc/secagent-src-mining-optimization.md`（已并入本文档 §四）
