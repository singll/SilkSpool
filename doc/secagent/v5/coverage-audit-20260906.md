# v5 全量设计文档 · 与线上实况逐项覆盖审计（2026-09-06）

> 性质：**审计报告**（非设计文档，不参与 00-18 编号体系）。
> 方法：`spool exec csai` 实查 `/opt/silkspool/dsh/` 全目录（systemd 单元、插件源文件、tools.d manifest、数据表 DDL、脚本、配置）× 逐篇通读 v5 19 份文档（grep 交叉验证每项能力关键词）。
> 结论先行：**核心领域面（14 域 × 67 v4 工具 × 15 数据表）覆盖完整**；发现 **6 项实质缺漏（2 高危）+ 1 项跨文档悬空引用 + 若干轻量运维面缺口**。

---

## 一、审计范围与证据基线

### 1.1 线上实况清单（2026-09-06 spool 实查）

| 层 | 实况 | 证据 |
|---|---|---|
| systemd 单元 13 个 | silksecagent / silksecagent-edge / silksec-shared-browser / silksec-xray / silksec-proxy-rotator / silksec-proxy-refresh.{service,timer} / silksec-intel.{service,timer} / silksec-backup.{service,timer} / silksec-retention.{service,timer} | `systemctl list-units 'silksec*'` 全部 loaded |
| 自研插件 10 组 | sec-suite（8 文件：index 2142 行 + asset-db + asset-graph + dashboard-rpc + experience + scheduler + webhook + parsers）、sec-memcore（52KB）、sec-pipeline（21KB）、sec-dashboard（182KB client + index）、proxy-pool、theme-silksong、@silksec/dsh-browser fork（tarball + upstream patch 文件）、embeddings（非插件模块） | `/opt/silkspool/dsh/dsh-plugin-*` 目录清单 |
| 第三方插件 | dsh-auth-gate 0.7.2 / dsh-model-failover 0.1.4 / dsh-bill 0.13.1 / dsh-sentinel 0.11.0（BLOCKED 已移除） | `plugins.lock`（pin+integrity+scan_verdict） |
| v4 模型工具 67 个 | asset-graph.js 38 + sec-suite.js 15 + sec-pipeline 8 + proxy-pool 6 | 各文件 `name: '...'` 逐个提取 |
| tools.d manifest 31 个 | 含 fofa_search / l2-collect / grade_assets / vision_triage / data_quality / discipline_audit / echo-test 等 7 个脚本通道 manifest | `ls data/tools.d/*.yaml \| wc -l` = 31 |
| 数据表 15 张 | assets / endpoints / findings / blackboard / facts / fact_edges / programs / credentials / tasks / task_runs / workers / fingerprints / approval_requests / fgs_nodes + experience 侧 exp_cards / exp_embeddings / kb_docs / kb_embeddings / playbooks + memcore_events / memcore_meta | 各文件 `CREATE TABLE` 提取 |
| 知识资产 | rules/ 79 篇（src 4 + srcskill 2 + techniques 47 + web 3 + php 1 + cases 22）、vulncards 18 张 + IC ideas、skills 7 个 + draft、presets 7 角色、knowledge/ 205 篇 | 目录实查 |
| 脚本层 | scripts/pipeline/ 15 个（ct-watch/js-watch/kb-harvest/knowledge-coverage/data-quality/discipline-audit/grade-assets/verify-replay/surface-consume/pipeline-validate/coverage-report/l2-collect/dsh-version-watch/vision-triage/vault-export-build）+ 根目录运维脚本（setup/seed×3/tools-manager/intel-refresh/retention/backup/restore/upgrade/proxy×3/fofa_search/backfill-program/migrate×2/import-cyberstrikeai/embeddings-setup/headless-failover-setup/settings-mirror-patch/sec-*-plugin-setup×6/theme-setup） | 目录实查 |
| 配置/环境 | settings.yaml（Bellkeeper pool-secagent 路由）/ cordis.patch.yml（auth-gate/connection 365d/browser path/model-failover）/ headless.cordis.patch.yml / .env 6 键 / scope.yml / AUTHORITY.md / AGENTS.md 受管区块 | 文件实查 |
| 边缘基础设施 | edge-Caddyfile（:3080→3081 Host/Origin 改写绕 loopback 栅栏；:9223 共享浏览器 basicauth + DevTools 自托管反代）、oob/interactsh-server（未启用，阻塞公网 NS 委派）、xray/config.yaml（被动扫描 7777→webhook 7788） | 文件实查 |

