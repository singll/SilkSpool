# 18 · 迁移路线图（Phase 0-5 · 部署 · 回滚 · 数据修复）

> 版本：v5.0 ｜ 状态：定稿 ｜ 前置：全部 00-17 模块文档定稿（用户评审通过）后方可启动对应 Phase 的代码动工
> 本文是 v4.x 单体 → v5 领域插件化的**唯一**迁移计划。原则：**文档先行、每阶段独立可回滚、热修不等重构、重构期间每日链路（03:00/04:00 任务）中断不超过一个调度周期。**

---

## 一、总原则

1. **文档定稿门槛**：某域的模块文档状态必须是 `定稿`，该域代码才允许动工。Phase 1 只需要 00/01/02/17/18 定稿。
2. **一域一提交**：每个域的搬迁是一次独立 commit + 部署 + 观察，可单独 revert。
3. **兼容别名贯穿**：v4.x 旧工具名经总线 aliases 映射到新动词（同样过网关全管线），prompt/objective 里的旧引用在别名期内新旧皆可——**调度任务 objective 不需要为重构而改**。
4. **不动表名不迁库**：sqlite-local 后端直接接管现表；列级演进走域内 ensureCol（幂等）。
5. **每日验证锚点**：每 Phase 收尾跑四件套——契约测试（新）、discipline-audit.py、data-quality.py、看板 ops 红条；03:00/04:00 任务次日照常出 handoff 即"链路未断"的判据。

## 二、Phase 0 —— 候选池缺陷热修（0.5 天，不等 v5）

**目标**：止血 v4.x 最疼的缺陷（实测：58 条候选中 31 条已 confirmed 仍挂候选徽章且被信号面隐藏）。

| 步骤 | 内容 | 验收 |
|---|---|---|
| 0.1 | `updateFinding`（asset-db.js）：status 进入 confirmed/submitted 时同事务 `noise=0`；进入 false_positive/dup/ignored 时行保留但候选口径不再计入 | 单测：确认→候选计数-1、信号计数+1 |
| 0.2 | KPI 口径：`stats()/opsHealth()` 的 `findings_noise` 改为 `COUNT(*) WHERE noise=1 AND status='new'`（宪法 §十一候选池定义） | 看板候选徽章 = 实际待验证数 |
| 0.3 | 数据修复脚本（幂等可重跑 + dry-run）：31 条 confirmed+noise=1 → noise=0；其余终态行仅口径修正不动数据 | dry-run 输出 diff 人工过目后执行 |
| 0.4 | 备份先行：silksec-backup VACUUM INTO 快照（既有 6h timer 之外手动加一次） | 快照存在且可 silksec-restore.sh 演练 |

> Phase 0 在 v4.x 代码上做（asset-db.js 直接改），**v5 vuln 域上线后该热修代码被 02-vuln.md 的候选状态机自然取代**。

## 三、Phase 1 —— 总线 + vuln 试点域（~1 周）

前置：00/01/02/17/18 文档定稿。

| 步骤 | 内容 | 产出 |
|---|---|---|
| 1.1 | `@silksec/sec-domain-bus` 插件：Registry/CommandGateway/QueryGateway/EventBus/ToolProjector/RpcProjector + idempotency 表 + audit v5 + aliases | bus 契约测试全绿 |
| 1.2 | `@silksec/sec-domain-vuln` + `sec-backend-vuln-sqlite`：commands/queries 从 asset-db.js 平移（addFinding 闸门/updateFinding 拆语义动词/buildReport 段留 report 域暂不动） | vuln 契约测试全绿（宪法 §十三 8 用例类 × 全动词） |
| 1.3 | 双投影接线：ToolProjector 注册 `vuln_*` 工具；dashboard-rpc `findingUpdate/findingGet/findings` case 切 `vuln.*` RPC | --dump-config 组合树含新插件 |
| 1.4 | 兼容别名：finding_add/finding_query/finding_update/submission_draft → 新动词 | 旧 objective 原样跑通 03:00/04:00 |
| 1.5 | Phase 0 数据修复正式版（幂等脚本入 bundle） | 候选徽章与信号面一致 |
| 1.6 | 部署：仓库 bundles/dsh/ → rsync 管理机 → `spool bundle dsh setup csai` → setup §10 reconcile_service 重启（顺序教训 v4.6.1） | 冒烟 + 契约测试在 setup 内执行 |

