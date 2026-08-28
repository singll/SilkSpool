# DSH v0.1.1-rc.2 → v0.1.2-alpha.1 升级与架构优化规划

> 版本：v1.0 · 2026-08-28 ｜ 性质：**规划文档，未实施**
> 目标：① 升级 DSH 到 v0.1.2-alpha.1 且全部附加功能正常运行；② 借机对全部插件/脚本/提示词/流程做架构级优化，让每个部件处于最优位置；③ 知识产物（漏洞卡等）沉淀到 TrueNAS Obsidian vault。
> 关联：`README.md`（持续推进文档）、`dsh-upgrade-0.1.1-rc.2-report.md`（上次升级报告）、`bundles/dsh/CONTEXT.md`（领域语言）

---

## 目录

1. [版本变更影响分析（逐条标注）](#一版本变更影响分析)
2. [升级实施方案](#二升级实施方案)
3. [架构现状全量盘点](#三架构现状全量盘点)
4. [架构优化方案（逐项裁决）](#四架构优化方案逐项裁决)
5. [公共模块抽离设计](#五公共模块抽离设计)
6. [TrueNAS / Obsidian 沉淀方案](#六trunas--obsidian-沉淀方案)
7. [实施批次与验收标准](#七实施批次与验收标准)
8. [风险登记与开放问题](#八风险登记与开放问题)

---

## 一、版本变更影响分析

> 来源：[dsh-v0.1.2-alpha.1 Release Notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1)（2026-08-27 发布，pre-release/alpha 质量需注意）。
> 标注口径：🔴 **必须适配**（不改会坏）｜🟡 **需验证**（行为可能变化）｜🟢 **直接受益**（免费改进）｜⚪ 无关

### 1.1 变更逐条影响表

| # | 变更 | 级别 | 对当前部署的影响 |
|---|---|---|---|
| 1 | **移除旧版 APIProxy 传输层，改用 Remote 网关；网络访问启用一次性 Token 鉴权** | 🔴 | **唯一明确的破坏性变更**。需排查：① `dsh-browser-upstream` 插件是否通过 APIProxy 连浏览器（15KB index + browser-manager，疑似走 CDP 直连，待确认）；② 任何 headless/SDK 调用（eval-run.js、外部脚本）是否依赖旧传输层；③ 若有用 Remote 网关的场景需配置一次性 Token。升级前 grep 全部插件与脚本确认 |
| 2 | **Agent 预设修复：profile 配置的预设根目录启动时丢失** | 🟡 | 我们 `data/.agent-presets/` 有 7 个角色预设（recon/vuln-hunt/review/orchestrator/code-audit/biz-logic/intranet），settings.yaml 默认 preset=vuln-hunt。此前若受此影响（重启丢预设根目录），升级后行为**变化**（预设恢复生效）——需验证预设实际加载的 skills/commands 是否与预期一致，避免"修好后行为突变" |
| 3 | **子代理支持配置模型**（任务可指定 provider/模型/推理力度；spawn 级配置） | 🟢 | 重大利好：① `spawn_worker` 批扫可指定更便宜模型（当前全量 DeepSeek V4 Flash，可再降档）；② 定时任务 #16-#19 可按角色配模型（recon 用低价、vuln 用主力、review 用高推理）。**升级后应立即利用做成本优化** |
| 4 | **持久终端修复：Linux 管道读取误判为等待输入→提前返回空输出** | 🟢 | **直接命中我们的痛点**——批探脚本大量管道（xargs/curl 管道），此前可能静默拿到空输出导致"000 误判/漏资产"。升级后探活类结果可信度提升 |
| 5 | **持久终端修复：Bash 派生大量子进程时宿主卡顿** | 🟢 | 命中 xargs -P8 批探场景，稳定性收益 |
| 6 | **系统提示词分区顺序稳定 + Shell 指南前移** | 🟡 | 提示词行为基线变化：我们的技能依赖 shell 批探，前移后模型用 shell 的倾向可能增强。升级后观察 2-3 天任务轨迹，确认无异常膨胀 |
| 7 | **pi-ai 0.84.2：模型提供方列表更新 + vLLM 思考预算** | 🟡 | settings.yaml 的 provider/模型名需核对是否在新列表中（DeepSeek 官方端大概率兼容，自定义端点需验证） |
| 8 | **Headless 运行 stderr 流式进度** | 🟢 | spawn_worker 日志可观测性提升（worker.log 不再只有头几行，命中我们"失败 run 日志过少"痛点） |
| 9 | **持久化存储体积优化 / 页面加载性能** | 🟢 | sessions 目录体积与看板加载提速，免费收益 |
| 10 | **多模态：轨迹视图支持图片附件、模型可定位已上传图片** | 🟢 | 证据包截图（browser 插件）可在轨迹中直接展示，辅助人工复核 |
| 11 | **插件配置扩展位（设置增补）** | 🟢 | 我们的 *.patch.yml 插件配置可迁入正式配置位，减少 patch 面 |
| 12 | **会话交互：自动折叠过程/每轮精细用量/轮次导航** | 🟢 | 长任务（50min 字节链）可读性提升 |
| 13 | **文件编辑工具不再拒绝未用字段 null 占位** | ⚪ | 内部工具行为，无直接影响 |
| 14 | **PTC Mode SDK 绑定不再被绕过** | 🟡 | 确认我们是否启用 PTC Mode（默认未启用则无关） |
| 15 | **DeepSeek 适配器默认附带插件包名称+版本**（可关） | 🟡 | 隐私/合规评估：会向模型提供方泄露我们的插件清单（含 sec-suite 等名称）。**建议配置关闭** |
| 16 | **可选会话日志增量上传**（默认关） | ⚪ | 保持默认关闭 |
| 17 | **ACP/Python SDK 收敛至 dsh profile** | 🟡 | 若有脚本以 ACP 方式驱动 DSH 需改 profile 方式（grep 确认，预期无） |

### 1.2 升级前必做排查清单

```bash
# ① APIProxy/旧传输层引用（变更#1）
grep -rn -i "apiproxy\|api_proxy" /opt/silkspool/dsh/*.js /opt/silkspool/dsh/data/settings.yaml
# ② 预设加载现状（变更#2）
grep -n "agent-presets" -A 10 /opt/silkspool/dsh/data/settings.yaml
# ③ 自定义 provider 端点（变更#7）
grep -n -A5 "providers\|baseURL\|base_url" /opt/silkspool/dsh/data/settings.yaml
# ④ PTC / ACP 使用痕迹（变更#14/#17）
grep -rn -i "ptc\|acp" /opt/silkspool/dsh/data/settings.yaml
```

---

## 二、升级实施方案

### 2.1 升级流程（复用已验证的自验证+回滚机制）

沿用 `dsh-upgrade.sh`（上次升级已补齐自验证+自动回滚），流程：

```
0. 前置：§1.2 排查清单全部过一遍，结果记录
1. 窗口选择：03:00/04:00 定时链结束后（约 05:00 后），避免中断运行中任务
2. 冻结：scheduler 暂停/无运行中 worker 确认（worker_list）
3. 备份：asset-graph.db + data 全量快照（脚本已含；确认 backups/ 落盘）
4. 升级：bash dsh-upgrade.sh --version 0.1.2-alpha.1
5. 冒烟（脚本自动）：进程存活 → Web UI 200 → 五插件加载 → DB 可读
6. 扩展验证（本次新增，见 §2.2）
7. 观察期 24h：次日定时链全链路观察
```

### 2.2 升级后扩展验证清单（针对影响表逐项）

| 验证项 | 方法 | 通过标准 |
|---|---|---|
| 插件全部加载 | 看板/日志 | sec-suite/memcore/dashboard/proxy-pool/browser-upstream/theme + 社区插件无报错 |
| 预设根目录（变更#2） | 切换 7 个预设 | 各预设 skills/commands 按预期挂载 |
| 工具调用 | 手动跑 run_cli/asset_query/task_list/finding_query | 返回正常 |
| xray webhook 7788 | curl 发测试事件 | JSONL 落盘 + 无报错 |
| 定时任务链 | task_run_now 触发一次 recon（小批） | done 且台账落行 |
| 批探管道（变更#4） | xargs -P8 管道探活 10 目标 | 无空输出误判 |
| 子代理模型配置（变更#3） | spawn_worker 指定模型试跑 | 按指定模型执行且 bill 归因正确 |
| 适配器插件名上报（变更#15） | settings 关闭后抓请求 | 请求体不含插件清单 |
| 成本 | bill_stats 对比 | 无异常上涨 |

### 2.3 回滚预案

- 冒烟或扩展验证任一失败 → dsh-upgrade.sh 自动回滚（已验证机制）
- 观察期内定时链连败 2 次 → 手动回滚 + 复盘
- alpha 版特有预案：若遇上游 bug 无法立即回滚（如需保留新数据），降级策略 = 暂停 vuln 链保留 recon 链，缩小影响面

---

## 三、架构现状全量盘点

### 3.1 组件清单（csai /opt/silkspool/dsh/）

**自研插件（patch 注入式，*.js + *.patch.yml）**

| 插件 | 体积 | 职责 | 内部结构 |
|---|---|---|---|
| sec-suite | **101.7KB 主文件** + asset-db 56KB + asset-graph 27KB + experience 36KB + parsers 6.6KB | 资产/漏洞/事实/任务/调度/工具（run_cli/spawn_worker/authz_diff/intel_hunt/grep_result 等 11+ 工具）+ xray webhook 7788 | 主文件偏巨石，卫星模块按域拆分过一轮 |
| sec-memcore | 33KB | 记忆治理（晋升/遗忘/分类硬实施，fail-open） | 单文件，职责清晰 |
| sec-dashboard | 105KB client + 0.7KB index | 看板七视图 UI | 纯前端，与 sec-suite 数据层分离 |
| proxy-pool | 12KB | 代理池管理工具（stats/report_bad） | 单文件 |
| browser-upstream | 16KB + 3KB manager | 共享浏览器 CDP 上游 | 双文件 |
| theme-silksong | 12KB client | UI 主题 | 纯前端 |

**社区插件（plugins.lock 治理）**：dsh-auth-gate（登录门）、dsh-model-failover（熔断切换）、dsh-browser（已 fork）、dsh-bill（成本归因）；dsh-sentinel 已 BLOCKED 移除。

**系统服务（systemd）**：silksecagent（DSH web）、silksecagent-edge（caddy 反代+Host 改写）、silksec-proxy-rotator（mubeng 8899）、silksec-shared-browser（CDP 9222）、silksec-xray（被动 7777→webhook 7788）、ct-watch（CT 雷达）。

**流水线脚本（scripts/pipeline/，P13 批次新建）**：l2-collect.sh、surface-consume.py、js-watch.py、ct-watch.py、pipeline-validate.py、coverage-report.py、verify-replay.py。

**技能（data/skills/）**：sec-task、sec-verification、sec-blackboard、sec-review、sec-knowledge、sec-pipeline + draft/。

**定时任务**：#16/#17 recon、#18/#19 vuln（均含 P13 规范段）、#24 每周复盘。

**根目录杂项**：intel-refresh.sh、retention.sh、proxy_grade.py、proxy-pool-run-refresh.sh、embeddings.*、eval-*、migrate-*.js、backfill-program.js、fofa_search.sh、tools-manager.sh、各 *-setup.sh。

### 3.2 结构性问题（架构优化的靶子）

| # | 问题 | 证据 |
|---|---|---|
| S1 | **sec-suite 主文件 101KB 巨石**：工具注册、调度器、webhook、报告、黑板全挤一处，改一处动全身 | 卫星模块已拆 3 个但主文件未瘦身 |
| S2 | **P13 规范重复维护 5 份**：sec-pipeline 技能 1 份 + 4 个任务 objective 各 1 份（内容漂移风险，改规范要改 5 处） | tasks #16-#19 objective 内嵌约 700 字重复段 |
| S3 | **流水线脚本在 DSH 工具生态之外**：agent 只能用 bash 调脚本，无审计、无 run_id 自动归因、无 scope-guard 校验，与 run_cli 工具体系割裂 | validate/coverage/replay/l2-collect 均为裸脚本 |
| S4 | **出口/证据/run_id 等横切逻辑散落**：每个脚本各自实现代理、时间戳、落盘，无公共层 | l2-collect/surface-consume/js-watch 各自处理 proxy |
| S5 | **重复职责**：intel-refresh.sh（cron 情报）与 vuln 任务内 intel_hunt 重叠；retention.sh 与 memcore 遗忘机制重叠面未划清 | 两对并存 |
| S6 | **知识产物单点**：vulncards/报告/evidence 只在 csai 本地，无异地沉淀（备份仅本机 backups/） | TrueNAS 未利用 |
| S7 | 根目录脚本平铺无分层（setup 类/运维类/数据类混杂 20+ 个） | ls /opt/silkspool/dsh/*.sh |

---

## 四、架构优化方案（逐项裁决）

> 裁决矩阵：简洁 / 性能 / 可靠 / 容错 / 架构分层（优先用 DSH 原生分层，原生满足不了才自建）。
> DSH 原生分层回顾：**插件（工具+服务）→ 技能（纪律提示词）→ 规则（静态先验）→ 任务（调度）→ 会话（执行）→ facts/exp/playbook（沉淀）**。脚本只该出现在"系统层守护"和"插件够不到的 OS 集成"。

### 4.1 插件层裁决

| 插件 | 裁决 | 方案 |
|---|---|---|
| sec-suite 主文件 | **拆分（S1）** | 按既有卫星模式继续拆：`sec-suite.scheduler.js`（任务调度+interval 续排）、`sec-suite.webhook.js`（xray 7788）、`sec-suite.report.js`（report_build）、主文件只留工具注册与路由。拆分原则：单文件 ≤40KB、按变更频率分组（调度/webhook 稳定，工具层迭代快） |
| sec-memcore | **保持** | 职责单一、fail-open 设计正确，不动 |
| sec-dashboard | **保持** | 纯前端，数据层分离正确；升级后适配新 UI 变更（§一#9/#12）即可 |
| proxy-pool | **保持** | 小而清晰 |
| browser-upstream | **保持+验证** | 升级时重点验证（§一#1 APIProxy 排查对象） |
| theme-silksong | **保持** | — |
| 社区插件 | **保持+复核** | 升级后复核兼容性；dsh-sentinel 关注上游修复（可承担条件唤醒，替代部分 cron） |

### 4.2 脚本层裁决（核心：脚本→插件工具的迁移）

判定标准：**agent 在任务中调用 → 应是 DSH 工具（插件）；系统守护/定时守护 → 保持脚本+systemd**。

| 脚本 | 裁决 | 方案 |
|---|---|---|
| pipeline-validate.py | **→ 插件工具** | 注册为 sec-pipeline 插件工具 `pipeline_validate`：agent 收尾直接调用，结果进审计与 task result，scope-guard 可感知 |
| coverage-report.py | **→ 插件工具** | `coverage_report`：聚合逻辑进插件，覆盖视图同时可作为看板一视图的数据源（dashboard 复用） |
| verify-replay.py | **→ 插件工具** | `verify_replay`：机械复核进工具层，出口走 scope.yml defaults.egress_proxy 自动注入，run_id 自动归因 |
| surface-consume.py | **→ 插件工具** | `surface_queue`/`surface_scan`：参数队列与敏感回扫工具化 |
| l2-collect.sh | **→ run_cli 工具模板** | 不重写逻辑：把 katana/waybackurls/gau 编排注册为 run_cli manifest 模板（tools.d/），获得代理注入/落盘/run_id/摘要回显全套既有能力（S3 的 DSH 原生解法，**不新造层**） |
| js-watch.py | **保持脚本+cron，输出进 facts** | 系统层守护合理；变化事件除写 radar-queue.jsonl 外，同时 fact_upsert（category=radar）让任务开局经 fact_search 自然感知（用 DSH 原生通道，不发明新通道） |
| ct-watch.py | **保持脚本+systemd** | 常驻守护正确位置；同样补 fact 通道 |
| intel-refresh.sh | **合并**（S5） | 职责并入 vuln 任务 intel_hunt 流程；cron 脚本退役（保留归档） |
| retention.sh | **划清边界**（S5） | 只留 OS 层日志/文件保留；记忆类遗忘全部归 memcore |
| migrate-*.js / backfill-program.js | **归档** | 一次性迁移脚本移入 `maintenance/` 子目录（S7） |
| *-setup.sh / tools-manager.sh | **归档分层**（S7） | 移入 `setup/`；根目录只留 dsh-upgrade.sh 等高频入口 |

**新增插件：sec-pipeline**（承载迁移的 4 个工具 + 六态台账读写原语）
- 不重复造轮子：台账文件读写、run_id、代理、证据包路径全部复用 §五公共模块
- 插件配置用 v0.1.2 新的配置扩展位（§一#11），替代 patch.yml 硬编码

### 4.3 提示词层裁决（S2：单一事实源）

| 项 | 裁决 | 方案 |
|---|---|---|
| P13 规范 ×5 份 | **去重** | objective 中的 P13 段压缩为两行："执行 sec-pipeline 技能全部纪律；今日产物路径 data/pipeline/{program}/"。规范唯一事实源 = sec-pipeline 技能（改规范只改一处） |
| 6 个技能 | **保持+边界复核** | sec-verification（判定）与 sec-pipeline（覆盖/留痕）边界已清；sec-blackboard 随 facts 迁移完成后退役（已在 CONTEXT.md 标记 legacy） |
| 7 个角色预设 | **复核**（变更#2） | 升级后逐一验证挂载内容；vuln-hunt 预设确认包含 sec-pipeline 技能 |
| 任务 objective 共性段 | **抽离** | 4 个任务的"环境纪律段"（代理/派单/interval 说明）高度同构 → 抽为技能 sec-runtime-discipline（或并入 sec-task），objective 只留项目特有部分 |

### 4.4 流程层裁决

| 流程 | 裁决 | 方案 |
|---|---|---|
| recon→vuln 双链 | **保持** | 骨架正确；变化雷达产出（radar-queue + facts）作为两链共同输入 |
| 每周复盘 #24 | **扩容** | 把 T-4（每周评审：词表合并/draft 晋升/STALE 风暴/IdeaCard 检查）挂入该任务一段，不新建任务 |
| 报告双轨（工作区文件 + report_build） | **统一** | report_build 支持输出路径配置（v0.1.2 配置位），报告统一落 data/reports/{program}/ + 同步 vault（§六）；工作区手写报告逐步退出 |
| 沙箱拒写问题 | **修复** | reports/{program}/ 沙箱拒写 5 天的历史问题随升级一并排查（目录权限/沙箱配置） |

---

## 五、公共模块抽离设计

**新模块：`sec-common`（sec-suite 内部共享 lib，不单独成插件——避免过度分层）**

| 抽离函数 | 当前散落处 | 说明 |
|---|---|---|
| `withEgress(fn)` | 各脚本/插件各自处理代理 | 统一从 scope.yml defaults 读出口，健康矩阵钩子（T-5）也挂这里 |
| `makeRunId(prefix)` | run_cli/脚本各自生成 | 统一格式与时间源 |
| `evidenceWriter(finding_id)` | 技能文字描述（无代码） | 证据包五件套目录化写入的唯一实现，verify_replay 共用 |
| `scopeReader()` | 多插件各自解析 scope.yml | 单缓存实现 + 变更通知 |
| `tsvAppender(schema)` | 脚本层 csv 处理 | 台账 append + 核心列校验（validate 逻辑共用） |
| `factEmit(category, slug, body)` | 黑板/facts 双轨期胶水 | radar/台账摘要统一进 facts 的单一入口 |

**knowledge 侧公共化**：kb_search 与 rules/ 静态先验已分层正确；漏洞卡（vulncards）读取逻辑放 sec-pipeline 插件，渲染进 prompt 的方式对齐 rules/ 先验层（命中指纹→自动带出适用卡片摘要）。

---

## 六、TrueNAS / Obsidian 沉淀方案

### 6.1 现状与通道选型

- TrueNAS：192.168.7.121（`spool nas` 当前有 TLS SAN 证书问题待修——登记为前置项）
- keeper 侧 Obsidian 链路：CouchDB（192.168.7.231）livesync → K07 工作流 → RAGFlow（个人笔记通道）
- csai 侧 `/mnt/nas` 目录存在但**未实际挂载**（空目录）

**通道裁决**：csai → TrueNAS 用 **NFS 挂载**（最直接、无新组件），vault 若走 CouchDB livesync 则是另一条面向"人在 Obsidian 里编辑"的通道——两者用途不同：

| 内容 | 通道 | 方向 |
|---|---|---|
| 漏洞卡库、覆盖视图、日报、复盘、findings 摘要 | **NFS 挂载 + 定时 rsync**（csai cron 每 30min） | csai → vault（机器产物，人只读） |
| 人工批注/研究笔记 | CouchDB livesync（既有 K07 通道） | 人 → 系统 |

### 6.2 vault 目录结构（沉淀即检索）

```
<vault>/SilkSecAgent/
├── 卡片库/           ← data/vulncards/（vcard YAML → 同步时渲染为 md，带版本/changelog）
│   ├── vuln/ method/ pattern/ ideas/
├── 报告/{program}/   ← data/reports/{program}/ 日报
├── 覆盖视图/{program}/ ← coverage-*.md（每日最新 + 归档）
├── 发现/             ← findings 摘要（CONFIRMED 的 reproduce.md 脱敏版）
├── 交接/{program}/   ← handoff-*.md（人要看"系统在干嘛"的入口）
└── 待办.md           ← README.md 的 H/T 清单镜像（人工维护处，单向人→repo）
```

### 6.3 实施要点

1. 前置修复：TrueNAS 证书 SAN（spool nas 可用）+ 建 dataset `vault/silksecagent` + NFS share（仅 192.168.7.0/24 只读给 keeper、读写给 csai）
2. csai：`/mnt/nas/vault` NFS 挂载（fstab 持久化）+ `vault-sync.sh`（rsync --delete 卡片库与报告；YAML→md 渲染用 python 小脚本）
3. 幂等与止损：rsync 失败不阻塞挖掘链（fail-open）；挂载断开时写本地队列下次补
4. 双向纪律：vault 中 SilkSecAgent/ 目录机器写人不改（Obsidian 里标注），人的批注写在别处避免被 rsync --delete 清掉
5. 注册进备份体系：vault 本身由 TrueNAS snapshot 保护（spool nas snapshot 既有能力）

---

## 七、实施批次与验收标准

| 批次 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| **B0 升级前排查**（0.5天） | §1.2 清单 + 全量备份 + TrueNAS 证书修复 | 排查记录落档；spool nas info 正常 | — |
| **B1 DSH 升级**（0.5天） | §2.1 流程 + §2.2 扩展验证 | 验证清单全绿；次日双链 done | B0 |
| **B2 提示词去重**（0.5天） | §4.3：P13 单源化 + objective 瘦身 + 预设复核 | 4 任务 objective 无重复段；双链行为无回归 | B1 |
| **B3 sec-pipeline 插件化**（1-2天） | §4.2：4 脚本→插件工具 + l2-collect→run_cli 模板 + sec-common 抽离 | agent 以工具调用完成收尾六查；旧脚本退役 | B1 |
| **B4 sec-suite 拆分**（1天） | §4.1：scheduler/webhook/report 拆出主文件 | 主文件 ≤40KB；全部工具回归通过 | B3 |
| **B5 vault 沉淀**（0.5-1天） | §六：NFS 挂载 + vault-sync + 结构落地 | vault 可见卡片库/报告/覆盖视图；rsync 幂等 | B0（TrueNAS 修复） |
| **B6 观察与收尾**（2-3天） | 双链观察 + 成本对比（子代理配模型收益）+ README 更新 | bill 无异常；台账正常；文档同步 | B2-B5 |

总工期预估 4-6 个工作日（可拆多日执行）。B3/B4 是架构主体，B5 独立可并行。

---

## 八、风险登记与开放问题

| 风险/问题 | 等级 | 处置 |
|---|---|---|
| alpha 质量版本遇上游 bug | 中 | §2.3 回滚+降级预案；观察期 24h；必要时滞留 rc.2 等 beta（决策点：升级冒烟失败 2 次则放弃本次升级窗口） |
| 变更#2 预设修复导致行为突变 | 低 | 升级后逐一验证 7 预设（§2.2） |
| 变更#15 插件名上报 | 低 | 配置关闭（升级后立即） |
| sec-suite 拆分引入回归 | 中 | B4 独立批次 + 工具级回归清单；保留拆分前 tag |
| 脚本→插件迁移期双轨 | 低 | 迁移期间旧脚本只读保留 1 周，验证无调用后删除 |
| NFS 挂载可靠性影响挖掘链 | 低 | vault-sync fail-open 设计（§6.3-3） |
| **开放问题 1**：dsh-browser-upstream 是否依赖被移除的 APIProxy | 待 B0 确认 | 若依赖且无法迁移 Remote 网关 → 该插件滞留旧版或暂缓升级 |
| **开放问题 2**：vault 在 TrueNAS 的现有路径/所有者（是否与 keeper CouchDB vault 同一份） | 待 B0 确认 | 决定 §6.2 是新建目录还是接入既有 vault |
| **开放问题 3**：子代理模型配置是否支持按 spawn_worker 调用级覆盖 | 待 B1 验证 | 支持则立即用于批扫降本（§一#3） |

---

*本文档为规划，未实施。批准后按 §七批次执行，每批完成后更新 README.md 里程碑日志。*
