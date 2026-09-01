# SilkSecAgent 系统全景文档（以运行代码为真相源）

> 版本：v1.1 ｜ 快照日期：2026-09-01 ｜ 主机：csai（192.168.7.107，非特权 LXC）
> **取证声明**：本文所有描述均基于 csai 上实际运行的代码与配置，经 `spool exec` 实测与 SilkSpool 仓库 `bundles/dsh/templates/` 源码比对；与早期设计文档冲突处，**以本文为准**。
> 文档体系定位：`README.md` 是唯一持续推进入口（状态/待办）；本文是**系统是什么、怎么转**的完整解剖，长期有效，随大版本更新。

---

## 目录

1. [部署拓扑与进程全景](#一部署拓扑与进程全景)
2. [DSH 底座：组合架构与利用面](#二dsh-底座组合架构与利用面)
3. [pi-ai 模型层：路由、熔断、多角色](#三pi-ai-模型层路由熔断多角色)
4. [自研插件解剖](#四自研插件解剖)
   - 4.1 sec-suite（工具执行/授权/调度/记忆/看板后端）
   - 4.2 sec-memcore（记忆治理引擎）
   - 4.3 sec-pipeline（流水线纪律工具）
   - 4.4 sec-dashboard + theme-silksong（看板 UI）
   - 4.5 proxy-pool（代理池）
   - 4.6 dsh-browser fork（共享浏览器）
5. [数据模型与状态机全集](#五数据模型与状态机全集)
6. [运行流程：从资产到提交](#六运行流程从资产到提交)
7. [提示词体系（实文位置与结构）](#七提示词体系)
8. [工具矩阵（tools.d manifest）](#八工具矩阵toolsd-manifest)
9. [脚本层（scripts/pipeline 等）](#九脚本层)
10. [合规与安全护栏](#十合规与安全护栏)
11. [部署与运维](#十一部署与运维)
12. [设计思想与关键取舍](#十二设计思想与关键取舍)

---

## 一、部署拓扑与进程全景

### 1.1 进程/服务清单（systemd，全部实测 active）

| Unit | 用户 | 监听 | 职责 |
|---|---|---|---|
| `silksecagent.service` | silkspool | 127.0.0.1:**3081** | DSH web 主进程。`node dsh/bin.js web --host 127.0.0.1 --port 3081`；`EnvironmentFile=/opt/silkspool/dsh/.env`（600）；`DSH_HOME=/opt/silkspool/dsh/data`；Restart=always/5s |
| `silksecagent-edge.service` | root（CAP_NET_BIND_SERVICE） | 192.168.7.107:**3080** | Caddy 边缘反代。`header_up Host/Origin → 127.0.0.1:3081`——**绕开 DSH rc 系 loopback 特权栅栏**（特权 API 校验 Origin.host===Host.host，双改写才能过；curl 不带 Origin 会得到"已修复"假阳性）。同时 ：9223 共享浏览器入口（basicauth `silksec`，落地页 edge-static/browser.html，`/serve_rev/*` 自托管反代 chrome-devtools-frontend，其余反代 127.0.0.1:9222） |
| `silksec-xray.service` | root | 127.0.0.1:**7777** | xray 被动扫描（pin 1.9.11，新版已变 xpoc 无被动模式）。`webscan --listen 127.0.0.1:7777 --webhook-output http://127.0.0.1:7788/xray`。ExecStartPre 把模板 xray.yaml 装到 /usr/local/bin（xray 只从可执行文件旁读主配置） |
| `silksec-proxy-rotator.service` | — | 127.0.0.1:**8899** | mubeng 轮换网关（每请求换出口、失败自动轮换剔除） |
| `silksec-proxy-refresh.timer/.service` | — | — | 每 30min：免费代理采集+验证+匿名度分级（proxy-scraper-checker + proxy_grade.py → pool.json/live.txt） |
| `silksec-shared-browser.service` | — | 127.0.0.1:**9222** | 常驻 Chromium CDP（持久化 profile=登录态凭据，人机共用） |
| `ct-watch.service` | — | — | CT 新证书雷达（certspotter API 轮询 30min，429 退避；calidog websocket 已验证不可用弃用）。命中 scope 后缀的新子域写 `data/pipeline/{program}/radar-queue.jsonl` |
| `silksec-retention.timer` | — | — | 每日 retention.sh：flows/results 30 天清理、audit.jsonl 超 50MB 轮转 |
| `silksec-backup.timer` | — | — | 每 6h `VACUUM INTO` 一致性快照（不阻塞在线写），保留 14 份 |
| `silksec-intel.timer` | — | — | 每日 nuclei/afrog 模板更新 → 计数变化写 `data/intel/intel.jsonl` |
| `interactsh.service`（**未装**） | — | :53/:8088 | OOB 带外服务器。二进制已部署 `/opt/silkspool/dsh/oob/`，unit 模板 `interactsh.service.prepared` 带占位符 `OOB_DOMAIN_TBD`——**阻塞在公网 NS 委派**（`ns1.oob.singll.net A → 141.11.43.99` + `oob.singll.net NS`，须域名服务商操作，spool dns 只管内网解析） |

### 1.2 目录布局（/opt/silkspool/dsh/）

```
app/                        DSH npm 应用（pnpm；pin 0.1.1-rc.2，dsh-upgrade.sh 管理）
data/  ← DSH_HOME           一切运行时数据（spool sync 管理其中 scope.yml/.env 镜像等）
  asset-graph.db(+wal/shm)  领域数据库（node:sqlite，WAL，busy_timeout 5s）
  scope.yml                 授权白名单（唯一权威，fail-closed）
  settings.yaml             模型配置（llm-pi-ai providers / 默认模型 / 默认 preset）
  cordis.patch.yml          本地覆盖层（auth-gate/browser 路径/model-failover）
  .env                      供应商 API key（600；systemd 注入；settings 只写 apiKeyEnv 引用）
  profiles/{web,headless}/  两个 profile 的 package.json（bundle 组合清单）
  plugins/sec-suite/ 等     自研插件组装产物（setup 脚本从 BASE_DIR 模板复制）
  tools.d/*.yaml            CLI 工具 manifest（32 个，含 1 个备份残留待清理）
  skills/<name>/SKILL.md    7 个技能 + rules/{web,php,src}/*.md 规则先验层
  .agent-presets/<role>/    7 个角色 preset（persona 文本 + agent 面插件行）
  AGENTS.md                 memcore 受管区块自动生成（Top 卡/env-issue/纪律）
  vulncards/                18 张漏洞卡 + ideas/ + registry.md
  pipeline/{program}/       每项目台账/接口面/雷达队列/交接包
  results/<run_id>/         每次 run_cli/spawn_worker 全量落盘
  flows/                    xray webhook JSONL（只有统计计数，无请求内容——已核实，参数面以 l2-collect 为准）
  reports/ report_build 产物 + submissions/ 提交草稿
  evidence/<finding_id>/    证据包（request/response/reproduce/falsification/verify-log）
  knowledge/ imports/ intel/ eval/ backups/ vault-export/ vault-import/ storages/ sessions/
scripts/pipeline/           管线脚本（l2-collect/ct-watch/js-watch/grade-assets/data-quality/…）
oob/                        interactsh-server 二进制（待 DNS）
venv/ opt/                  沙箱白名单只读挂载的 Python 环境/工具
plugins.lock                社区插件锁（pin+sha512+人工审查结论）
tools.list                  工具链清单（tools-manager.sh 按 go/bin/apt 三通道安装）
edge-Caddyfile              边缘反代配置
```

---

## 二、DSH 底座：组合架构与利用面

DSH（@deepseek-ai/dsh 0.1.1-rc.2）是 cordis（依赖注入容器）架构的 AI agent 平台。本平台对它的利用全部经过实测验证：

### 2.1 Profile 组合（data/profiles/*/package.json）

| profile | bundles |
|---|---|
| **web**（宿主面） | dsh-base、dsh-web-app、@silksec/dsh-proxy-pool、dsh-auth-gate 0.7.2、@silksec/sec-suite、@silksec/sec-memcore、dsh-model-failover 0.1.4、@silksec/dsh-browser（fork tarball）、dsh-bill 0.13.1、@silksec/sec-dashboard、@silksec/theme-silksong、@silksec/dsh-sec-pipeline |
| **headless**（worker 面） | dsh-base、dsh-headless、proxy-pool、sec-suite、model-failover、sec-memcore、sec-pipeline（**无 web-app/dashboard/browser**——无 UI 依赖，起得快） |

社区插件治理：`plugins.lock` pin 版本 + sha512 + 人工源码审查结论（auth-gate/model-failover/dsh-bill PASS；dsh-sentinel BLOCKED 已移除——client.js 未注册导致 Web UI 插件加载失败）；egress-guard/taintguard/chicheng-push 等 PENDING 未装。

### 2.2 关键机制与踩坑沉淀（全部有代码落点）

1. **cordis 插件双面加载**：插件被宿主面与每个 agent 面（worker 线程）分别加载，`globalThis` 不跨进程共享。→ 调度循环/webhook 只从入口侧用 `config.sidecars !== false` 收敛到宿主面启动（sec-suite.js apply 注入判断）；preset 的 agent 面挂载行写 `config: { sidecars: false }`。
2. **调度跨进程单例**：多进程各起调度循环会 `database is locked` → 文件锁 `data/scheduler.lock`（PID+心跳，3 分钟无心跳可抢占），丢锁自动重夺。
3. **loopback 特权栅栏**：特权 API 钉死 loopback + 校验 Origin → 边缘 Caddy 同步改写 Host 和 Origin；站点地址不匹配 Host 会静默回空 200（通配站点 `http://:3080` 解决）。
4. **workspaceRegistry / sessionPersistence**（web 面）：工作区注册表与会话头部投影，注入给 sec-suite 做 Program↔Workspace 配对、会话归组 reconcile（cwd 匹配 attachSession）、看板跳链。
5. **`exec.agent.id`（ToolRunContext）**：工具执行回调第二参携带会话 id——run→session 映射的捕获点；headless 面无此服务时 inject 回调不触发，自然降级。
6. **spawn_worker 复用 headless profile**：`node dsh --profile headless <task>` 子进程（detached 自成进程组，超时 kill 整组）；会话 header.cwd=工作区路径 → workspaceRegistry 自动归组。
7. **RPC 通道**：`connection.rpc.handle('/silksec-dashboard', handler, { authority: 'loopback' })`；connection 服务启动期会短暂重配（re-provide），用 module 级幂等守卫防重复注册。

---

## 三、pi-ai 模型层：路由、熔断、多角色

### 3.1 供应商与默认模型（settings.yaml，spool sync 管理）

- **主力**：`opencode-go`（OpenCode Go 套餐，pi-ai 内置目录端点 `https://opencode.ai/zen/go/v1` 自动继承），模型 `deepseek-v4-flash`，`reasoningEffort: max`，retryPolicy normal maxRetries 4
- **备用**：`deepseek`（官方直连 api.deepseek.com，同模型）
- key 零明文：settings.yaml 只写 `apiKeyEnv`，真值在 .env（600，systemd EnvironmentFile 注入）
- **视觉模型**（实测可用）：`deepseek-v4-flash-vision-exp`（OpenCode Go 目录内），vision-triage.mjs 使用
- 默认 preset：`vuln-hunt`（会话级可切换）

### 3.2 两级熔断（dsh-model-failover 0.1.4，cordis.patch.yml 覆盖层）

- fallbacks 顺序：opencode-go/deepseek-v4-flash → deepseek/deepseek-v4-flash → opencode-go/kimi-k2.7-code（限流严重时升级档位）
- 触发码：RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/QUOTA/EMPTY_RESPONSE；模型级阈值 2 次失败熔断 60s（探针恢复）；2 模型同熔 → 平台级 120s；burst 窗口 5min；`stripReasoningEffort` + 切换时 `notifyUser`
- headless worker 侧由 headless-failover-setup.sh 软链共享同一覆盖层（2026-08-24 线上修复固化）
- 已知边界：LLM 流式偶发挂起 failover 不认（只认显式失败）→ headless 进程可能空转不退出，靠 worker 超时组杀兜底

### 3.3 成本核算

dsh-bill 0.13.1 token 账本（session_projcache 里有 billTurns 逐轮 model/provider/tokens 记录）；外联仅汇率 API + DeepSeek 余额端点（已审查）。

---

## 四、自研插件解剖

> 自研插件零外部依赖（只用 node 内置模块）——根因：DSH pnpm 环境里 link: 安装领取不到 peer 依赖。组装方式：`sec-*-plugin-setup.sh` 把 BASE_DIR 模板复制进 `plugins/<name>/` + 生成 package.json + `dsh plugin --profile web|headless add` + `--dump-config` 冒烟（组合树校验）。

### 4.1 sec-suite（@silksec/sec-suite，8 文件）

```
index.js(1507) 主文件：scope-guard / run_cli / spawn_worker / authz_diff / intel_hunt / 工具注册 / RPC 挂载
asset-db.js(1294)      存储层：全表 DDL+迁移 / 领域 CRUD / 调度 SQL / 守卫 / opsHealth / submissionDraft
asset-graph.js(627)    模型工具面：33 个领域工具注册
scheduler.js(197)      调度循环（文件锁单例）
webhook.js(49)         xray webhook 接收器
dashboard-rpc.js(419)  看板 RPC 端点分发 + planChain/taskChain
experience.js(747)     经验卡/知识库/playbook + FTS5 + 向量
parsers.js(175)        解析器注册表
```

#### 4.1.1 scope-guard（授权硬校验链，run_cli 前置）

执行顺序（每一步都有 audit.jsonl 落点，deny 即返回不给模型）：

1. **manifest 存在性**：无 manifest 直接拒绝并列出可用清单
2. **S3 守卫**：manifest 无 `target_param` 且 `risk ≥ active` → 拒绝（防 scope 校验空转绕过）
3. **S4 参数注入守卫**：字符串参数禁换行符；target 参数禁空白字符（防 argv 注入危险 flag）
4. **目标提取**：`target_param`（逗号分隔多目标）或 `*_file`（清单文件逐行）
5. **逐目标 checkTarget**：hostOf 归一化（去 scheme/端口/IPv6 括号/路径，小写）→ 先查项目 `exclude` 清单再查 `scope` 清单；条目匹配支持字面域/`*.后缀`（含裸域本身）/CIDR。**未命中即拒绝（fail-closed）**，命中则记 program
6. **checkRisk**：`risk=manual` 恒拒绝；项目 `rules.max_risk` 上限封顶；`defaults.allow_risk: [passive, active]` 之外需人工（intrusive 返回 needs_approval）
7. **S1 解析后校验**（仅 active+）：域名 DNS resolve4 → 任一 IP 落保留段（0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.168/16）且该 IP 不在项目授权 CIDR → 拒绝（防"授权域名解析到内网"SSRF 式越界）

**代理注入**：`env_proxy: true` 且目标是公网（`isInternalHost`：localhost/.singll.net/.internal/.lan/RFC1918/169.254/127 → 直连）→ 注入 `http(s)_proxy=http://127.0.0.1:8899`。

**bwrap 沙箱（S2）**：仅有 target_param 的网络工具沙箱；`--unshare-all --share-net --die-with-parent --new-session --proc /proc --dev /dev --tmpfs /tmp`，只读挂 /usr /etc + venv/opt，可写仅 runDir + $HOME；平台密钥（.env/settings/keys）对工具不可见。`SEC_NO_SANDBOX=1` 或 bwrap 缺失优雅降级；manifest 可 `sandbox: false` 逐工具豁免（本地审计类工具用）。

**scope 管理闭环**（看板授权视图后端）：`serializeScope` 规范化重写 scope.yml（tmp+rename 原子 + `.bak` 备份 + audit + syncPrograms 镜像 + pairWorkspaces 重配对）；删除授权 = fail-closed 立即生效 + programs 行归档（数据归属保留）。**协同纪律**：scope.yml 受 spool sync 管理，界面写入后需 `spool sync pull csai` 回收管理机副本，否则下次 push 覆盖。

#### 4.1.2 run_cli 生命周期（工具执行唯一入口）

```
renderTemplate( {{param|default}} / {{outdir}} / {{run_id}} ) → shellSplit → spawn
  stdio: ['ignore','pipe','pipe']   ← stdin=/dev/null：ProjectDiscovery 系 HasStdin()
                                      把管道误判为有输入而永久卡死的一次性根治
  cwd=runDir; killer=SIGTERM→5s→SIGKILL
落盘 results/<run_id>/: cmd.txt + stdout.log + meta.json
  meta: run_id/tool/argv/params/started_at/duration_ms/exit_code/signal/error/
        risk/stage/sandboxed/session_id
后处理：
  ① pbOutcome(tool:<name>) 自动统计成功率/EWMA 耗时 → playbooks（环1 自动沉淀）
  ② 失败自动负知识：note/fail-<tool>-<host>（neg_check 派单前拦截重复尝试）
  ③ parser 入库（store=asset-graph 且 exit 0）：parsers.applyParsedResult
     → assets/endpoints/findings + httpx tech 自动 fpAdd 指纹
回模型：≤20 行 summary + total_lines + hint（grep_result/page_result 按需取）
```

#### 4.1.3 spawn_worker（无头 worker）

- 幂等：dedupeKey=sha1(task)；重启后重试 → running 且 pid 活=返回 in_progress；done/failed=从 workers 注册表+落盘 worker.log **确定性回读真实结果**；killed=重跑；force:true 跳过
- 并发 ≤4（activeWorkers 计数）；timeoutSec 上限 3600（到点 SIGTERM→SIGKILL 整个进程组，防孤儿）
- worker 环境：`DSH_HOME=data` + `--profile headless`（base/headless/proxy-pool/sec-suite/failover/memcore/pipeline 组合）→ worker 会话能调全部安全工具
- 执行会话按 cwd=工作区自动归组（workspaceRegistry.attachSession）
- worker_status/worker_list 工具供重启后核对真实结局

#### 4.1.4 调度器（Task 即定时任务）

- **认领**：`taskClaimDue` BEGIN IMMEDIATE 事务，取 `schedule_kind IS NOT NULL AND status='queued' AND next_run_at<=now` 且 parent 链放行（once 父任务 done 才放行子）的 ≤4 条，逐条 `UPDATE … SET status='running', started_at=now WHERE id=? AND status='queued'` 原子抢占（P15 修复：started_at 每次认领刷新，不再 COALESCE 残留）
- **执行**：按 phase 注入角色人格（PHASE_PRESET: recon→recon preset persona、vuln→vuln-hunt…），prompt=`[角色人格]\n\n[定时任务 #N / phase] <objective>` → runWorker(cwd=program 绑定的工作区路径, timeout 3600s)；busy 时回 queued 下一 tick 再试
- **收尾** `taskFinishScheduledRun`：interval 任务 latest-only 续期（锚点=原 next_run_at，按 every_seconds 整数倍推进到首个未来点，**错过不补跑**）回 queued；once → done/failed 终态；写 last_run_at/last_run_id + task_runs 历史（保留 200 行/任务，P15：记录失败 stderr 可见 + session_id 反查回填）
- **会话反查**（P15 新增）：`findWorkerSessionId(cwd, startedAt)` 从 sessionPersistence 按 cwd+时间窗找 worker 自己的 headless 会话 → 回填 meta.json + task_runs.session_id + tasks.session_id（看板跳链数据修复）
- **回收**：每 10 tick（~10min）taskReapStale——宽限期=超时+15min，且 last_run_id 对应 worker 进程活着即跳过（P15 修复：旧逻辑按 started_at 判龄与 3600s 超时同量级，会误杀跑满预算的任务并双重派单）；启动时 reap(0) 无条件回收孤儿 + workerReapStale 重分类
- ** vault 回流**：每日 05 时后首个 tick 拉取 keeper vault 安全域卡（方向②）

#### 4.1.5 流程守卫 + 噪声闸门 + opsHealth + submissionDraft（P15/P16 新增）

- **流程守卫**（asset-db.taskUpdate）：interval 日任务标 `done` 前校验三产物——①attempts TSV 近 24h 有增量行（六态皆可）②card_usage-*.jsonl 近 24h 有记录 ③handoff-<北京日期>.md 存在；作用域限 `schedule_kind='interval'` 且 `data/pipeline/{program}/` 存在。缺失返回 `guard_blocked:true + missing[]`，**任务不落 done**，agent 按清单补产物后重试（blocked/failed/cancelled 不拦——失败与放弃必须能落库）
- **噪声闸门**（addFinding）：severity=info → `noise=1`，指纹弱化为 sha1(host|title)（同模板同目标只留一行，URL 变体不增殖）；全部查询/报告/KPI 默认 `noise=0`（include_noise 显式查看）；存量 info 一次性回填（314 条）
- **opsHealth()**：五指标（台账日增量/卡使用 7d/交接包 7d/IdeaCard 数/调度漂移+task_runs 新鲜度）+ 告警列表；看板 `ops` RPC 端点 + 健康度红条横幅；discipline-audit.py 为 CLI 等价面
- **submissionDraft**：finding → 平台提交草稿 md（漏洞类型/等级自评/复现步骤/证据/修复建议/同目标同类型查重列表）落 `reports/submissions/`；人工审校后提交并 `finding_update status=submitted`

#### 4.1.6 experience.js（语义层记忆）

- **exp_store**：evidence 空拒绝（验证铁律）；source 三级 human-verified > 实战 > external（external 强制 low 置信）；memcore 门禁下入口 candidate + justification≥10；同 scenario 精确合并（证据去重/置信取高）；**语义去重**：embedding 余弦 ≥0.95 合并、0.85~0.95 只追加证据+warning（灰区交人工）
- **exp_search**：FTS5 MATCH + 逐词 LIKE 兜底（unicode61 对中英混排整串成词）+ 向量余弦 ≥0.55 融合；rank = fts×10 + 向量×20 + source×3 + confidence + score×2；candidate×0.5、cooling×0.7 降权；archived/timeline/expired 不可见（visibilityFilter）；**返回即 recordSignal(searched)**（uses+1）
- **exp_feedback**：useful/adopted/wrong/outdated 四信号（用完卡必须回执——不回执的卡会被判零使用沉没）；wrong/outdated → neg_fb+1，≥3 自动 cooling
- **exp_validate**：cooling 卡复验通过自动复活 active（用到即复验）
- **kb_import/kb_search**：外部知识 durable 90d；**taintguard 等价**：7 条 prompt-injection 正则扫描 → tainted 标记（检索返回带标志，视作不可信输入）；向量召回零关键词重叠命中
- **pb_save/pb_outcome/pb_rank**：playbook = name+chain；每次 run_cli 自动 pb_outcome（runs/successes/EWMA 耗时）；rank=成功率×时间衰减（-2%/天，下限 0.3）
- **kbVaultSync**（B4 Bellkeeper 融合方向②）：每日 rsync 拉 keeper `vault/安全/` → 新卡 kbImport（external 低置信+taintguard）；**防循环铁律**：frontmatter `source_system: silksecagent` 的卡禁止回流

#### 4.1.7 其余要点

- **authz_diff**：双会话头重放（redirect:manual、30s 超时），判定：低权 401/403=unlikely；状态码不一致=review；低权 200 且（JSON 键重合>50% 或长度比 0.5~2）=**suspected → 自动 addFinding(high)**；执行前过 checkTarget
- **intel_hunt**：指纹命中 → 走 nuclei-templates 目录找 tech 相关模板（≤30）→ 自动产出 phase=vuln/priority=1 的 N-day 候选任务（同 program 同 label 幂等去重；objective 内置 tentative 纪律）
- **plan_chain/task_chain**：manifest 的 requires/produces 能力图 BFS；task_chain 反向剪枝后落成 parent 串联的 once 链（`[链:want]` 标记幂等）
- **burp_import**：Burp XML（proxy history/scanner issues）→ data/imports/*.jsonl（人工测试成果回流口）
- **xray webhook**（webhook.js）：xray 7788 → `flows/xray-日期.jsonl` + addFinding（medium，`xray: <title>`，evidence=flow 文件）
- **report_build**：noise 过滤 + 类型列 + 噪声计数行；落 reports/

**FGS 决策图（P17）**：`fgs_nodes` 表 + `fgs_add / fgs_update / fgs_list / fgs_next / fgs_export` 工具，scheduler 在定时任务 prompt 中注入使用说明。目标是把任务执行中的 fact/goal/step/finding 实时结构化，形成 Decide/Execute 循环；任务收尾时 `appendFgsToHandoff` 自动追加 Markdown 摘要。**当前表为空**，框架已就绪，待每日任务实际产生节点。

### 4.2 sec-memcore（@silksec/sec-memcore，631 行）——记忆治理引擎

**依赖反转架构**：治理插件是旁路，`ctx.provide('secMemoryLifecycle')` 五原语；存储插件（asset-db/experience）`ctx.inject(['secMemoryLifecycle'])` 可选注入——**fail-open**：缺席即透传（写入不校验/读取全量/清扫停摆，业务完全正常）+ stderr/黑板告警 + 看板横幅。自身任何异常不得拖垮宿主（apply/sweep 全 try/catch）。

**策略注册表**（代码内置，集中可调）：

| 表 | 允许 mem_class | 入口 | 评分 | 自动晋升 | 降级 |
|---|---|---|---|---|---|
| blackboard | ephemeral(默认 7d)/timeline | — | 无 | — | 过期→archived；timeline 30d 归档 |
| facts | durable(默认复验 30d)/ephemeral/timeline | — | 无 | — | 逾期未复验→cooling→30d→archived（note 类 ephemeral 14d——负知识要可见，neg_check 依赖） |
| exp_cards | permanent | **candidate** | uses/adopted/pos_fb/neg_fb/score | adopted≥2 且 neg_fb=0 且存活≥7d | uses=0>30d 或 neg_fb≥3→cooling→30d→archived |
| playbooks | permanent | active | runs/successes | — | 成功率<30% 且 runs≥5→cooling |
| kb_docs | durable(复验 90d) | active | uses 计数 | — | 逾期→cooling |

**五原语**：
1. `validateWrite(table, intent)`：R1 mem_class 枚举；R2 permanent 禁直写（exp 入口 candidate）；R3 ephemeral TTL 1h~30d；R4 durable 复验 7~90d；R5/R6 语义层 justification≥10 字非占位符（工作/情景层缺省记 `auto:default`——否则内部自动写入点全被拒，实施期修正）；R7 timeline 只追加
2. `visibilityFilter(role, rows)`：task 读隐藏 archived/timeline/已过期（过期项**惰性即时归档**），cooling/candidate 打标降权；review 全量
3. `transition(table, id, to, reason)`：状态机唯一入口；archived = 复制进 `*_archive` 表（+archived_at/reason）+ 主表删除 + **FTS/向量索引同步清理**（exp_search Invalid time value 事故根因）；全程 memcore_events 审计
4. `recordSignal(table, id, signal)`：信号计数→评分→自动流转。exp 评分 = `adopted×3 + pos_fb×2 + uses×0.5 − neg_fb×5 − 复验天数×0.1(帽 5)`
5. `sweep()`：web 宿主面单例，每 6h + 启动 90s 首跑——过期降级/归档/硬删（archive 90d）/自动晋升/AGENTS.md 重写/objective lint（interval 任务 objective 里的故障词与陈旧日期命中即告警——"objective 禁止承载事实"红线的兜底）/vault 导出

**AGENTS.md 受管区块**（`<!-- memcore:begin/end -->` 标记内引擎独占）：Top5 高分卡摘要 + 现行 [env-issue] 清单 + 记忆三问纪律——每个 worker 开局读工作区 AGENTS.md 即获得记忆上下文，**不依赖复盘任务存活**（容错托底）。

**vault 导出桥**（方向①）：只导出 `permanent+active+exportable=1`（**默认 0 fail-closed**）；导出前过**授权域脱敏硬门**（scope.yml 提取的域名出现在卡文本 → 拒绝导出+日志）；tombstone 同步（弃置卡从 vault 移除）；rsync 推 keeper `vault/安全经验/`（csai 非特权 LXC 不能挂 NFS，走 keeper 中继）。

### 4.3 sec-pipeline（@silksec/dsh-sec-pipeline，465 行）——纪律工具化

8 个原生工具（写入即校验，替代裸脚本；旧脚本进退役观察期）：

| 工具 | 硬校验规则 |
|---|---|
| `attempts_log` | result 枚举六态（TESTED_CLEAN/CONFIRMED/FALSE_POSITIVE/NOT_APPLICABLE/BLOCKED/STALE）；**N/A、BLOCKED 必填 reason 且禁 other/misc**；TESTED_CLEAN、CONFIRMED 必填 evidence_path（无证据不结论）；北京时区 ISO ts；TSV 追加 `attempts-{program}.tsv` |
| `card_usage_log` | 落 `card_usage-{date}.jsonl`；deviation/suggest 可选但实战偏差必填（卡片升版原料） |
| `radar_read` | 读 radar-queue.jsonl（默认 drain 读后清空） |
| `pipeline_validate` | 产物格式机器校验（attempts/assets/endpoints/egress-health TSV 表头+行级校验、card_usage JSON 字段），任一失败=任务不许收尾 |
| `coverage_report` | attempts 聚合覆盖矩阵（卡片×最新态计数 + BLOCKED 解锁收益表）→ coverage-latest.md；**报告数字唯一来源，禁手填** |
| `verify_replay` | CONFIRMED 机械复核（LLM 不给自己当法官）：重放 evidence/{id}/request.txt（默认走 8899 代理），响应 sha256 比对 + verify-log.md 追加 |
| `surface_queue` | endpoints.tsv/文本 → 提参数 URL 全局去重入 param-queue.txt（dalfox/sqlmap 喂料），seen 防重 |
| `surface_scan` | 敏感信息正则回扫（手机号/身份证/银行卡/AK-SK/token/JWT/内网 IP），命中打码+sha256 指纹（VC-027 配套） |

### 4.4 sec-dashboard + theme-silksong（UI 面）

- **客户端**（client.js，ModuleLoader bundle）：全局侧边栏入口 → Modal **九视图**：漏洞/资产/接口/事实/任务/知识/报告/授权/审计；服务端分页/搜索/筛选 + 30s 轮询；顶部 stats KPI + **memcore 缺席横幅 + ops 健康度红条**（P15）；任务视图三分区（定时任务卡片/一次性队列/执行历史）+ 工作区区块（program 徽章+计数+会话跳链 `ctx.sessions.open`）；知识 tab=memcore 状态机的 UI（评分/晋升/编辑/弃置/回执/exportable 开关/playbooks）；授权 tab=scope.yml 管理表单；报告 tab 只读预览。信息架构纪律：**行只放摘要+跳链，详情一律回会话看**。
- **宿主半面**：`/silksec-dashboard` RPC（authority=loopback），40 个端点（读：stats/ops/assets/findings/facts/tasks/taskRuns/scheduledTasks/workspaces/sessions/scopeList/memcore/expCards/playbooks/reports/audit/evalStats/factGraph/findingGet/reportRead；写：findingUpdate/factCorrect/factDeprecate/taskCreate/taskRunNow/taskCancel/taskSetStatus/taskScheduleUpdate/scopeSaveProgram/scopeDeleteProgram/programBindWorkspace/expFeedback/expPromote/expDeprecate/expUpdate/expExportable/reportBuild）——全部复用 assetDb/experience 同一函数（一份校验、一条 audit）。
- **theme-silksong**：丝之歌全局深色主题（DSH theme registry 注册 tokens，Pharloom 墨青底+Hornet 绯红行动色）；severity 五色经 theme/change 事件注入 style（registry 白名单外）；localStorage 持久化用户选择，首装默认启用。

### 4.5 proxy-pool（@silksec/dsh-proxy-pool，300 行）

采集（30min timer：scrape→validate→grade → pool.json/live.txt/blocklist.txt/stats.json/sticky.json）→ mubeng 8899 轮换网关。6 个工具：`proxy_pool_stats`（池状态+网关健康）、`proxy_pool_get`（按协议/延迟/国家过滤；**sticky_key 会话保持**——同键复用同出口；延迟最优前 5 随机取一）、`proxy_pool_list`、`proxy_pool_report_bad`（入 blocklist + 从 live 移除，mubeng 热加载生效）、`proxy_pool_refresh`（sudo 后台触发采集）、`proxy_pool_gateway`（各工具代理注入用法速查）。安全注记：经免费代理的流量绝不携带真实凭证。

### 4.6 dsh-browser fork（@silksec/dsh-browser）

上游 wqty123/dsh-browser@0.1.0 不支持 proxy → sec-browser-plugin-setup.sh 构建时把上游包复制为 @silksec tarball 并 **patch 注入 `chromium.launch({ proxy: process.env.SEC_FLOW_PROXY })`**。运行链：共享浏览器/会话浏览器 → `SEC_FLOW_PROXY=http://127.0.0.1:7777`（xray 被动总线）→ xray webhook → findings；浏览器出口再由 xray 出站配置走 8899。CDP 9222 常驻 + 持久 profile = 登录态人机共用（H-002 到位后的登录态承载面）。browser 配置的 executablePath 指向 playwright chromium（cordis.patch.yml 覆盖层）。

---

## 五、数据模型与状态机全集

### 5.1 asset-graph.db 表清单（node:sqlite 单文件，WAL）

**领域表**：assets（host,type 主键；program_id/score/level/accept/biz/state P13 评级列）、endpoints（host,method,path 主键；params/auth_required/roles_seen 越权矩阵列）、findings（fingerprint UNIQUE；vuln_type/cwe/endpoint_ref/preconditions/reproduction_steps/impact/recommendation 提交模板列；session_id 跳链；**noise P15**；**confidence/fgs_node_id/discovery_step P17**；bounty/vendor_status/submitted_at SRC 运营列）、programs（scope.yml 镜像 + workspace_id/path 绑定 + status archived）、tasks（program_id/phase/objective/status/priority/budget + schedule_kind/run_at/every_seconds/next_run_at/last_run_at/last_run_id + session_id/blocked_reason/result）、task_runs（执行历史，每任务保留 200 行，session_id）、blackboard（**timeline/ephemeral 兼容层**，memcore 治理下 active 写入；日更 alive/recon/scan 键 7d 滚动，env-issue 修复后清理）、facts（program_id+fact_key 主键；summary 注入 prompt 索引 + body 全文；confidence；**memcore 生命周期列**）、fact_edges（src/dst/edge_type：resolves_to/hosts/exposes/depends_on/leads_to/enables/exploits）、**fgs_nodes（P17 Cairn_Y FGS 图：task_id/run_id/type/status/content/json score/parent_id/depends_on）**、fingerprints（host+tech 主键）、credentials（ref 引用非明文）、workers（spawn_worker 注册表：pid/status/exit/run_dir/dedupe_key）。

**语义层表**（experience.js 建）：exp_cards（scenario UNIQUE/takeaway/chain/attempts/evidence/source/confidence + memcore 评分列 + exportable）、exp_fts（FTS5 external content）、kb_docs（title/file/source_url/tainted）、kb_fts、playbooks（name 主键/runs/successes/avg_duration_ms）、exp_embeddings/kb_embeddings（384 维 e5 向量 JSON）。

**治理表**（memcore 建）：每表对应 `*_archive`（同构+archived_at/archive_reason，90 天硬删）、memcore_meta（迁移旗标）、memcore_events（全流转审计）。

### 5.2 状态机全集（触发者→落点）

**Task**：
```
queued ──调度认领(事务)──▶ running ──收尾──▶ interval: queued（latest-only 续期）｜ once: done/failed
queued ──task_run_now──▶ next_run_at=now（立即触发不动节律）
queued ──task_update(blocked)──▶ blocked（HITL 暂停；看板手动恢复→queued）
running ──reap(宽限=超时+15min，活 worker 跳过)──▶ interval: queued / once: failed（reason=宿主重启/超时回收）
任意 ──task_update(cancelled)──▶ cancelled
queued --标 done 时--> 流程守卫拦截点（台账/卡/交接包三查，缺则拒绝并返回清单；**当前守卫不校验最近一次 task_run 的 ok 字段，失败 run 需在 ops 健康度/看板红条中人工关注**）
```
**Finding**：`new → confirmed / false_positive / dup / ignored → submitted → accepted`（finding_update + note 追加证据链；dashboard 打标同通道； CONFIRMED 须 verify_replay 机械复核 + 证据包）；`noise=1` 与信号面隔离（非状态而是可见性维度）。
**FGS 节点（P17）**：`open ──fgs_next 取 ready──▶ running ──fgs_update──▶ done / failed / blocked`；`fact/goal/step/finding` 四类节点，依赖满足后 step 才 ready；任务收尾时 `appendFgsToHandoff` 自动把决策链摘要追加进 handoff。
**exp_cards**：`candidate ──(复盘评审 promote ｜ 自动晋升 adopted≥2∧neg=0∧≥7d)──▶ active ──(neg_fb≥3 ｜ uses=0>30d)──▶ cooling ──(用到即复验 validated=复活 active)──(30d)──▶ archived ──(90d)──▶ 硬删`。
**facts**：`active(durable, revalidate_by) ──逾期──▶ cooling ──复验刷新=复活──(30d)──▶ archived`；ephemeral 过期即 archived（读取路径惰性降级）。
**playbooks**：`active ──(成功率<30% ∧ runs≥5)──▶ cooling`。
**mem_class**：permanent（只有方法论，禁直写）/ durable（复验刷新）/ ephemeral（TTL 到期走人）/ timeline（只追加流水，30d 归档；task 读不可见，review 全量）。
**Asset**：level S/A/B/C/**NULL（未分级=禁入主动扫描队列，准入门）**；state new/changed/stable/dead；accept full/intrusion-only/none（SRC 收录政策）；owner confirmed/suspect（asset-scoring.md 打标规则）。
**覆盖台账**：六种可落行终态（TESTED_CLEAN/CONFIRMED/FALSE_POSITIVE/NOT_APPLICABLE/BLOCKED/STALE，各带强制 reason/evidence）；**PENDING 是"未落行"的隐含态**（覆盖矩阵里未出现的组合）——台账工具枚举里没有 PENDING。
**scope program**：active ⇄ archived（删除授权=立即 fail-closed 拒绝 + 行归档保数据）。

---

## 六、运行流程：从资产到提交

### 6.1 资产收集线（L1 资产层 → L2 接口层）

```
子域枚举 subfinder/dnsx → httpx 探活（-json → parser → assets+endpoints+指纹自动登记）
  → 分级：grade-assets.py 启发式（scope 域内才分；关键词 A/B/C + 指纹/接口/历史中高危加成；
          未分级/域外=NULL=禁入主动队列）
  → 视觉分诊（可选）：httpx/浏览器截图 → vision_triage → page_type/has_login/interesting → 补分级
  → L2 接口面：l2-collect.sh（katana 深度2 + waybackurls + gau → endpoints.tsv 归一化去静态）
  → surface_queue 建参数队列（dalfox/sqlmap 喂料）+ surface_scan 敏感回扫
变化雷达（旁路，变化优先于存量）：ct-watch（CT 新子域）/ js-watch（bundle hash 变化）→ radar-queue.jsonl
  → recon 任务 radar_read drain 全清处置（新子域黄金窗口优先测）
```

### 6.2 漏洞挖掘线（卡片驱动：指纹 → 假说 → detect/verify）

```
开局：exp_search 目标画像检索经验卡（先读后干）+ blackboard [env-issue] + neg_check 证伪拦截
选卡：coverage_report 取队列（BLOCKED/PENDING top-N）→ 读卡 applicable_when 判适用
     （不适用→NOT_APPLICABLE+na_reason；prerequisites 不满足→BLOCKED+blocker，如 no-credential）
detect：按卡 detect.steps 执行（工具矩阵分派，禁只跑 nuclei）
  指纹命中 → intel_hunt 自动建 N-day 候选任务（tentative）
  有参数面 → dalfox/arjun（param-queue 增量，单批≤3目标≤600s）
  Supabase 指纹 → VC-034（五端点差分→anon 直读→RLS 判定→CRUD/提权）
verify：verify.must_pass 全过 + falsification 逐项排除 + 对抗性自检（≥2 反证假设）
  + 高危双出口复现/独立 worker 复验 → CONFIRMED 建 evidence 包 → verify_replay 机械复核
落账：每动作立即 attempts_log（六态）+ card_usage_log（deviation 必填）
产出：finding_add（必须 run_id 证据；info 级噪声闸门自动隔离）
  → submission_draft 平台提交草稿（+查重）→ 人工审校提交 → finding_update submitted
蒸馏（中置，每目标完成即做）：exp_store（三问+justification）/ pb_save / exp_feedback 回执
收尾：coverage_report 重算 → handoff-{date}.md 五段（快照/动作/明日队列/阻塞/数据指针）
  → task_update done（流程守卫强制校验三产物）
```

### 6.3 每日链与周复盘（调度实体）

- **#16/#17 recon（北京 03:00，字节/美团）**：radar 全清 → 存量复核+新子域探活分级 → 台账逐动作落行 → 蒸馏 → handoff → done（守卫）
- **#18/#19 vuln（北京 04:00）**：消化覆盖矩阵 top-10 BLOCKED/PENDING 格子（Slice 硬指标，完成即达标）→ param-queue 增量喂 dalfox/arjun → 疑似即 finding_add → CONFIRMED 走 verify_replay+submission_draft → 剩余时间研究模式产 IdeaCard → handoff → done（守卫）
- **#24 周复盘（周日北京 05:00）**：data_quality + discipline_audit 断言原样贴报告 → 卡片周评审（draft≥3 次转 active / usage≥20 且 hit=0 废止评审）→ 碎片合并（>0.95 合并、0.85~0.95 只加证据）→ IdeaCard first_testable_when 检查 → 卡片 ROI 月排行 → STALE 风暴检查；**产物=review-{date}.md，无产物=没跑**
- worker 派单纪律：单批 ≤3 目标/≤600s，父预算 3600s 硬上限，跑不完记台账次日推进

### 6.4 记忆流（写入→检索→进化→沉淀）

```
写入：三问（会过期吗/换目标有用吗/谁会读）→ 分层（blackboard[env-issue]/timeline、
      facts durable、exp candidate、pb permanent）→ memcore validateWrite（R1-R7）
注入：worker 开局读 AGENTS.md 受管区块（Top 卡/env-issue/纪律）+ exp_search 按画像检索
进化：searched/adopted/useful/wrong/outdated/validated 信号 → 评分 → 自动晋升/降级/复活
      （复盘是加速器不是单点：无复盘好用的卡照样浮现，坏卡自动沉没）
沉淀：sweeper 每日 vault 导出（exportable=1 且脱敏门通过）→ keeper vault → Bellkeeper
      Meili/Obsidian；vault 人工新知识每日回流 kb_import（taintguard+external 低置信+防循环）
```

---

## 七、提示词体系

提示词分工原则：**persona/objective 只承载角色与流程智慧；纪律归技能（单一事实源）；事实/状态/日期禁止进 persona/objective（memcore objective lint 兜底）；防线由代码兜底（scope-guard/流程守卫/噪声闸门）**。

### 7.1 角色 persona（.agent-presets/<role>/agent.cordis.yml，seed-presets.sh 种子）

7 个角色，每个 persona 尾部统一追加记忆纪律句（开局 exp_search 检索→先读后干→用完 exp_feedback 回执→写记忆遵守 memcore 三问附 justification）：

| preset | 职责 | persona 要点 |
|---|---|---|
| recon | 资产收集与画像 | run_cli 调登记工具；发现即写黑板；批量派 spawn_worker；token 纪律只看摘要 |
| vuln-hunt | 模板扫描+定向验证（默认 preset） | 先 asset_query/blackboard 看库存；按指纹触发专项；结论必须 run_id 证据；代理池防封 |
| biz-logic | 越权/支付/密码重置 | endpoint_query 梳理接口图谱 → authz_diff 多角色对比 → browser_* 登录态页面 |
| code-audit | 源码/供应链审计 | gitleaks/trufflehog/osv-scanner/semgrep/codeql；结论可回溯 |
| intranet | 内网横向（仅授权靶场/HW） | intrusive 被 scope-guard 拦时请求人工确认，不绕过；凭据只写引用 |
| review | 复盘蒸馏 | 读 trajectory+run_id 日志；sec-review 结构蒸馏；复盘检索 reader=review 全量 |
| orchestrator | 脊柱派单 | task_next 拉单→按 phase 选角色→spawn_worker；交接包四要素（已完成/本轮只做/目标范围标准/产出格式）缺一不派；完成后 enqueue 后继 |

### 7.2 技能（data/skills/*/SKILL.md，7 个）

1. **sec-verification**：验证铁律（证据三选一 run_id/flow_id/burp_item + 必看原始输出 + 误报特征 + 带外必须回连佐证）+ 对抗性自检（≥2 反证假设逐一排除）+ 高危独立 worker 复验（双路一致才 confirmed）
2. **sec-pipeline**：六态台账/卡片驱动/防幻觉输出契约 7 条（分母明确、CLEAN 同级举证、禁幻觉词、负例即价值…）/规定+自选动作（≥20% 探索配额≥3 IdeaCard，探索产出禁直接进 findings）/工具矩阵分派/合规止损/收尾清单/交接包五段/**§9 流程守卫说明/§10 资产准入与 Slice/蒸馏中置**
3. **sec-runtime-discipline**：出口/授权/派单/interval/失败留痕/大输出摘要/**收尾 note【项目·角色·MMdd】格式**/黑板 8 条公共纪律
4. **sec-task**：「定时跑」必须 task_create 带 schedule（禁口头答应）；interval 固定实体禁每天重建 once；归属自动带出；intrusive 禁 interval
5. **sec-knowledge**：记忆三问 + 类别速查表 + **规则先验层**（data/rules/）使用纪律 + 开局/用卡/cooling/查重/红线流程
6. **sec-blackboard**：黑板读写键规范（cred:/alive:/tried:/note:/waf:）
7. **sec-review**：经验卡 JSON 结构 + 质量要求（takeaway 可操作、失败同等重要、无证据不入库、同 scenario 修正不另起）

### 7.3 规则先验层（data/rules/，人工蒸馏静态先验，与经验卡后验互补）

`web/selfhosted-supabase.md`（五端点差分确认/anon 非 service_role/RLS 逐表/跨实例 JWT 不通用）、`web/spring.md`（actuator/SpEL/反序列化/鉴权顺序）、`web/nextjs.md`（Server Actions/middleware 绕过/_next/data 泄露）、`php/thinkphp.md`（payload 代际）、`src/asset-scoring.md`（SABC 打分表 A 漏洞价值 40/B 出洞概率 45/C 时效 15 + owner/accept/biz/state 打标 + 深挖队列规则）、`src/severity-rating.md`（SRC 对齐压级：定级不膨胀/不确定往低报/信息泄露默认低危/忽略级不进提交但留副产物 + CVSS4.0 报告模板）。

### 7.4 任务 objective（调度注入，每个 interval 任务一行固定实体）

结构（当前 #16-#19 实文约 450-700 字）：`【项目·phase·每日Slice】唯一授权权威=scope.yml → 纪律引用技能 → 今日硬指标（Slice：radar 全清/覆盖矩阵 top-10 格子/param-queue 喂弹）→ 蒸馏中置条款 → 收尾（coverage_report → handoff 五段 → task_update done 守卫强制）→ 禁 blackboard_set 新事实（fact_upsert）/禁自建次日任务`。收尾 note 强制 `【项目·角色·MMdd】` 前缀（看板执行历史可辨日期）。

### 7.5 漏洞卡（data/vulncards/，18 张 + IC-000 模板）

schema：`id/type/name/cwe/version/status/severity_potential/risk_level/applicable_when/not_applicable_when/prerequisites/detect{summary,steps,fp_baseline}/verify{must_pass,falsification}/retest_after_days/src_notes/changelog`。升版规则：deviation 是原料；draft 用 ≥3 次或评审转 active；usage≥20 且 hit=0 强制废止评审；升版触发旧版覆盖记录转 STALE。VC-034（Supabase 开放数据面）为 08-20 手工战役 retro 首卡——"指纹→假说→验证链"卡片化的模板样本。

---

## 八、工具矩阵（tools.d manifest）

manifest 字段：`name/binary/stage/risk(passive|active|intrusive|manual)/timeout/target_param/requires/produces/args_template/env_proxy/parser/summarize/store`。31 个 manifest 五族：

- **资产收集**：subfinder/dnsx/naabu/httpx(-duc)/tlsx/katana/ffuf/gau/waybackurls/fofa_search（脚本）——httpx parser=jsonl_httpx（assets+endpoints+指纹自动登记）
- **漏洞挖掘**：nuclei（parser=jsonl_nuclei，经规则层）/afrog/dalfox/crlfuzz/arjun/graphql-cop/sqlmap
- **审计本地**：gitleaks/trufflehog/semgrep/codeql/osv-scanner（无 target_param 不沙箱）
- **指纹/信息**：observer_ward/wafw00f
- **治理与分诊（P15/P16）**：l2-collect（requires live_hosts → produces endpoints）、vision_triage、data_quality、discipline_audit、grade_assets、echo-test（自检）

能力凑链：plan_chain 按 requires/produces BFS（domains → subdomains → live_hosts → endpoints → findings）。工具链版本由 tools-manager.sh + tools.list 统一安装/升级（go install/github release/apt 三通道）。

---

## 九、脚本层

| 脚本 | 机制 |
|---|---|
| l2-collect.sh | katana(-d 2, 走代理, 120s/目标) + waybackurls + gau → URL 归一化（去静态/去重/提参数）追加 endpoints-{program}.tsv；单批 ≤3 目标纪律 |
| ct-watch.py | certspotter API 轮询（429 退避重试），命中 scope 后缀新域 → radar-queue.jsonl（北京时区 ts） |
| js-watch.py | JS bundle hash 变化 → radar 队列（发版监控） |
| grade-assets.py | **scope 过滤**（解析 scope.yml 域模式，域外保持 NULL）+ 关键词启发（admin/api/sso →A 加成；static/cdn/track →C 减分；深层子域微降）+ 数据密度（指纹+8/接口+5/历史中高危+25/dead-25）→ SABC 写库；--dry-run 预览 |
| data-quality.py | 11 项 SQL/文件断言（未分级率/空 category/vuln_type 缺失/孤儿外键/垃圾 playbook/双存储漂移/调度漂移/task_runs 新鲜度/台账空转），critical 退出码非 0，--json 供工具消费 |
| discipline-audit.py | 文档-现实校验五指标（台账日增量/卡使用 7d/交接包 7d/IdeaCard/漂移+新鲜度）+ 告警退出码 |
| coverage-report.py / pipeline-validate.py / verify-replay.py / surface-consume.py | 旧脚本版（已被 sec-pipeline 同名工具取代，退役观察期） |
| vault-export-build.sh / vault-sync.sh | 卡片 YAML→pkb md → keeper 中继同步 NAS（B5） |
| dsh-version-watch.sh | npm 上游版本每日监控（0.1.2 升级决策输入） |
| proxy_grade.py / proxy-scraper-checker | 代理池采集/验证/分级（30min timer） |
| retention.sh / silksec-backup.sh / silksec-restore.sh | 数据保留期（flows/results 30d、audit 50MB 轮转）/ VACUUM INTO 快照 14 份 / 恢复手册 |
| intel-refresh.sh | 模板库更新计数 → intel.jsonl |
| eval-run.js | Vulhub 靶场回归（真实 run_cli 管线跑 nuclei 核对预期命中 → data/eval/） |
| vision-triage.mjs | 截图 → deepseek-v4-flash-vision-exp → 结构化分诊 JSONL（.env 自加载兜底；base url/model 可 env 覆盖） |

---

## 十、合规与安全护栏

| # | 护栏 | 落点（实测状态） |
|---|---|---|
| 1/1b | scope 字面 + 解析后校验 | ✅ checkTarget/verifyResolved（S1 保留段清单） |
| 2/2b | 风险四级 + bwrap 沙箱 | ✅ checkRisk + buildSandboxCommand（manifest.sandbox=false 豁免开关） |
| 3 | S3 守卫（无 target_param 且 risk≥active 拒绝） | ✅ |
| 4 | 出口：mubeng 轮换 + 手工命令代理纪律 | ✅ 网关在位；**egress-guard 网络层白名单未装**（plugins.lock PENDING） |
| 5 | auth-gate 0.7.2 密码门 | ✅ 生效（3081 直连 401 实测）；**公网仅密码认证**（Authelia forward-auth 未接，S6 持续欠账） |
| 6 | 注入防护（taintguard 等价） | ✅ kb_import 7 正则扫描 + tainted 污点标记 |
| 7 | 数据保留期 | ✅ retention.timer（flows/results 30d、audit 50MB 轮转） |
| 8 | 供应链先扫后装 + pin + hash | ✅ plugins.lock；**运行期出口约束待 egress-guard** |
| 9 | fail-closed + 全量审计 | ✅ audit.jsonl（run/tool/target/decision/reason；tailAudit 看板审计视图） |
| + | 凭据零明文 | ✅ .env 600 / credentials 表只存引用 / 免费代理不带真实凭证 |
| + | 流程守卫/噪声闸门/资产准入 | ✅ P15（纪律机器强制） |
| 红线 | 拖库凭据/真实用户账号/破坏性 payload/蜜罐不退 | 写入技能与 objective，intrusive 一律人工 |

---

## 十一、部署与运维

- **规范化部署**：改仓库 `bundles/dsh/` → `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/`（管理机副本）→ `spool bundle dsh setup csai`（推模板+跑各 plugin setup 幂等脚本+种子+冒烟）→ `spool restart csai silksecagent`。**manifest 模板是扁平推送**（basename → BASE_DIR），子目录产物由 setup 脚本归位（install_scripts）。
- **升级**：`spool bundle dsh upgrade csai` → dsh-upgrade.sh（版本 pin + 配置备份 + **升级前数据快照** 187M + pnpm install + 服务健康 + **深冒烟**（--dump-config 校验 sec-cli-adapter/sec-dashboard 在组合树）+ 任一失败自动回滚版本）。
- **恢复**：backups/ 快照（6h 一次 VACUUM INTO，14 份）+ silksec-restore.sh；数据回滚手册见升级报告 §6。
- **日常运维**：一律 PATH 中 `spool`（exec/service/restart/logs/sync/bundle），禁止绕过。
- **健康速查**：`discipline-audit.py` / `data-quality.py` / 看板 ops 红条 / `journalctl -u silksecagent | grep 调度`。

---

## 十二、设计思想与关键取舍

1. **提示词负责智慧，代码负责纪律**：五公理（流程可靠>无证据不结论>万物进化>保底+自由>格式刚性内容开放）是文档层；scope-guard/流程守卫/噪声闸门/资产准入/memcore R1-R7 是代码层——评估报告的核心教训（"机制上线≠机制生效"）已固化为 P15 守卫体系。
2. **工具单入口、浏览器单入口**：一切 CLI 走 run_cli（授权/审计/落盘/压缩/解析全在唯一路径上）；一切浏览器流量走 dsh-browser→xray 总线。无 MCP。
3. **记忆三层 + fail-open 治理**：工作层（blackboard TTL）/情景层（facts 复验）/语义层（卡与打法，评分晋升）；治理引擎是可选旁路——宁可失去治理也不能治理插件崩了 agent 干不了活；复盘是加速器不是单点（自动晋升/降级/复活托底）。
4. **单轨模型栈**：pi-ai 是唯一 LLM 底座（DSH 的 dsh-llm-pi-ai），无 pi-bridge 无双轨；熔断链保可用性。
5. **升级免疫的解耦**：领域数据在自持 SQLite（node:sqlite，与 DSH 存储格式无关）、自研插件零 peer 依赖、调度器只用 spawn/SQLite/setInterval——rc 升级被动改动为零（rc.7→rc.2 实证），升级敏感面只剩看板 client 的预览 API（深冒烟兜底）。
6. **变化优先于存量**：CT/JS 雷达事件优先处置；daily 任务是 Slice（消化覆盖矩阵格子）而非全量重扫。
7. **无证据不结论的全链落地**：evidence 空拒绝入库（exp_store/finding_add）→ TESTED_CLEAN 同级举证 → CONFIRMED 机械复核（verify_replay hash）→ 对抗性自检 → 提交草稿人工终审。LLM 不给自己当法官。

---

### 附：文档体系索引

| 文档 | 定位 |
|---|---|
| `README.md` | 唯一持续推进入口（当前状态/待人工/待办/工作规范/里程碑） |
| **本文** | 系统全景（运行代码解剖，长期有效） |
| `dsh-secagent-plan-v6.md` | P11 时代主计划（历史快照，2026-08-22 校准） |
| `dsh-upgrade-0.1.1-rc.2-report.md` | 升级方法论与回滚手册（历史报告） |
| `sec-memory-governance-design.md` / `sec-memcore-implementation.md` | 记忆基架设计与实施记录 |
| `silksecagent-assessment-2026-08-28.md` | 体系评估快照（P15/P16 批已修复其中主要缺口，见文末追加说明） |
| `XFF-SECURITY-RESEARCH.md` | 独立研究报告 |