**试点验收（Phase 2 放行条件）**：
- 三路写同一候选（模拟 xray webhook 重放 / 模型 vuln_confirm / parser proposal）→ 候选池计数三处一致；
- audit 三条记录 actor 可区分（webhook/model/script）；
- 幂等重放返回 replay:true；
- 连续 3 天 03:00/04:00 任务正常收尾（守卫过、handoff 出）。

## 四、Phase 2 —— 数据域滚动搬迁（每域 2-4 天，无依赖可并行）

顺序（按依赖×收益，task/exec 事件是多个域的基础、approval effect 依赖 scope/task/know 稳定命令，故提前）：**asset + endpoint → fact + know → ledger → task + exec → fgs → scope + approval → report / proxy / eval / dashboard**。

每域固定节奏：

```
契约定稿 → commands/queries 平移（从 asset-db.js/experience.js/对应文件）
→ 双投影 + 别名 → 契约测试 → 切流（旧函数改为内部调新动词或删除）
→ 部署观察 1 个调度周期 → 删旧路径
```

同步归位的跨域债（谁所属域上线谁改造）：

| 债 | 归属域上线时 |
|---|---|
| grade-assets.py Python 直写 → 纯计算 + asset_grade 命令 | asset |
| memcore 69 处裸 SQL → 域 lifecycle 命令（映射表见 06-fact.md） | fact（memcore 映射层随 fact/know 域分两批迁） |
| parser 直写 assets/endpoints/findings → exec.run.completed proposal | exec（Phase 2 末，需 asset/endpoint/vuln 三域已就位） |
| APPROVAL_KINDS onApprove 跨四域直写 → 事件 | approval |
| persistFgsFacts / appendFgsToHandoff 直写 → 事件协作 | fgs |
| sec-pipeline 8 工具直写文件 → ledger 域命令（写入即校验） | ledger |
| QPS mtime 轮询 → scope.rules.changed 事件 | scope |
| 看板 52 case 逐批切 RpcProjector（清单见 16-dashboard.md） | dashboard（Phase 2 期间滚动） |

## 五、Phase 3 —— 跨域事件化收尾（~3 天）

- 事件可靠性落地：`event_outbox` + dispatcher + `bus_subscription`（01-bus §2.2.5/§2.3）；强联动（sync 同事务）/弱联动（async outbox 派发）分级全量落地；approval 六 kind effect outbox 验收；
- `data/events/*.jsonl` 回放工具（bus replay）+ 一次演练（dispatcher kill/restart 后 outbox `pending` 续扫恢复；删一个 async 订阅者消费记录 → 回放恢复）；
- memcore 完全旁路化验收：`grep -c 'prepare(' sec-memcore` 仅剩自身迁移表；
- eval 域订阅上线（signal.confirmed/rejected 回流）；
- 部署验收命令集（R0/R4 契约化，线上 DSH CLI 路径实测为 `app/node_modules/@deepseek-ai/dsh/lib/bin.js`，非根目录 `bin.js`）：
  ```bash
  spool exec csai "systemctl is-active silksecagent silksecagent-edge silksec-xray silksec-shared-browser silksec-proxy-rotator ct-watch"
  spool exec csai "python3 /opt/silkspool/dsh/scripts/pipeline/data-quality.py --json"
  spool exec csai "test -f /opt/silkspool/dsh/data/AUTHORITY.md"
  spool exec csai "test -d /opt/silkspool/dsh/data/events"
  spool exec csai "node /opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config"
  spool exec csai "node /opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --dump-config"
  ```

## 六、Phase 4 —— http-remote 后端试点（vuln 域，~1 周）

**验收即用户原始场景**：把 vuln 后端切到外部漏洞管理系统（REST），asset/task/know/ledger 全链路无感知继续工作。