### 1.2 审计口径

- ✅ **覆盖完全**：v5 有明确归属域 + 动词/查询/文件 owns + 现状映射行级条目。
- 🟡 **部分覆盖**：能力有归属，但实现/部署/供给面细节缺失，或仅计数式覆盖未点名。
- ❌ **缺失**：v5 全部 19 份文档 grep 无命中（能力无归属域、无迁移条目、无 open question）。

---

## 二、覆盖矩阵总表

### 2.1 systemd 服务单元（13 个）

| # | 实况单元 | v5 覆盖 | 证据（v5 文档落点） | 结论 |
|---|---|---|---|---|
| 1 | silksecagent.service（node web 宿主） | 有 | 01-bus §2.7 setup.sh 冒烟、18-migration Phase 全程 | ✅ |
| 2 | silksecagent-edge.service（caddy :3080→3081） | **无** | 全目录 grep `edge|caddy|3080|3081` 仅命中无关文本；loopback 绕行机制无文档 | ❌ 缺漏 G-1 |
| 3 | silksec-shared-browser.service（CDP 9222 常驻） | **无** | grep `9222|shared-browser|共享浏览器` 零命中 | ❌ 缺漏 G-2 |
| 4 | silksec-xray.service（被动流量总线 :7777） | 半 | 10-exec L24/L219 只写 webhook **7788 落点**；**7777 入口**（浏览器出口代理）无文档 | 🟡 缺漏 G-2 关联 |
| 5 | silksec-proxy-rotator.service（mubeng） | 有 | 13-proxy §2.3/§2.6（`-w` watch 热加载、rotator_status） | ✅ |
| 6 | silksec-proxy-refresh.service/.timer | 有 | 13-proxy L44（trigger_collect→systemctl start，单元名沿用 v4） | ✅ |
| 7 | silksec-intel.timer（nuclei 模板每日更新→intel.jsonl） | **无** | grep `intel-refresh|silksec-intel` 零命中（intel_hunt 只是模板**消费**方） | ❌ 缺漏 G-3 |
| 8 | silksec-backup.timer（VACUUM INTO 快照） | 有 | 18-migration 0.4 / 02-vuln §3.3 / 03-asset §3.3 / 12-report §3.3 | ✅ |
| 9 | silksec-retention.timer（flows/results/audit 清理） | 有 | 01-bus L107（audit 轮转沿用 retention.sh）、10-exec L409（results 30 天不动） | ✅ |

### 2.2 自研插件（10 组）

| # | 实况插件 | v5 覆盖 | 证据 | 结论 |
|---|---|---|---|---|
| 1 | sec-suite 8 文件 | 全量 | 10-exec §3.1 映射表（27 行逐条）；02/03/04/05/06/08/09/14/15 各域 §3.1 行级映射 | ✅ |
| 2 | sec-memcore | 全量 | 01-bus §2.9（治理旁路不开后门）+ 06-fact/07-know lifecycle 映射 + 18-migration L65/L77/L106 | ✅ |
| 3 | sec-pipeline 8 工具 | 全量 | 01-bus L568-573 别名表 8 条全映射（attempts/card_usage/radar/coverage/validate→ledger；verify_replay→vuln；surface_queue/scan→endpoint） | ✅ |
| 4 | sec-dashboard（182KB client） | 全量 | 16-dashboard §1.7 v4 53 case 逐个去向 + 十视图 + §3.1 组件拆分行级 | ✅ |
| 5 | proxy-pool 6 工具 | 全量 | 13-proxy（proxy_refresh/report_bad/sticky_bind 命令 + stats/get/list/gateway 查询） | ✅ |
| 6 | theme-silksong | 有 | 16-dashboard L52/L314「零改动」+ 视图插件 theme token 纪律 | ✅ |
| 7 | **@silksec/dsh-browser fork** | **无** | grep `dsh-browser|sec-browser|browser-manager` 19 份文档零命中；fork patch（proxy 注入）、tarball、upstream 双文件无迁移条目 | ❌ 缺漏 G-2 |
| 8 | **embeddings 模块**（@huggingface/transformers + onnx q8 + SEC_EMBEDDINGS 动态加载 + HF_HOME 缓存 + fail-open 降级） | 半 | 07-know 覆盖 embedding **用法**（384 维表、≥0.95 合并）；**加载机制/部署（embeddings-setup.sh）/降级语义**零覆盖 | 🟡 缺漏 G-4 |
| 9 | dsh-auth-gate 0.7.2 | 有 | 01-bus L183（operator 注入与 auth-gate 对齐）+ Q4 回退方案 | ✅ |
| 10 | dsh-model-failover 0.1.4 | 有 | 17-llm-surface §3.1「零改动」+ settings.yaml 模型层不动 | ✅ |
| 11 | dsh-bill 0.13.1 | 有 | 17-llm-surface L310「零改动」+ §2.6 Q1（Phase 5 拿 dsh-bill 实测 token） | ✅ |
| 12 | dsh-sentinel（BLOCKED 已移除，职责由 intel.timer+xray webhook 承担） | 有（职责面） | intel.timer 职责→缺漏 G-3；xray webhook→10-exec exec_flow_append | 🟡 随 G-3 |
| 13 | **plugins.lock 治理纪律**（社区插件 pin+integrity+先扫后装） | **无** | grep `plugins.lock|先扫后装|integrity` 零命中；纪律本体在归档 dsh-secagent-plan-v6 | ❌ 缺漏 G-5 |