| 步骤 | 内容 |
|---|---|
| 4.1 | `sec-backend-vuln-http`：repository-http 实现 + 能力矩阵（远端不支持候选池 → 本地 sqlite overlay 混布，同步边界在 commands 层） |
| 4.2 | 同步策略：确认后推送远端 / 远端 ID 回写映射 / E_BACKEND_UNAVAILABLE 重试与降级（fail-closed，不静默） |
| 4.3 | 契约测试三后端同套跑（sqlite/http/file 中 vuln 适用的两套） |
| 4.4 | 切换演练：bundle 配置一行切换 + 回切（保底 sqlite 随时可回） |

## 七、Phase 5 —— LLM 面收敛 + 守卫加固 + 评测（~1 周）

1. prompt 体系全量改写：persona/objective/skills/technique-index 工具引用 → 新动词表（脚本化，p14-1-tool-refs.py 模式）；AGENTS.md 受管区块改为 manifest 生成。
2. 删兼容别名（逐个走宪法 §十五废弃三段式：deprecated → 7 天 audit 零使用 → 删除）。
3. worker 挂载矩阵实施（profile × actor 白名单）；setup.sh 冒烟断言 owns×sandbox 交叉校验。
4. eval 契约合规用例上线（模型越权必须被拒且 hint 可引导，见 15-eval.md）。
5. discipline-audit.py 增加"悬空工具引用"断言。
6. **复评"单写者守护进程"**：若 Phase 1-5 期间出现跨进程写冲突（E_CONFLICT 频发）或需要更强隔离，启动单写者架构专项；否则维持多进程+WAL 终态。

## 八、风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 每日链路中断 | 别名贯穿 + 每域独立提交 + Phase 1 试点验收门槛 | revert 单域 commit；别名层保旧 objective 可跑 |
| 契约设计错误 | 文档定稿评审 + vuln 试点先行验证表达力 | 契约 bump major（总线版本检查拦截不一致域） |
| memcore 治理断档 | 映射层 fail-open（治理缺席业务照跑）+ memcore_events 前后对照 | memcore 整体回退旧版（裸 SQL 版保留至 Phase 3 验收后删除） |
| 工具描述劣化影响模型 | agent_note 单一来源 + eval 契实用例 + 首周人工抽查 worker.log | 工具描述 hotfix（manifest 文本级，不涉代码） |
| 数据修复误伤 | dry-run + VACUUM 快照先行 + 幂等可重跑 | silksec-restore.sh 按快照恢复 |
| http-remote 不稳 | 能力矩阵 fail-closed + 本地 sqlite 保底 | bundle 配置一行切回 |
| 工程量失控 | 14 域滚动推进、每域 2-4 天、总线抽象只在试点验证后才铺开 | 任意 Phase 可暂停（v4.x/v5 混布态可长期共存——别名层保证） |

## 九、部署通道（沿用既有机制）

### 9.1 通道与红线

- 仓库 `bundles/dsh/` 改模板 → `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` → `spool bundle dsh setup csai`（模板按相对路径推送 + 各域 setup 脚本组装 + 契约测试 + reconcile_service 收尾重启）。
- 域插件组装：沿用 sec-*-plugin-setup.sh 模式（复制模板进 plugins/<name>/ + package.json + `dsh plugin add` + dump-config 冒烟）。
- 升级与回滚手册：归档 `../archive/dsh-upgrade-0.1.1-rc.2-report.md` §6 仍适用。
- **红线不变**：一切远程操作走 PATH 中 `spool`；n8n 等有状态服务与本迁移无关不受影响。

### 9.2 systemd 单元全景（13 个，csai 实查 2026-09-06）

| 单元 | 职责 | v5 去向 |
|---|---|---|
| silksecagent | DSH web 宿主（:3081 loopback） | 不动（域插件在同一宿主内挂载） |
| **silksecagent-edge** | Caddy 边缘：**:3080→3081** Host/Origin 双改写（绕 loopback 栅栏，**Web UI 唯一 LAN 入口**；curl 不带 Origin 会得假阳性——探活必带浏览器同形头）+ **:9223** 浏览器入口（basicauth + browser.html + DevTools 前端自托管反代）。operator 身份经 DSH 0.1.2 原生 **BrowserAuth**（cookie 365 天 + token 一次性兑换）注入，auth-gate operator 侧接线见 01-bus §1.7 | 不动（探活进 01-bus §2.7 §J 冒烟；Caddyfile 本体见 §9.5） |
| silksec-shared-browser | 常驻 Chromium（CDP :9222，登录态人机共用） | 不动（10-exec §2.7 不动清单） |
| silksec-xray | 被动扫描：浏览器/工具出口 :7777 → webhook :7788 | 不动（flows 数据入口，10-exec §2.7） |
| silksec-proxy-rotator | 代理池轮换 | 不动（proxy 域消费方，13-proxy） |
| silksec-proxy-refresh.{service,timer} | 代理池定期补充 | 不动 |
| silksec-intel.{service,timer} | 每日 nuclei 模板更新（intel-refresh.sh） | 不动（域外单写者声明，10-exec §2.7） |
| ct-watch | CT（Certificate Transparency）日志采集 → 雷达队列（ct-new-subdomain 事件源；日志含大量 HTTP 429，健康度见 11-ledger） | 不动（改调 `sec ledger radar-push` CLI，11-ledger §3.1 #12） |
| silksec-backup.{service,timer} | 每日备份（silksec-backup.sh VACUUM INTO） | 不动（回滚保障，§八依赖） |
| silksec-retention.{service,timer} | 30 天 retention | 不动 |

### 9.3 根目录脚本清单（与 v5 去向）

| 脚本 | 职责 | v5 去向 |
|---|---|---|
| setup.sh | 主部署入口（版本钉住 + 全链组装） | 沿用；v5 各域 setup 脚本挂进同一链 |
| dsh-upgrade.sh | DSH 平台升级（深冒烟） | 沿用 |
| **tools-manager.sh + tools.list** | CLI 工具**安装/升级四通道**（go / bin（预编译二进制下载）/ apt / pip），按 manifest `binary` 对账 | **沿用且地位不变**：manifest 只声明工具不负责安装——`exec_manifest_list` 报"工具缺失"时的处置入口仍是 tools-manager；v5 仅约定 manifest `binary` 路径须与 tools.list 安装路径一致（setup.sh 对账断言） |
| intel-refresh.sh | nuclei 模板每日更新 → intel.jsonl | 沿用（G-3，10-exec §2.7） |
| retention.sh / silksec-backup.sh / silksec-restore.sh | retention / 备份 / 恢复 | 沿用 |
| proxy-pool-infra-setup.sh / proxy-pool-plugin-setup.sh / proxy-pool-run-refresh.sh | 代理池基础设施 / 插件 / 定期补充 | 沿用（proxy 域迁移时仅换插件本体，infra 三脚本不动） |
| fofa_search.sh | FOFA 测绘 API 封装（装至 /usr/local/bin，凭证 .env 供给） | 沿用（fofa_search manifest 的 binary，10-exec §2.1.1） |
| seed-manifests.sh / seed-presets.sh / seed-skills.sh | tools.d / 角色预设 / 技能种子 | seed-manifests 停止生成 `store` 字段（10-exec §2.1.1 迁移）；其余沿用 |
| **sec-browser-plugin-setup.sh** | @silksec/dsh-browser fork 组装（tarball + upstream patch 注入 SEC_FLOW_PROXY） | **沿用**：浏览器共驾子系统 v5 零改动（G-2，10-exec §2.7 + 17-llm §3.1） |
| sec-suite-plugin-setup.sh 等 4 个 sec-*-plugin-setup.sh | v4 域插件组装 | Phase 1-2 随域化逐步退场，由 sec-{domain}-plugin-setup.sh 模式接管（01-bus §2.7） |
| theme-silksong-plugin-setup.sh | 主题插件组装 | 沿用 |
| embeddings-setup.sh | 嵌入模块预下载（HF 缓存预热） | 沿用（07-know §2.x 嵌入模块加载与降级） |
| headless-failover-setup.sh / settings-mirror-patch.sh | worker 模型故障转移补丁 / settings 镜像补丁 | 沿用（模型层零改动，17-llm §1.1） |
| eval-run.js / eval-fp.js | 评测运行器 / 误报评测 | eval 域接管（15-eval，runner 复用） |
| proxy_grade.py / grade 治理脚本 | 沙箱内纯计算（产 proposal） | 沿用（proposal 落库路径归域命令，17-llm §2.2 #3） |