### 2.3 v4 模型工具面（67 个）逐组映射

| v4 工具（实况 `name:` 提取） | v5 动词/查询 | 落点 | 结论 |
|---|---|---|---|
| **asset-graph.js 38 个**：asset_add / asset_query / asset_stats / fp_add / fp_query | asset_upsert / asset_query / asset_stats / fp_record / fp_query | 03-asset §1.2/§1.4 | ✅ |
| endpoint_add / endpoint_query | endpoint_upsert / endpoint_query（+ 新增 mark_auth/queue/consume） | 04-endpoint | ✅ |
| finding_add / finding_query / finding_update | vuln_register_signal / vuln_list / vuln_get + confirm/reject/submit/note 拆分 | 02-vuln §3.1 L703（updateFinding 200 行混合动词拆分表） | ✅ |
| submission_draft | report_draft_submission（别名） | 12-report §1.2 | ✅ |
| blackboard_set / blackboard_get | fact_bb_publish / fact_bb_read（别名） | 06-fact §1.2 命名说明 | ✅ |
| task_create/schedule/run_now/update/list/next/stats | task_create/schedule/run_now/update_note/block/resume/cancel/list/next/stats | 05-task C1-C8 | ✅ |
| fact_upsert/get/search/link/graph/reindex + neg_check | C1/C9 + Q1-Q7（neg_check 保留） | 06-fact | ✅ |
| eval_stats | eval_stats Q1 | 15-eval | ✅ |
| cred_add / cred_query | cred_add / cred_query | 08-scope | ✅ |
| fgs_add/update/list/next/export | fgs_add + start/complete/fail/block/deprecate/annotate/clear（update 降级别名） | 14-fgs §1.2 命名说明 | ✅ |
| asset_graph | asset 域图谱查询族 | 03-asset | ✅ |
| report_build | report_build | 12-report | ✅ |
| program_list | program_list（scope 域） | 08-scope | ✅ |
| **sec-suite.js 15 个**：run_cli / grep_result / page_result | exec_run_cli / exec_grep_result / exec_page_result | 10-exec §1.2/§1.4 | ✅ |
| burp_import / spawn_worker / worker_status / worker_list | exec_burp_import / exec_spawn_worker / task_worker_status / task_worker_list | 10-exec L586 | ✅ |
| intel_hunt / plan_chain / task_chain | exec_intel_hunt / exec_plan_chain / task_chain（C9） | 10-exec L196 / §1.4 / 05-task | ✅ |
| approval_request | approval_request | 09-approval | ✅ |
| **authz_diff（双会话重放越权对比 harness）** | **悬空** | 10-exec L570 声称归 vuln 域 `vuln_authz_diff`，**02-vuln C1-C10 与 Q1-Q6 均无此动词**；04-endpoint 只提 auth_mark_mark 回填 | ❌ 不一致 U-1 |
| **sec-pipeline 8 个** | 全部映射（见 2.2 #3） | 01-bus 别名表 | ✅ |
| **proxy-pool 6 个** | 全部映射（见 2.2 #5） | 13-proxy | ✅ |