### 9.4 scripts/pipeline/ 清单（15 个）

| 脚本 | v5 去向 |
|---|---|
| ct-watch.py / ct-watch-all.sh / js-watch.py | 情报源采集 → know 域 harvest 通道（07-know） |
| kb-harvest.py / knowledge-coverage.py | 知识库收割/覆盖 → know 域 |
| data-quality.py / discipline-audit.py / pipeline-validate.py | 治理观测 → 总线/eval 域每日复跑（discipline-audit 增"悬空工具引用"断言，17-llm §3.3） |
| grade-assets.py / l2-collect.sh | 纯计算产 proposal（10-exec §2.1.1 迁移表） |
| vision-triage（root vision_triage 通道） | 纯计算产 proposal（03-asset asset_grade 供给，视觉模型见 03-asset §1.3.2） |
| verify-replay.py | vuln 域 C9 复核的计算段（02-vuln） |
| surface-consume.py / coverage-report.py / vault-export-build.sh | 面板消费/覆盖报告/导出构建 → report/eval 域外围，沿用 |
| **dsh-version-watch.sh** | **沿用且独立于 ledger 雷达**：它监控**上游 DSH 平台版本**（升级可用性），与 11-ledger `version-intel`（目标组件指纹版本，radar type）语义不同源不同表——11-ledger §雷达 type 表有补注；v5 不合并 |

### 9.5 边缘配置资产

| 资产 | 内容 | v5 去向 |
|---|---|---|
| edge-Caddyfile | :3080→3081 Host/Origin 改写 + :9223 浏览器入口反代 + basicauth 凭证 | 不动（G-1；探活进 01-bus §2.7 §J） |
| xray/config.yaml | 被动扫描配置（:7777 监听 / webhook :7788 推送） | 不动（改配置属运维手册，不进域契约） |
| oob/interactsh-server | OOB 带外验证（已部署未启用，阻塞公网 NS 委派） | 启用时间表外部依赖；证据通道预留见 02-vuln §四.7 |
| cordis.patch.yml | auth-gate / connection 365d / **browser executablePath** / model-failover 熔断链 | browser 条目随浏览器子系统零改动保留（G-2） |
| .env 6 键 | 含 **SEC_FLOW_PROXY**（浏览器出口→xray :7777） | 不动 |
| AUTHORITY.md | 操作员授权声明（注入策略见 08-scope §1.1） | 沿用（G-7） |
| skills/draft、proxy-scraper-checker.toml | 技能草稿 / 代理抓取配置 | 沿用（无契约耦合） |

### 9.6 豁免清单（已消费，v5 不迁移）

以下一次性产物已完成历史使命，保留在仓库/bundle 只作考古，不进任何域：`backfill-program.js`（历史数据回填）、`migrate-blackboard-to-facts.js` / `migrate-scheduled-tasks.js`（v4 中期迁移）、`import-cyberstrikeai.py`（一次性导入）、`echo-test.yaml`（测试 manifest 保留为契约测试桩，§9.3 之外的唯一例外——它留在 tools.d 但 domain=none）、`dsh-version-watch.sh.bak-*`（备份残留）。

## 十、完成定义（DoD）

1. 12 条 v4.x 写路径（归档 v5 方案 §1.2 清单）全部收敛到 CommandGateway；
2. `grep` 验证：memcore 零裸 SQL、无 Python 直连 asset-graph.db、dashboard-rpc 无手写领域写 case；
3. 三后端契约测试在 CI（setup.sh 冒烟）全绿；
4. http-remote 试点验收通过（外部漏洞管理系统场景）；
5. eval 契约合规用例：模型越权 100% 被拒；
6. 每日链路连续 7 天无中断、候选池计数与信号面一致。