> 计数自洽性验证：v5 声称「v4 约 67（38+15+8+6）→ v5 约 118」与实况提取数**完全一致**（17-llm-surface L65）。

### 2.4 tools.d manifest（31 个）

| 项 | v5 覆盖 | 结论 |
|---|---|---|
| 31 个计数 + 字段全集（name/binary/stage/risk/timeout/target_param/requires/produces/args_template/env_proxy/parser/sandbox + v5 新增 domain + 废止 store） | 10-exec §2.1.1 表格 | ✅ |
| store 直写废止迁移三分类（parser 类/治理脚本类/l2-collect） | 10-exec L390-394 | ✅ |
| grade_assets / vision_triage（proposal 纯计算化） | 10-exec L393 + 03-asset §1.3 + 17-llm-surface L222 | ✅ |
| l2-collect TSV→proposal + endpoint_upsert 批量入库（修复 114 行 vs 6594 行断层） | 04-endpoint §3.1 | ✅ |
| data_quality / discipline_audit manifest | 部分提及（discipline-audit 悬空引用断言多处；data_quality 见 17-llm-surface L221 每日复跑） | ✅ |
| **fofa_search**（被动测绘 API 通道 + fofa_search.sh 安装 + FOFA 账号/凭证供给） | **grep 全文档零命中**——仅被"31 个"计数式包含 | 🟡 缺漏 G-6 |
| echo-test（测试 manifest） | 未点名（可豁免） | ✅ 豁免 |

### 2.5 数据表/存储（21 张表 + 文件树）

| 表/文件 | 归属域 | 结论 |
|---|---|---|
| findings + data/evidence/ | vuln | ✅ |
| assets / fingerprints | asset | ✅ |
| endpoints + param-queue | endpoint | ✅ |
| tasks / task_runs / workers | task | ✅ |
| facts / fact_edges / blackboard | fact | ✅ |
| exp_cards / exp_embeddings / kb_docs / kb_embeddings / playbooks + rules/ + vulncards/ + harvest/ + vault-export-cards/ + AGENTS.md 区块 | know | ✅ |
| scope.yml + programs + credentials | scope | ✅ |
| approval_requests | approval | ✅ |
| tools.d/ + results/ + flows/ + imports/ | exec | ✅ |
| pipeline/{program}/ 台账五产物（attempts/card_usage/radar/handoff/coverage） | ledger | ✅ |
| reports/ 全树含 submissions/ | report | ✅ |
| pool.json/live/blocklist/stats/sticky | proxy | ✅ |
| fgs_nodes | fgs | ✅ |
| data/eval/ 全目录 | eval | ✅ |
| memcore_events / memcore_meta | bus/memcore 旁路 | ✅ |

### 2.6 知识/规则/提示词资产

| 资产 | v5 覆盖 | 结论 |
|---|---|---|
| rules/ 79 篇（techniques 47 + cases 22 + src 4 + srcskill 2 + web 3 + php 1） | 07-know Q8「79 篇规则索引」+ C14 rule_seed + 17-llm-surface 改写清单 | ✅ |
| vulncards 18 张 + IC ideas + registry.md | 07-know C15-C18 + registry 健康度 | ✅ |
| skills 7 个（sec-blackboard/knowledge/pipeline/review/runtime-discipline/task/verification） | 17-llm-surface L345 改写清单 | ✅ |
| skills/draft 目录 | 未点名 | 🟡 轻微 |
| presets 7 角色（.agent-presets/*/agent.cordis.yml，persona_version 4） | 17-llm-surface L344 + 05-task L700/L747（personaCache mtime 校验） | ✅ |
| technique-index.md 短表 | 17-llm-surface L279/L344 改写对象 | ✅ |
| AGENTS.md 受管区块（memcore + 新增 secbus） | 07-know §2.1 + 01-bus L69 | ✅ |
| **AUTHORITY.md**（操作员授权声明，防模型拒答） | **grep 全文档零命中** | ❌ 缺漏 G-7 |
| knowledge/ 205 篇 + vault 回流链（rsync 192.168.7.230） | 07-know §2.3 导出桥 + L729 | ✅ |

### 2.7 脚本层

| 脚本 | v5 覆盖 | 结论 |
|---|---|---|
| ct-watch-all.sh / js-watch.py（雷达直写） | 11-ledger L114/L483（改调 ledger_radar_push CLI + inbox 收割观察期） | ✅ |
| kb-harvest.py | 07-know C19 harvest_ingest | ✅ |
| knowledge-coverage.py + knowledge-coverage.json | 16-dashboard L174（缓存卡 + 域查询） | ✅ |
| discipline-audit.py | 00-conventions L303 + 17-llm-surface L350（悬空工具引用断言） | ✅ |
| data-quality.py | 17-llm-surface L221（每日增项复跑） | ✅ |
| grade-assets.py | 03-asset proposal 模式（直写归零） | ✅ |
| verify-replay.py / surface-consume.py / l2-collect.sh / pipeline-validate.py / coverage-report.py | 11-ledger/02-vuln/04-endpoint 各域映射 | ✅ |
| vision-triage.mjs（视觉模型分诊） | 03-asset vision_triage（proposal 源）；**但视觉模型供给（OPENCODE_GO vision）未写** | 🟡 缺漏 G-8 |
| **dsh-version-watch.sh**（上游版本监控→pipeline/dsh-version-watch.log） | grep 零命中（ledger 的 `version-intel` 雷达类型是组件指纹版本，非上游 DSH 版本监控） | ❌ 缺漏 G-9 |
| **tools-manager.sh + tools.list**（go/bin/apt/pip 四通道安装升级） | grep 零命中（v5 只管 manifest 不管安装通道） | ❌ 缺漏 G-10 |
| **seed-manifests.sh** | 10-exec L396（停止生成 store 字段）| ✅ |
| seed-skills.sh | 07-know L747（C14 rule_seed install+cmp 语义沿用） | ✅ |
| **seed-presets.sh** | grep 零命中（persona 文件改写有清单，部署种子脚本无条目） | 🟡 轻微 |
| intel-refresh.sh | 零命中（同 G-3） | ❌ G-3 |
| retention.sh / silksec-backup.sh / silksec-restore.sh | 01-bus L107 / 18-migration 0.4 | ✅ |
| dsh-upgrade.sh | 01-bus L498（dump-config 深冒烟沿用）+ 18-migration §九 | ✅ |
| proxy_grade.py / proxy-pool-infra-setup / proxy-pool-plugin-setup / proxy-scraper-checker.toml | 13-proxy §3.1/L415-418（--proposal-only 拆段 + 单元改造点） | ✅ |
| **fofa_search.sh** | 零命中（同 G-6） | 🟡 G-6 |
| **backfill-program.js / migrate-blackboard-to-facts.js / migrate-scheduled-tasks.js / import-cyberstrikeai.py** | 零命中（一次性/历史脚本） | ✅ 豁免（建议在 18-migration 附录点名「已消费，v5 不迁移」） |
| embeddings-setup.sh | 零命中（随 G-4） | 🟡 G-4 |
| headless-failover-setup.sh / settings-mirror-patch.sh / sec-*-plugin-setup.sh ×6 / theme-silksong-plugin-setup.sh | 13-proxy L418（plugin-setup 归 setup 脚本链）+ 18-migration §九「部署通道沿用」概括覆盖 | 🟡 概括式，建议 18-migration §九列全清单 |
| eval-fp.js / eval-run.js / eval-cases.list / eval-fp-cases.jsonl | 15-eval（fp 域命令化 + range 保留脚本形态 L301/L324） | ✅ |

### 2.8 配置/环境变量/边缘基础设施

| 项 | v5 覆盖 | 结论 |
|---|---|---|
| settings.yaml（Bellkeeper pool-secagent 默认路由 + retry 5 + 三供应商） | 17-llm-surface §3.1 零改动 | ✅ |
| cordis.patch.yml（auth-gate password 模式 / connection cookie 365d / browser executablePath / model-failover 熔断链） | 模型层条目 ✅；**browser executablePath 条目随 G-2 缺失** | 🟡 G-2 |
| headless.cordis.patch.yml（worker 侧 failover） | 17-llm-surface L313（任务级模型覆盖 P18 不变） | ✅ |
| .env：BELLKEEPER_LLM_API_KEY / DEEPSEEK_API_KEY / OPENCODE_GO_API_KEY | 15-eval L247（环境变量引用零明文） | ✅ |
| .env：SEC_EGRESS_PROXY | 10-exec §1.3 env_proxy | ✅ |
| .env：SEC_PROXY_POOL_DIR | 13-proxy §1.1 owns | ✅ |
| **.env：SEC_FLOW_PROXY**（浏览器出口→xray 7777） | 零命中（随 G-2） | ❌ G-2 |
| **edge-Caddyfile :3080 loopback 栅栏绕行 + BrowserAuth cookie 365 天机制** | auth-gate operator 注入有文档（01-bus L183）；**edge 反代层与 BrowserAuth 会话机制零文档** | ❌ G-1 |
| **edge-Caddyfile :9223 浏览器入口（basicauth + browser.html + DevTools 自托管反代）** | 零命中（随 G-2） | ❌ G-2 |
| **oob/interactsh-server**（OOB 带外验证，阻塞公网 NS 委派） | 零命中（v5 vuln 域无 OOB 证据通道预留） | ❌ 缺漏 G-11 |
| xray/config.yaml（被动扫描配置） | webhook 落点有（10-exec）；扫描器配置本体未提 | 🟡 随 G-2/G-3 |
| scope-guard + S5 写动词守卫 + bwrap 沙箱 + QPS 令牌桶 | 10-exec 守卫链 G0-G5 + §2.2.4 + 09-approval 接线点① | ✅ |
| 审批 kind 注册表 6 个（实况） | 09-approval §2.2.2 七 kind（新增 task-complete）全量声明式化 | ✅ |
| memcore 五原语（validateWrite/visibilityFilter/transition/recordSignal/sweep） | 06-fact/07-know lifecycle 映射 + 01-bus §2.9 | ✅ |
| 工作区绑定（workspace: 美团SRC/字节SRC）+ sessions 归组 reconcile | 05-task §2.3 + 16-dashboard workspaces/sessions 平台面 | ✅ |
| findings/bytedance.jsonl（scope.yml finding_db 字段） | 08-scope finding_db 字段 | ✅ |

---

## 三、缺漏清单（按严重级排序）

### 高危（功能能力整体无归属）

#### G-2 浏览器共驾子系统完全缺失 🔴
- **实况**：`silksec-shared-browser.service`（CDP 9222 常驻 Chromium，持久化 profile=登录态，人机共用）+ `@silksec/dsh-browser` fork（tarball + `dsh-browser-upstream.index.js`/`browser-manager.js` patch 注入 `SEC_FLOW_PROXY` 出口代理）+ edge :9223 入口（basicauth + browser.html 落地页 + DevTools 前端自托管反代）+ `sec-browser-plugin-setup.sh`。归档 system-complete.md §4.6 有完整解剖。
- **v5 现状**：19 份文档 grep `dsh-browser|sec-browser|browser-manager|9222|9223|SEC_FLOW_PROXY` **全部零命中**。README 分层总图的"DSH 平台层（不动）"清单未列 browser；17-llm-surface §3.1 零改动表也未列。
- **影响**：① 迁移期该链路无归属声明，Phase 重构若触碰 sec-suite 或 edge 配置可能静默断裂；② H-002（登录态承载）依赖面无设计衔接；③ `SEC_FLOW_PROXY=7777` 流量总线入口缺失导致 xray 被动审计链路只被文档化了一半（7788 出口有、7777 入口无）。
- **修改建议**：在 10-exec 增加「§平台资产声明（不动清单）」或在 17-llm-surface §3.1 零改动表补 browser 行；01-bus §2.7 setup.sh 冒烟增 edge-Caddyfile + :9223 探活断言；18-migration §九部署通道补 sec-browser-plugin-setup.sh。

#### G-11 interactsh OOB 带外验证通道缺失 🔴
- **实况**：`oob/interactsh-server` 二进制 + `interactsh.service.prepared`（占位 `OOB_DOMAIN_TBD`），阻塞公网 NS 委派（归档 system-complete L55）。**未启用但已部署**。
- **v5 现状**：零命中。vuln 域证据引用只支持 `run_id/flow_id/burp_item/evidence/` 四类（02-vuln L58），**盲 SSRF/盲 RCE/回显类漏洞的带外证据通道（interactsh URL/oob 域名命中）无接口预留、无 open question**。
- **修改建议**：02-vuln §四开放问题增「OOB 证据通道」（evidence 引用类型扩展 `oob:` 前缀 + interactsh 轮询查询归属 exec 还是 vuln）；或在 10-exec 平台资产不动清单点名并注明 DNS 委派阻塞现状。

### 中危（能力有归属但实现面断档）

#### G-1 edge 反代层（silksecagent-edge :3080→3081）无文档 🟠
- loopback 特权栅栏绕行（Host/Origin 双改写）是 **Web UI 唯一可用的 LAN 访问路径**（curl 不带 Origin 会得假阳性——归档有教训记录）。v5 的 RPC authority loopback 设计依赖这条链路存在，但文档从不提。修改建议：18-migration §九部署通道 + 01-bus §2.7 冒烟清单补 edge 单元。

#### G-3 silksec-intel.timer（nuclei 模板每日更新）无归属 🟠
- 实况：每日更新 `~/nuclei-templates` → 计数变化写 `data/intel/intel.jsonl`（afrog 已摘除）。v5 有 intel_hunt（模板消费）与 10-exec 开放问题 O-1（$HOME 可写因模板更新需要——间接承认），但**更新通道本体（timer/intel-refresh.sh/intel.jsonl）无归属无迁移条目**。且 01-bus L547 把 `data/intel/intel.jsonl` 列为「统一为 data/events」的 appendFile 模式，却没说由谁在 v5 落 event。修改建议：10-exec §1.5 或 03-asset fp.recorded 事件族补「模板库版本事件」来源声明。

#### G-4 嵌入模型运行设施半覆盖 🟠
- 07-know 把 embedding 写进事务边界与表结构（✅），但 **`SEC_EMBEDDINGS` file:// 动态加载、@huggingface/transformers + onnx q8、HF_HOME 模型缓存（首载 ~120MB）、预热失败永久降级、embeddings-setup.sh 部署**零覆盖。混布 http-remote 后端（Q1-Q7 partial）时向量检索降级路径有声明，但本地后端的运行前提没有。修改建议：07-know §2.3 或 §3.3 增「嵌入模块加载与降级」小节。

#### G-5 plugins.lock 社区插件治理纪律未重申 🟠
- v5 README 只说「版本受控源文件在 bundles/dsh/templates/」，但 **第三方插件 pin 版本 + sha512 integrity + 先扫后装 + BLOCKED 处置**的治理纪律（v4 的核心安全实践）只在归档。v5 引入 14 个新域插件后供应链面扩大，纪律更应显式继承。修改建议：00-conventions §十四安全基线或 18-migration §九补一段。

#### G-7 AUTHORITY.md 授权声明文件无文档 🟠
- 实况 `data/AUTHORITY.md`（操作员授权声明，防模型安全护栏拒答，声明 scope.yml 唯一权威 + 合规约束）。它是 **prompt 层运行资产**，与 scope.yml 同级重要。v5 的 08-scope 只文档化了 scope.yml。修改建议：08-scope §1.1 owns 或 17-llm-surface §2.5 prompt 体系对接补「AUTHORITY.md 注入策略」（谁注入、何时刷新、与 scope 域的关系）。

### 轻微（点名缺失/供给面未写）

#### G-6 fofa_search 通道 🟡
- tools.d 有 `fofa_search.yaml`（被动测绘，API 通道），v5 只被"31 个"计数包含，`fofa` 关键词全文档零命中；`fofa_search.sh` 安装（seed-manifests 装到 /usr/local/bin）与 FOFA 账号凭证供给无条目。修改建议：10-exec §2.1.1 附近列 31 manifest 完整清单（一次解决所有点名问题），或在 03-asset 被动测绘来源提一句。

#### G-8 vision_triage 视觉模型供给 🟡
- 实况 `scripts/vision-triage.mjs` 依赖 `OPENCODE_GO_API_KEY`（deepseek-v4-flash-vision-exp），失败回退 DEEPSEEK。v5 把 vision_triage 当 proposal 源（03-asset），视觉模型供给与 key 依赖未写。修改建议：03-asset §1.3 asset_grade 处补一行供给说明。

#### G-9 dsh-version-watch 🟡
- 上游 DSH 版本监控脚本（→ pipeline/dsh-version-watch.log）无 v5 归属。注意与 ledger 雷达 `version-intel`（组件指纹版本）语义不同。修改建议：18-migration §九或 11-ledger radar type 表补注区分。

#### G-10 tools-manager.sh / tools.list 🟡
- 工具安装升级四通道（go/bin/apt/pip）+ 版本统一切换窗口，v5 只管 manifest 不管安装。修改建议：18-migration §九部署通道补点名。

#### 其他轻微项
- `skills/draft` 目录（07-know 可一句带过）；`seed-presets.sh`（17 §3.3 有改写清单、部署脚本无名）；`xray/config.yaml` 扫描器配置本体；`proxy-scraper-checker.toml` 配置文件名（13-proxy 只写了产物契约）。
- **建议一次性动作**：18-migration §九「部署通道」从概括改为**完整脚本清单表**（约 25 个根目录脚本 + 15 个 pipeline 脚本逐一列 v5 去向）。

### 不一致修正项

#### U-1 authz_diff 悬空引用 🔴（跨文档矛盾）
- 10-exec.md L570 映射表写「authzDiff → **vuln 域**（`vuln_authz_diff`，02-vuln.md）」，但 **02-vuln.md 命令表 C1-C10 与查询 Q1-Q6 均无 `vuln_authz_diff`**；02-vuln 只在机器直灌示例中出现 authz_diff 作为 source。v4 的 authz_diff 是模型可用的双会话重放 harness（biz-logic 角色 persona 明确依赖），v5 工具面 118 个里它悬空。04-endpoint L195 也只写了"authz_diff 结果回流 proposal 经 endpoint_mark_auth"。
- **修改建议**（二选一，需用户裁决）：① 02-vuln 增 `vuln_authz_diff` 命令（双会话凭证重放 + 响应 diff + suspected 判定走 C2）；② 10-exec 映射改为 exec 域保留（如 `exec_authz_diff`），修正 L570 行。倾向①（判定与候选登记是漏洞域语义，10-exec 自己的论证）。

#### U-2（顺带核对，无矛盾）v4 工具计数 67 / tools.d 计数 31 / 表清单与实况**完全一致**；approval kind 6→7（新增 task-complete，C16/C17 三段式收尾有完整设计）为有意扩展，非遗漏。

### 豁免清单（核实为一次性/历史产物，不构成缺漏）

| 项 | 理由 |
|---|---|
| backfill-program.js / migrate-blackboard-to-facts.js / migrate-scheduled-tasks.js | 一次性迁移脚本，v4.5/v4.6 已消费完毕 |
| import-cyberstrikeai.py | 一次性知识导入源 |
| echo-test.yaml | 测试 manifest |
| assets.db / sec-suite.db（0 字节空文件） | 历史遗留空库 |
| run-targets.txt | 历史运行参数 |
| cordis.patch.yml.bak-* / scope.yml.bak* | 备份文件 |

---

## 四、修改落点汇总（供定稿评审排期）

| 优先级 | 缺漏 | 修改文档 | 动作 |
|---|---|---|---|
| P0 | U-1 authz_diff | 02-vuln（或 10-exec） | 裁决归属并补动词定义 |
| P0 | G-2 浏览器子系统 | 10-exec/17-llm-surface/01-bus/18-migration | 平台不动清单 + 冒烟断言 + 部署通道 |
| P1 | G-11 OOB 通道 | 02-vuln §四 | 开放问题 + evidence 引用类型预留 |
| P1 | G-1 edge 反代 | 18-migration §九 / 01-bus §2.7 | 单元清单 + 冒烟 |
| P1 | G-3 intel.timer | 10-exec §1.5 / 03-asset | 模板版本事件来源声明 |
| P2 | G-4 嵌入设施 | 07-know §2.3 | 加载/缓存/降级小节 |
| P2 | G-5 plugins.lock 治理 | 00-conventions §十四 | 供应链纪律继承段 |
| P2 | G-7 AUTHORITY.md | 08-scope 或 17-llm-surface | prompt 资产注入策略 |
| P3 | G-6/G-8/G-9/G-10/轻微项 | 10-exec/03-asset/11-ledger/18-migration | 点名补全；§九改完整清单表 |

> 审计方法可复现：所有「零命中」结论 = `grep -rn <关键词> doc/secagent/v5/*.md` 空结果；所有实况数据 = `spool exec csai` 于 2026-09-06 采集。
