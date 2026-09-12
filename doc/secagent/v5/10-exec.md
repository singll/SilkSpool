# 10 · exec 域设计（工具执行 / 沙箱 / QPS / worker 派生 / parser 提案）

> 版本：v5.0 ｜ 状态：定稿 ｜ 契约版本：`exec/1`
> 依赖：订阅 `scope.rules.changed`（QPS 即时生效）、`approval.approved`（tool-intrusive 白名单放行后重试自然通过，无需显式订阅——白名单在 scope 域数据里）；被订阅：`exec.run.completed`（asset/endpoint/vuln 域消费 parse proposal）、`exec.flow.appended`（vuln 域）、`exec.worker.spawned/.finished`（task 域）、`exec.import.completed`（endpoint/vuln 域）
> 上级契约：[`00-conventions.md`](00-conventions.md)（本文与其冲突时以宪法为准）
> 一句话职责：一切 CLI/worker 执行的唯一入口——守卫链（S1-S5）/沙箱/限速/全量落盘/parser 结构化提案，**执行产物与领域数据之间只隔一层事件**。

---

## 一、对外暴露（最优先）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 域名 | `exec` |
| cordis 服务名 | `secDomain.exec`（`ctx.provide('secDomain.exec', service)`） |
| 插件包名 | `@silksec/sec-domain-exec` |
| 后端插件包名 | `@silksec/sec-backend-exec-file` |
| 挂载 profile | `web`（宿主面：RPC 投影 + webhook 接收器 + 命令/查询全量）与 `headless`（worker 面：命令/查询全量，worker 要自己调 run_cli；无 connection 服务 → RPC/webhook 自然不挂）双面挂载 |
| owns.files | `tools.d/*.yaml`（31 个 CLI manifest）、`results/<run_id>/`（每次执行全量落盘）、`flows/`（xray webhook JSONL）、`imports/`（burp 等人工工具产物 JSONL） |
| owns.tables | 无（worker 注册表 `workers` 归 task 域——见 §3.1 映射第 12 行的归属论证） |
| 后端 | `file`（唯一；exec 域 owns 全是文件/目录，无表无 sqlite） |
| sidecars | 宿主面启动 webhook 接收器（xray 7788 转发链的落点）；worker 面不启动（沿用 v4 `config.sidecars !== false` 入口侧收敛模式） |

**owns 单写者律**：上表四类路径只有本域能写。沙箱可写白名单与 owns 的交叉断言见 §2.2.4（宪法 §十四.3 的本域实施）。

### 1.2 命令（写动词）总表

| 动词 | 一句话语义 | actor 白名单 | 幂等策略 | 事件 |
|---|---|---|---|---|
| `exec_run_cli` | 经守卫链运行一个已登记 CLI 工具，全量落盘，回 ≤20 行摘要 | model, dashboard, script, human | `explicit_only`（见 1.3.1 说明） | `exec.run.started`、`exec.run.completed` |
| `exec_spawn_worker` | 派生隔离无头 worker 执行自包含任务（RoE 契约注入） | model, dashboard | 自然键 `sha1(task)` | `exec.worker.spawned`、`exec.worker.finished` |
| `exec_burp_import` | Burp XML 导入 → 结构化 JSONL 落盘 + proposal 事件 | model, human | 自然键 `sha1(file 内容前 1MB)` | `exec.import.completed` |
| `exec_report_bad_proxy` | 坏代理上报（经总线 dispatch 调 proxy 域命令） | model, script, dashboard | 自然键 `sha1(proxy_url)` | （proxy 域发） |
| `exec_intel_hunt` | 指纹命中 → 本地 nuclei 模板检索 +（可选）委托 task 域建 N-day 候选任务 | model, dashboard | 显式键 | （task 域发 `task.created`） |
| `exec_flow_append` | 机器通道：xray webhook 原始 flow 落盘 | webhook | 自动指纹 `sha1(源 payload)` | `exec.flow.appended` |

> `exec_intel_hunt` 的"建任务"副作用**全部经总线 `dispatch('task', ...)` 走 task 域命令全管线**（schema/不变量/事务/审计一个不少）——exec 域不 import task 域模块、不直调其函数、不写 tasks 表。这是域间协作的合法形态②（同步命令调用，需要返回 task_id / 强顺序），与形态①（事件订阅，异步解耦）并存；被禁止的只是 import 他域内部函数或绕网关写。
> 任务链展开（原 v4 dashboard-rpc taskChain）统一归 **task 域 `task_chain`**（05-task.md C9）——它的事务主体是写 task 域 owned 的 tasks 表；本域只保留能力图**只读查询** `exec_plan_chain`（§1.4），旧 `exec_task_chain` 名经总线别名指向 task_chain。

### 1.3 命令逐个详述

#### 1.3.1 `exec_run_cli`

**agent_note（工具描述全文，见 1.6）**：运行已登记安全 CLI 工具。目标经 scope-guard 白名单硬校验（S1-S5 守卫链），参数模板化渲染，输出全量落盘 `results/<run_id>/`，只回 ≤20 行摘要，细节用 `exec_grep_result` / `exec_page_result` 按需取。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `tool` | string | 是 | — | 必须存在 `tools.d/<tool>.yaml`，否则 `E_EXEC_MANIFEST_MISSING`（message 附可用清单提示） |
| `params` | object | 是 | — | 值限标量（string/number/boolean）；键名须匹配 manifest `args_template` 引用或 `target_param`，多余键 `E_SCHEMA` |
| `idempotency_key` | string | 否 | — | 显式幂等键（网络层重试保护推荐传） |

**幂等策略 `explicit_only`**：run_cli 的合法业务包含"同参数重扫"（次日重跑同一目标），**不适用**自动指纹（会把重扫错误地变成 replay）。因此：调用方传 `idempotency_key` 时走网关标准幂等（同 key 同参 → replay；同 key 异参 → `E_IDEMPOTENT_CONFLICT`）；不传时**每次调用独立执行**（manifest 声明 `idempotency: explicit_only`，总线支持该策略——用于执行类动词）。重试的确定性由 run 落盘 + run_id 回查保证，不靠幂等表。

**守卫链（网关 invariants，按序执行，全部 fail-closed；每条失败落 `kind:"guard"` audit）**——这是本命令的核心，逐条不变量化（v4.x scope-guard 链原样保留、只换归属）：

| 序 | 守卫 | 检查内容 | 失败错误码 | 典型 hint |
|---|---|---|---|---|
| G0 | manifest 存在性 | `tools.d/<tool>.yaml` 存在且可解析 | `E_EXEC_MANIFEST_MISSING` | `工具 X 无 manifest。用 exec_manifest_list 查可用工具` |
| G1 | S3 守卫 | manifest 无 `target_param` 且 `risk ≥ active` → 拒（防 scope 校验空转绕过） | `E_EXEC_TARGETLESS_ACTIVE` | `补 manifest target_param 或降 risk；本地审计类工具 risk 应为 passive` |
| G2 | S4 参数注入守卫 | 字符串参数值禁 `\r`/`\n`；`target_param` 参数值禁任意空白（防 argv 注入危险 flag） | `E_EXEC_PARAM_INJECTION` | `参数含换行/空白，拒绝。多目标用英文逗号分隔，清单用 <target>_file 参数传文件` |
| G3 | 目标提取 | `target_param` 逗号分隔多目标，或 `*_file` 清单文件逐行（`#` 注释行跳过；文件不可读 → 以哨兵值进入 G4 必拒） | —（提取阶段） | — |
| G4 | 逐目标 checkTarget | 对每个目标：`hostOf` 归一化（去 scheme/端口/IPv6 括号/路径、小写）→ 调 **scope 域 `scope_check` 查询**（先项目 exclude 清单后 scope 清单；条目匹配支持字面域 / `*.后缀`（含裸域本身）/ CIDR）→ 未命中即拒 | `E_EXEC_SCOPE_DENIED`（message 含 scope 域返回的 reason） | `目标不在任何授权项目（fail-closed）。候选资产走 approval_request 提请 scope-domain/scope-wildcard` |
| G5 | checkRisk | `risk=manual` 恒拒；超项目 `rules.max_risk` 上限拒；`defaults.allow_risk` 之外（intrusive）→ needs_approval 路径（见下） | `E_EXEC_RISK_FORBIDDEN` / `E_EXEC_RISK_NEEDS_APPROVAL` | manual：`risk=manual 工具默认禁用`；超上限：`工具风险级 X 超过项目上限 Y`；intrusive：`已自动提请 tool-intrusive 审批 #N（批准后下个调度周期重试即放行）。本次维持拒绝，勿重试` |
| G6 | S1 解析后校验 | 仅 active+：每目标 DNS `resolve4` → 任一 IP 落保留段（0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.168/16）且该 IP 不在项目授权 CIDR → 拒（防授权域名解析到内网的 SSRF 式越界）。DNS 解析失败不阻断（容错） | `E_EXEC_RESERVED_IP` | `目标解析到内网/保留 IP 且不在授权 CIDR 内。若确属授权资产，scope 条目须以 CIDR 形式显式授权` |
| G7 | QPS 令牌桶 | 仅 active+：进程级全局令牌桶（跨会话/worker 共享），容量 = `defaults.rate_limit_qps`；令牌不足时循环等待放行（**不拒绝、不绕过**） | —（节流） | —（stderr 记录等待毫秒数） |
| G8 | 模板渲染 | `renderTemplate`：`{{param|default}}` / `{{outdir}}`（=runDir）/ `{{run_id}}`；缺必填参数且无默认 → 拒 | `E_EXEC_TEMPLATE_PARAM` | `缺少必填参数: X` |
| G9 | S5 写动词守卫 | 仅 risk=passive 且工具不在项目 `rules.allow_intrusive_tools` 白名单：渲染命令中任一 http(s) URL 的 **path 段**命中 33 动词表（段级精确比对，段内 `-`/`_` 拆 token、剥段尾扩展名）→ 拒 | `E_EXEC_WRITE_VERB` | `只读工具打写动词路径（verb X in URL）。确属写操作须改用 active/intrusive 工具 manifest，或等 tool-intrusive 审批放行后重试` |

**33 写动词表**（v4.x 原样冻结，新增动词须 bump 契约版本）：
`create, add, new, update, edit, modify, delete, remove, drop, settle, refund, pay, payment, transfer, withdraw, reset, generate, send, sms, upload, import, exec, eval, trigger, deploy, launch, approve, submit, order, trade, cash, bind, unbind`

**G5 needs_approval 异步审批协议（v4.5 原样保留）**：intrusive 被拒时同步拒绝语义不变（fail-closed 当场生效）+ **自动经总线 dispatch `approval_request`（approval 域，kind=`tool-intrusive`）**，payload 携带完整重试上下文：`{tool, risk, target, params（经 sanitizeParamsForApproval 脱敏：字符串 >60 字截断、复合值降维为类型标记）, program}`；返回信封带 `needs_approval: true` + `approval_hint`（勿重试指引）。批准 → scope 域写 `rules.allow_intrusive_tools` 白名单 → 下个调度周期重试自然放行。S5 拒绝点（G9）桥接同一白名单与同一审批 kind（payload 附 `guard: "S5-write-verb"` + 命中的 verb/url）——白名单同源，批准一次两闸同开。

**执行（守卫全过后）**——run_cli 完整生命周期（v4.x 已最成熟，v5 契约化搬入）：

```
renderTemplate → shellSplit → spawn
  stdio: ['ignore','pipe','pipe']   ← stdin=/dev/null：ProjectDiscovery 系 HasStdin() 把
                                      常开管道误判为有输入而永久卡死的一次性根治（保留，禁改回）
  cwd = results/<run_id>/（runDir）
  超时: manifest.timeout（上限 3600s）→ SIGTERM → 5s → SIGKILL
落盘 results/<run_id>/:
  cmd.txt     实际执行命令（沙箱执行带 [sandbox] 前缀）
  stdout.log  全量 stdout（流式写入）
  meta.json   见 2.1.2 字段表
  proposal.json  parser 产出的结构化提案（store 语义废止后新增，见 2.1.3）
 后处理（顺序固定）:
   ① know 域命令：dispatch('know','pb_outcome',{name:"tool:<tool>", success, duration_ms})
      —— 工具成功率/EWMA 统计（环1 自动沉淀）；弱联动 best-effort，失败 audit 记 dispatch_failed
   ② 发布 exec.run.failed（exit_code ≠ 0 且 program 已解析时，payload 含 tool/host/exit_code/error）
      —— fact 域订阅后写负知识 note（note/fail-<tool>-<host>，neg_check 派单前拦截重复尝试）；
         事件化替代 v4 runCli 直调 factUpsert；弱联动
   ③ 发布 exec.run.completed（payload 携带 parse_proposal 摘要，见 1.5.2）
      —— parser 入库直写归零的核心：asset/endpoint/vuln 域订阅后各自经命令入库
回模型：≤20 行 summary + total_lines + hint（>20 行时提示用 grep/page 取）
```

**返回信封 data**：

```json
{
  "run_id": "r8x1k2ab",
  "exit_code": 0, "signal": null, "error": null,
  "duration_ms": 45230, "total_lines": 1832,
  "summary": "（stdout 前 20 行）",
  "sandboxed": true, "program_id": "bytedance",
  "parse_counts": { "assets": 12, "endpoints": 40, "findings": 0, "fingerprints": 7 },
  "hint": "输出共 1832 行，仅显示前 20 行；用 exec_grep_result/exec_page_result 按需取"
}
```

> **命令成功 ≠ 工具成功**：`ok:true` 表示命令管线（守卫/执行/落盘/事件）成功；CLI 自身非零退出体现在 `data.exit_code`，模型据此判断工具结果。守卫拒绝才是 `ok:false`。

**actor**：model（绝大多数）、dashboard（看板手工触发，审计带 operator）、script（治理脚本）、human（应急，审计高亮）。
**RoE**：目标必须显式授权（fail-closed 无豁免）；`needs_approval`/`approval_hint` 出现时禁自行绕过或换姿势重试（改走审批）；大输出纪律——run_cli 只回摘要，禁止试图让工具输出全量进会话。

#### 1.3.2 `exec_spawn_worker`

**agent_note**：派一个隔离无头 worker 执行自包含任务（批量复扫、大日志蒸馏等）。worker 上下文独立，跑完只回尾部摘要，全文落盘 `results/<run_id>/worker.log`。幂等：宿主重启后本调用报 interrupted 时原样重试即确定性拿回真实结果（已完成→回读、被杀→重跑）；强制重跑传 `force:true`。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `task` | string | 是 | — | 非空；worker 看不到调用方上下文，目标/范围/产出要求必须写全（RoE 块自动追加，见下） |
| `timeout` | integer | 否 | 900 | ≤3600；调度链调用时可取 task 域预算 `budget_timeout_sec`（≤7200，task-budget-extend 审批落点）与 3600 的 max |
| `force` | boolean | 否 | false | true = 绕过自然键去重强制重跑（审计高亮） |
| `provider` | string | 否 | — | 与 `model` 成对出现；经 `--patch` 写 model-patch.yml 注入子进程（任务级模型覆盖，不受默认路由约束） |
| `model` | string | 否 | — | 同上 |

**幂等**：自然键 `exec:spawn_worker:sha1(task + '\0')`（**RoE 块注入是 task 的确定性函数**——task 已含 RoE 锚点则不重复堆叠——故 dedupeKey 语义不受注入影响）。重试路径（v4.x 原样）：

| 注册表既有状态 | 行为 |
|---|---|
| running 且 pid 活 | 返回 `in_progress: true` + run_id，hint 引导用 task 域 `task_worker_status` 查进度（不占并发 slot） |
| running 且 pid 死 | 僵尸归 killed（经 task 域 `task_worker_finish` 命令）→ 落到 fresh spawn |
| done / failed | **确定性回读**：从 run_dir/worker.log 读尾部 20 行 + DB 终态（`recovered: true`）；日志已清理则仅回 DB 终态 |
| killed / 无记录 | fresh spawn |

**并发**：`activeWorkers ≤ 4`（进程级计数；早返回全部在计数递增之前，不占也不错减 slot）。超限 → `E_EXEC_WORKER_BUSY`（retryable: true）。

**执行**：`node dsh --profile headless <task>` 子进程，`detached: true` 自成进程组；超时 `kill(-pid, SIGTERM)` → 5s → `kill(-pid, SIGKILL)` **杀整个进程组**（worker 派生的 CLI/子 worker 随父回收，防孤儿）。worker 环境 `DSH_HOME=data` + headless profile（挂全部域，模型可用动词按 actor 白名单投影）。注册表登记/收尾（pid/status/run_dir/dedupe_key）**经事件协作**：spawn 成功后本域发布 `exec.worker.spawned`（**强联动 sync**）→ task 域订阅执行 `task_worker_register`（actor=reactor）；进程退出后发布 `exec.worker.finished` → `task_worker_finish`（workers 表归 task 域 owns，本域不写）。强联动失败 → spawn_worker 整体报错回滚（本域 kill 刚 spawn 的进程组再返回——注册行丢失 = dedupe 失效 = 重复 spawn）。

**RoE 契约（硬编码常量，注入任务文本末尾；锚点子串 `Rules of Engagement 交战规则` 用于幂等去重）**——v4.x 五条原样保留：

1. 目标列表必须作为数据逐字出现在任务里；指代式目标一律视为未授权。
2. 测程中新发现主机一律 report-only；纳入 scope 须先走审批。
3. 「read-only」展开为动词清单：GET/HEAD/OPTIONS/DNS/被动指纹；一切写动词不在只读范围。
4. 被拒后不换姿势重试，改走审批（scope-guard 是 fail-closed 硬校验）。
5. 只读工具打写动词路径会被 S5 拒绝；确需写操作用 active/intrusive 工具并走审批。

**事件**：spawn 落地后发 `exec.worker.spawned`；进程收尾后发 `exec.worker.finished`。
**错误**：`E_EXEC_WORKER_BUSY`（并发满，retryable）/ `E_EXEC_WORKER_IN_PROGRESS`（同任务在跑，非错误路径返回 in_progress 信封）/ `E_EXEC_WORKER_START_FAILED`（spawn 异常）。
**actor**：model, dashboard。

#### 1.3.3 `exec_burp_import`

**agent_note**：导入 Burp Suite 导出 XML（proxy history / scanner issues），结构化落盘 `data/imports/*.jsonl` 并发 proposal 事件。人工在 Burp 测试后导出回流。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | string | 是 | 本机绝对路径，须存在（`E_EXEC_FILE_NOT_FOUND`） |

行为：解析 `<item>`/`<issue>` 块 → 逐条 JSONL 落盘 `imports/burp-{ts36}.jsonl`（issue: type/name/host/path/severity/confidence；item: type/host/url/method/status/mimetype）→ 发 `exec.import.completed`（payload: import_id/kind/records/hosts 前 20）。**v5 变化**：v4 的"接入 asset-graph 后自动入图谱"hint 兑现为事件——endpoint/vuln 域订阅后经命令入库（actor=script, run_id=import_id）。幂等：自然键 `sha1(文件内容前 1MB)`（同文件重复导入 replay）。
**actor**：model, human。

#### 1.3.4 `exec_report_bad_proxy`

**agent_note**：上报坏代理（加入 blocklist + 从 live 移除，mubeng 热加载生效）。跨域示例：本命令经总线调 proxy 域命令，exec 不直接改代理池。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `proxy_url` | string | 是 | 代理地址 |
| `evidence` | string | 否 | 失败现象摘要（超时/连接拒绝等） |
| `run_id` | string | 否 | 关联执行（取证链） |

行为：`dispatch('proxy', 'report_bad', {proxy_url, evidence, run_id})`，透传 proxy 域结果信封（proxy 域发自己的事件、记自己的审计；exec 侧 audit 记一条 dispatch）。proxy 域不可达 → `E_BACKEND_UNAVAILABLE`（retryable: true）。
幂等：自然键 `exec:report_bad_proxy:sha1(proxy_url)`。**actor**：model, script, dashboard。

#### 1.3.5 `exec_intel_hunt`

**agent_note**：指纹命中后查本地 nuclei 模板库找 tech 相关 N-day 模板/CVE。命中可自动产出 phase=vuln、priority=1 的 N-day 候选任务（tentative，验证附证据才 confirmed）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `tech` | string | 是 | — | 技术栈/组件（weblogic/ruoyi/spring…） |
| `version` | string | 否 | — | 版本号 |
| `program_id` | string | 否 | 会话工作区自动绑定 | 不绑定时仅返回模板不建任务 |
| `host` | string | 否 | — | 命中指纹的主机（写入候选任务目标） |
| `create_task` | boolean | 否 | true | false = 仅检索不建任务 |

行为：walk `~/nuclei-templates`（深度 ≤3、命中 ≤30）；命中且绑定 program 且 `create_task` 时——**经 `dispatch('task', 'create', ...)` 建候选任务**（phase=vuln、priority=1、objective 内置 tentative 纪律），建前先 `dispatch('task', 'list', ...)` 查同 program 未终结同 `[N-day tech@ver]` 标签任务做幂等去重（deduped 返回）。模板库缺失 → `E_EXEC_FILE_NOT_FOUND`。
**归属论证**：intel_hunt 的两半——"模板库检索"是 exec 域执行资源查询（nuclei-templates 是工具链资产，与 tools.d 同族）；"建 N-day 候选任务"是 task 域动词（task_create 经网关全管线）。v4.x 把两半揉在一个函数里直调 `assetDb.taskCreate`，v5 拆开：exec 只做检索与委托，任务的 schema/不变量/审计全在 task 域。
**actor**：model, dashboard。

#### 1.3.6 `exec_task_chain`（已迁出，见 task 域 task_chain）

任务链展开命令**归 task 域 `task_chain`**（05-task.md C9，唯一写命令）：它的事务主体是写 tasks 表 N 行（parent 串联 once 链），落点全在 task 域。本域只保留能力图**只读查询** `exec_plan_chain`（§1.4.2）供 task_chain 跨域调用（纯读 BFS，无副作用）。旧 `exec_task_chain` 工具名经总线别名指向 `task_chain`（05-task §3.2），本域契约不再声明该写命令。**actor**：model, dashboard（走 task 域投影）。

#### 1.3.7 `exec_flow_append`（机器通道）

xray webhook 接收器（exec 域宿主面 HTTP 面，:7788 上游）收到原始 JSON 后经本命令落盘。**模型不可见**（actor=webhook）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | string | 是 | 固定 `xray`（v5 预留多来源） |
| `payload` | object | 是 | 原始 webhook JSON（≤1MB，超限接收器直接 destroy） |

行为：追加 `flows/xray-{北京日期}.jsonl` → 发布 `exec.flow.appended`（payload: flow_file/host/title）→ **vuln 域订阅**后调 `vuln_register_candidate`（actor=webhook，标题「{host} 被动审计候选：{title}」——v4.x 直调 addFinding 的归零路径）。幂等：自动指纹 `sha1(payload JSON)`。
**边界论证**：flows/ 是 exec owns（流量总线原始记录）；findings 候选是 vuln owns。接收器只做"收包→落盘→发事件"，入库判定（完整性闸门/噪声归位）全部在 vuln 域命令里。

### 1.4 查询（读投影）逐个详述

| 查询 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `exec_grep_result` | `run_id`*（匹配 `^r[a-z0-9]+$` 或 `^w[a-z0-9]+$`）、`pattern`*（正则，大小写不敏感）、`max`（默认 50 上限 200） | `{files_searched, matched, lines}`（`相对路径:行号: 内容`，行截 500 字符） | 搜索范围 = run 目录下**全部文本产物**（stdout.log + 工具 `-o` 落盘文件），排除二进制扩展名（png/jpg/gif/zip/gz/zstd/bin）；正则无效 → `E_SCHEMA`；run_id 不存在 → `E_NOT_FOUND` |
| `exec_page_result` | `run_id`*、`offset`（0 基，默认 0）、`limit`（默认 50 上限 200） | `{total_lines, offset, limit, lines}` | 仅 stdout.log 按行分页 |
| `exec_plan_chain` | `have`: string[]、`want`* | `{have, want, chain[], available[]}` | 能力图 BFS：按 manifest `requires`/`produces` 迭代扩张（v4.x 算法原样）；凑不到 → `E_EXEC_CHAIN_UNREACHABLE` + available 清单（hint：调整 have/want 或检查 manifest） |
| `exec_manifest_list` | `stage?`、`risk?`、`domain?` | `{rows: [{name, stage, risk, target_param, requires, produces, parser, domain, sandbox, deprecated_store}], total}` | manifest 元数据枚举（v4 的"错误 message 附可用清单"升为一等查询；`domain` 字段见 2.1.1） |

`exec_plan_chain` 能力链主干（当前 manifest 图的实际形态）：`domains → subdomains → live_hosts → endpoints → findings`。

### 1.5 事件

#### 1.5.1 发布事件总表

| 事件 | 触发 | payload 顶层字段 | 联动 |
|---|---|---|---|
| `exec.run.started` | run_cli 通过守卫链、spawn 前 | `run_id, tool, stage, risk, targets(≤10), program_id` | 弱 |
| `exec.run.failed` | run 落盘且 exit_code≠0、program 已解析（后处理 ②）| `run_id, tool, host, exit_code, error, program_id` | 弱（fact 域订阅写负知识）|
| `exec.run.completed` | run 落盘 + 后处理 ①② 之后 | 见 1.5.2 | 弱（asset/endpoint/vuln 订阅入库；可重放） |
| `exec.worker.spawned` | worker 注册表登记成功 | `run_id, dedupe_key, cwd, timeout_sec, pid, origin_session_id` | **强（sync）**——task 域注册行丢失=dedupe 失效=重复 spawn |
| `exec.worker.finished` | worker 收尾（done/failed/killed） | `run_id, status, exit_code, duration_ms` | **强（sync）**——终态是 dedupe 真相的一部分；孤儿兜底由 task 域 reap 对账 |
| `exec.flow.appended` | flow 落盘后 | `flow_file, host, title` | 弱（vuln 候选登记） |
| `exec.import.completed` | burp 等导入落盘后 | `import_id, kind, records, hosts(≤20)` | 弱（endpoint/vuln 入库） |

全部事件按域追加 `data/events/exec.jsonl`（回放基础）。run.completed 为高频事件，**payload ≤ 2KB**（宪法 §八.5）——proposal 行本体不进 payload，落 proposal.json 文件 + 摘要（见下）。

#### 1.5.2 `exec.run.completed` payload schema（parser 直写归零的核心）

```json
{
  "id": "evt_01J...",
  "domain": "exec", "name": "run.completed",
  "ts": 1789000000000,
  "actor": "model", "session_id": "...",
  "cause": { "cmd": "exec_run_cli", "idempotency_key": null },
  "payload": {
    "run_id": "r8x1k2ab",
    "tool": "httpx", "stage": "recon", "risk": "active",
    "exit_code": 0, "duration_ms": 45230, "sandboxed": true,
    "program_id": "bytedance",
    "parse_proposal": {
      "parser": "jsonl_httpx",
      "counts": { "assets": 12, "endpoints": 40, "findings": 0, "fingerprints": 7 },
      "proposal_file": "results/r8x1k2ab/proposal.json",
      "digest": "sha256:9f2c…"
    }
  }
}
```

**proposal.json 完整 schema**（订阅方按此消费，不依赖事件 payload 结构）：

```json
{
  "run_id": "r8x1k2ab", "tool": "httpx", "parser": "jsonl_httpx",
  "program_id": "bytedance", "session_id": "…",
  "assets":       [{ "host": "a.example.com", "type": "web", "source": "httpx:r8x1k2ab",
                     "attrs": { "port": "443", "title": "…", "webserver": "nginx",
                                "status": 200, "tech": ["Nginx", "Vue"] } }],
  "fingerprints": [{ "host": "a.example.com", "tech": "Nginx", "source": "httpx:r8x1k2ab" }],
  "endpoints":    [{ "host": "a.example.com", "method": "GET", "path": "/api/v1/x?y=1",
                     "status": "200", "source": "httpx:r8x1k2ab" }],
  "findings":     [{ "title": "…", "severity": "high", "host": "…", "url": "…",
                     "evidence": "run_id:r8x1k2ab template:cve-xx-xxx" }],
  "skipped":      { "rule_layer": 3, "reasons": { "nuclei_skip_template": 3 } }
}
```

- 生成条件：manifest 声明 `parser` 且 `exit_code === 0` 且 stdout 非空（v4 `store === 'asset-graph'` 条件废止，见 2.1.1 的 store 迁移）；nuclei 三级漏斗第一层（确定性规则零 token 过滤 tech-detect/favicon/waf-detect/截图类模板）在 parser 内执行，被滤条目计入 `skipped`。
- 消费契约：**asset 域**订阅 → `asset_upsert` ×N + `fp_record` ×N（actor=script，审计带 run_id）；**endpoint 域**订阅 → `endpoint_upsert` ×N；**vuln 域**订阅 → `vuln_register_candidate` ×N（机器直灌通道，模型不可用）。订阅方失败 → audit 记 `subscriber_failed` + 事件留痕可重放（`sec bus replay`）——**不回滚 run**（run 已发生，回滚无意义）。
- `digest` = proposal.json 内容 sha256，订阅方消费前可校验完整性。

#### 1.5.3 订阅声明

| 订阅事件 | 模式 | 处理器 | 用途 |
|---|---|---|---|
| `scope.rules.changed` | sync | `onRulesChanged` | **QPS 令牌桶容量即时生效**（v4 mtime 轮询废止；scan-burst 批准 → defaults.rate_limit_qps 调大 → 桶容量同 tick 调整） |

### 1.6 模型工具面投影（工具名 + 描述全文）

| 工具名 | 描述（manifest `agent_note`，投影零改名） | 模型可见 |
|---|---|---|
| `exec_run_cli` | 运行已登记的安全 CLI 工具（manifest 驱动）。目标经 scope-guard 白名单硬校验（fail-closed，无授权即拒），参数模板化渲染，输出全量落盘 results/<run_id>/，只回 ≤20 行摘要。细节用 exec_grep_result / exec_page_result 按需取。多目标用英文逗号分隔，清单用 <target>_file 传文件。遇 needs_approval / approval_hint 禁止重试或绕过——批准后下个调度周期自然放行。 | 是 |
| `exec_spawn_worker` | 派一个隔离的无头 worker 执行自包含任务（批量复扫、大日志蒸馏等），worker 上下文独立，跑完只回尾部摘要，全文落盘 results/<run_id>/worker.log。批任务用它，不要在主会话直接跑大输出工具。幂等：宿主重启后本调用报 interrupted/outcome unknown 时，原样重试即可确定性拿回真实结果（已完成→回读、被杀→重跑）；要显式强制重跑同一任务传 force:true。目标必须作为数据逐字写进 task（RoE 契约自动注入）。 | 是 |
| `exec_burp_import` | 导入 Burp Suite 导出文件（XML：proxy history 或 scanner issues），结构化落盘 data/imports/ 并发 proposal 事件回流资产/接口/候选。人工在 Burp 里测试后导出 XML，用本工具回流系统。 | 是 |
| `exec_report_bad_proxy` | 上报坏代理（加入 blocklist + 从 live 移除，mubeng 热加载生效）。跨域命令：经 proxy 域落池。 | 是 |
| `exec_intel_hunt` | component-vuln-intel：指纹命中后查本地 nuclei 模板库找 tech 相关的 N-day 模板/CVE。命中即自动产出一条 phase=vuln、priority=1 的 N-day 候选任务（普通 queued，非自动跑；tentative，验证附证据才 confirmed）。未绑定 program 时仅返回模板列表不建任务。 | 是 |
| `exec_task_chain` | 一条 objective 自动展开为任务依赖链：能力图 BFS 凑链 + 反向剪枝到最小链，落成 parent 串联的 once 调度任务（前置未完成不派单，链式自动推进）。默认 have=["domains"]、want=findings（资产收集→存活→指纹→N-day）。链尾多为 active 扫描且会自动执行，仅对已授权 scope 使用。 | 是 |
| `exec_flow_append` | （机器通道，不向模型注册）xray webhook 原始 flow 落盘。 | 否 |
| `exec_grep_result` | 在指定 run_id 的完整输出中按正则检索（大小写不敏感），返回匹配行（含行号与文件相对路径，最多 max 条，默认 50 上限 200）。 | 是 |
| `exec_page_result` | 按行区间分页读取指定 run_id 的完整输出（offset 起始行 0 基，limit 行数上限 200）。 | 是 |
| `exec_plan_chain` | 能力原语凑链：给定已拥有的能力（have）与想要的能力（want），按 manifest 的 requires/produces 做 BFS 图搜索，返回有序工具链。侦察阶段免手工记工具顺序。 | 是 |
| `exec_manifest_list` | 枚举已登记 CLI 工具 manifest（按 stage/risk/产物域过滤），含能力与沙箱声明。 | 是 |

### 1.7 看板 RPC 投影

RPC 名 `{domain}.{verb}` 点分，由 RpcProjector 从同一组 handler 自动投影：

| RPC | 源 | 看板用途 |
|---|---|---|
| `exec.grep_result` / `exec.page_result` / `exec.plan_chain` / `exec.manifest_list` | 对应查询 | 会话详情页 run 输出查看器 / 工具链规划器 / 工具矩阵视图 |
| `exec.burp_import` | 命令 | 人工导入按钮（operator 进审计） |
| `exec.run_cli` | 命令 | 运维应急手工触发（审计高亮 actor=dashboard+operator） |
| 执行史浏览 | 总线 `audit_tail`（`kind:"guard"` 过滤 tool/target/decision/deny reason） | 审计视图守卫链流水（deny→approve 链条一眼可见） |

### 1.8 外部调用示例

**模型调用**（worker 会话内工具调用）：

```json
{ "tool": "exec_run_cli",
  "params": { "tool": "httpx", "params": { "target": "a.example.com,b.example.com" } } }
```

**代码调用**（任一域/脚本经总线，web 宿主面）：

```js
const bus = ctx.inject('secDomainBus')
const r = await bus.dispatch('exec', 'run_cli',
  { tool: 'nuclei', params: { target: 'a.example.com', templates: 'cves' } },
  { actor: 'script', run_id: 'job-42' })        // actor 由调用面注入，参数里声明一律忽略
// r = { ok: true, data: { run_id: 'r8x1k2ab', exit_code: 0, … }, event_ids: […] }
```

**脚本调用**（治理脚本经总线 CLI，actor=script）：

```bash
sec exec run-cli --tool subfinder --params '{"target":"example.com"}' --actor script
sec exec burp-import --file /tmp/burp-export.xml
# 事件回放（灾备/调试）
sec bus replay --domain exec --since 1789000000000
```

---

## 二、内部实现

### 2.1 数据模型

#### 2.1.1 `tools.d/*.yaml` manifest（31 个，v5 字段全集）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 工具名 = 文件名（去 .yaml） |
| `binary` | string | 是 | 可执行文件绝对路径（缺省回退 name） |
| `stage` | string | 是 | `recon` / `vuln` / `audit` / `triage`（能力链与 phase 映射依据） |
| `risk` | string | 是 | `passive` / `active` / `intrusive` / `manual`（四级，守卫链 G5 输入） |
| `timeout` | integer | 是 | 秒，上限 3600（超时 SIGTERM→5s→SIGKILL） |
| `target_param` | string | 否 | 目标参数名（无则触发 G3/G4 空转防护：risk≥active 拒）；`*_file` 后缀 = 清单文件模式 |
| `requires` | string[] | 否 | 前置能力（能力图 BFS 输入） |
| `produces` | string[] | 否 | 产出能力 |
| `args_template` | string | 是 | argv 模板：`{{param\|default}}` / `{{outdir}}` / `{{run_id}}` |
| `env_proxy` | boolean | 否 | true 且目标含公网 → 注入 `http(s)_proxy`（见 2.2.5） |
| `parser` | string | 否 | 解析器名（`jsonl_httpx` / `jsonl_nuclei` / `csv_ffuf` / `lines`…；路由规则见 2.3.2） |
| `summarize` | string | 否 | 摘要策略（当前 `head`：≤20 行） |
| `sandbox` | boolean | 否 | `false` = 逐工具豁免 bwrap（本地审计类用；默认沙箱） |
| **`domain`（v5 新增）** | string | 否 | **产物去向域**标注（`asset` / `endpoint` / `vuln` / `none`）——供 exec_manifest_list 投影与人读；不参与路由（路由由事件订阅决定，标注仅是文档性同步） |
| `store`（废止） | — | 废止 | **废止直写语义**（见下迁移方案） |

**`store` 字段废止直写语义的迁移方案**（宪法 §五"脚本产 proposal 不落库"）：

| 现状（v4） | v5 迁移 | 落库路径 |
|---|---|---|
| `store: asset-graph` + `parser`（httpx/nuclei/ffuf 等） | `store` 删除；`parser` 保留并升级为 **proposal 生成器**（输出 proposal.json，不碰任何表） | `exec.run.completed` 事件 → asset/endpoint/vuln 域命令 |
| `store: asset-graph` + 治理脚本（`grade_assets` / `vision_triage`） | 脚本改**纯计算**：stdout/落盘产出建议清单 JSON（runDir 内），`parser: none` | 模型读建议 → 调 `asset_grade` 命令落库（v4 grade-assets.py Python sqlite3 直写的归零路径） |
| `l2-collect`（`store: asset-graph` + `parser: lines`） | 产出 endpoints-{program}.tsv 建议文件 + proposal | 模型调 `endpoint_upsert` 批量入库（建议文件即清单） |

过渡期：读取侧忽略 `store` 字段（不报错）；写入侧（seed-manifests）停止生成；一个观察期后从 31 个 manifest 物理删除（废弃三段式）。

**31 个 manifest 完整清单**（csai 实查 2026-09-06，按通道分组的 v5 去向标注；域标注进 `domain` 字段）：

| 通道 | manifest（文件名去 .yaml） | v5 去向要点 |
|---|---|---|
| 侦察 CLI（21 个，ProjectDiscovery/开源工具链） | subfinder / dnsx / httpx / naabu / tlsx / katana / gau / waybackurls / ffuf / wafw00f / nuclei / afrog / afrog-keyword / observer_ward | domain 标注 asset（subfinder/dnsx/httpx/naabu/tlsx/katana/gau/waybackurls）或 vuln（nuclei/afrog/afrog-keyword/observer_ward/ffuf/wafw00f）——按 §2.3.2 parser 路由 |
| 漏洞利用/验证 CLI | dalfox / sqlmap / arjun / crlfuzz / graphql-cop | domain=vuln；risk 多为 active/intrusive（G5 守卫主对象） |
| 代码审计 CLI | semgrep / codeql / gitleaks / trufflehog / osv-scanner | sandbox=false（本地审计，无 target_param 不触发 G3）；domain=vuln 或 none |
| 被动测绘 API 通道 | **fofa_search**（`fofa_search.sh` 装至 /usr/local/bin，FOFA 账号凭证经 .env 供给；risk=passive） | domain=asset（API 测绘产 hosts 建议文件 → 模型调 asset_upsert）；**API 通道非本地 CLI**，但走同一 manifest/守卫/落盘框架 |
| 脚本通道（治理/观测，§2.1.1 迁移表的 store 废止主对象） | grade_assets / vision_triage / l2-collect / data_quality / discipline_audit | 纯计算产 proposal（详见上表）；domain=none |
| 测试 | echo-test | 保留（契约测试用例的工具面桩） |

#### 2.1.2 `results/<run_id>/` 落盘文件

| 文件 | 写入时机 | 内容 |
|---|---|---|
| `cmd.txt` | 进程收尾 | `[sandbox] binary arg1 arg2 …`（实际执行命令） |
| `stdout.log` | 流式 | 全量 stdout |
| `meta.json` | 进程收尾 | `run_id / tool / argv[] / params / started_at(ISO) / duration_ms / exit_code / signal / error / risk / stage / sandboxed / session_id / program_id（v5 新增列）` |
| `proposal.json` | 后处理 ③ 前 | 见 1.5.2 schema；无 parser 或 exit≠0 不生成 |
| `worker.log` | worker 专用 | worker 全量输出（stdout+stderr 合流） |
| `model-patch.yml` | worker 专用 | 任务级模型覆盖（provider/model） |

run_id 形态：`r` + ts36 + 4 hex（CLI）/ `w` + ts36 + 4 hex（worker）。retention：results/ 30 天清理（retention.timer 既有职责，不动）。

#### 2.1.3 `flows/` 与 `imports/`

- `flows/xray-{北京日期}.jsonl`：每行一个原始 webhook JSON（v4 为 UTC 日期命名，存量文件保留，新文件北京日期——宪法 §十）。
- `imports/burp-{ts36}.jsonl`：burp_import 结构化产物（记录 schema 见 1.3.3），兼作 endpoint/vuln 域的 proposal 载体。

### 2.2 状态机与不变量

#### 2.2.1 run 状态机（命令内部，非存储态）

```
dispatch → guarding(G0-G9) → spawned → running → exited(exit_code|signal|error)
  → persisted(cmd.txt/meta.json) → post(①know ②fact) → event(run.completed) → envelope
deny 路径：guarding 任一守卫失败 → kind:"guard" audit → 失败信封（run 目录已建则保留，meta.json 记 guard_deny 原因）
```

不变量 = §1.3.1 守卫链表 G0-G9（**每条有失败错误码与 guard audit 落点**——deny/allow 决策逐条记录 `{ts, run_id, tool, target, decision, reason}`，沿用 v4 结构，作为 `kind:"guard"` 与命令审计并存，宪法 §九）。

#### 2.2.2 worker 状态机（存储在 task 域 workers 表，此处仅语义）

```
registered(running) ──exit 0──▶ done
                     ──exit ≠0─▶ failed
                     ──signal──▶ killed（超时/组杀；重试语义=重跑）
pid 死的 running ──对账──▶ killed（僵尸回收）
```

#### 2.2.3 QPS 令牌桶

进程级单例 `{tokens, cap, last}`；仅 active+ 工具执行 `throttleQps` 循环等待（不拒绝）；容量 = `defaults.rate_limit_qps`（下限 1）；**订阅 `scope.rules.changed` 即时调整 cap**（替代 v4 loadScope mtime 缓存轮询）；重启清零无妨（启动即满速补充语义可接受）；单次 CLI 内部请求速率仍由工具自身 flag 控制（tools.d 各自 rate/limit 参数）。

#### 2.2.4 bwrap 沙箱（S2）与 owns × 沙箱交叉断言（宪法 §十四.3 本域实施）

沙箱参数（完整，v4 原样）：

```
bwrap --unshare-all --share-net --die-with-parent --new-session
      --proc /proc --dev /dev --tmpfs /tmp
      --ro-bind /usr /usr --ro-bind /etc /etc
      --symlink usr/bin /bin --symlink usr/sbin /sbin --symlink usr/lib /lib --symlink usr/lib64 /lib64
      [--ro-bind /opt/silkspool/dsh/venv …] [--ro-bind /opt/silkspool/dsh/opt …]
      --bind $HOME $HOME          ← 可写（nuclei-templates 更新等工具自身需要）
      --bind <runDir> <runDir>    ← 可写（本次执行唯一可写工作区）
      -- <binary> <argv…>
```

- 适用条件：manifest 有 `target_param` 且 `sandbox !== false`（本地代码审计工具无 target_param 需读任意源码路径，不沙箱）。
- 降级：`SEC_NO_SANDBOX=1` 或 bwrap 缺失 → 优雅降级不沙箱（audit 的 `sandboxed:false` 可见）。
- 效果：平台密钥（.env / settings.yaml / cordis.patch.yml / keys）与系统写路径对工具不可见。

**交叉断言（setup.sh 冒烟阶段执行，fail-fast）**：

1. 收集全部 14 域 manifest `owns.files` 声明的路径集合 `O`；
2. 收集沙箱可写挂载清单 `W`（`--bind` 非只读项）= `{当前 runDir, $HOME, /tmp(tmpfs), /dev, /proc}`；
3. 断言 `O ∩ W = ∅`——**任何域 owned 文件对沙箱必须不可写**。本域自身的豁免以粒度声明：exec 域 manifest 声明 `sandbox_writable: ["results/<run_id>/*（仅当前 runDir 运行期实例化）"]`，tools.d / flows / imports / 他域全部 owns 路径不在 `W`（data/ 根本未挂载进沙箱 → 天然不可写）。
4. 注记：`$HOME` 当前可写是已知开口（nuclei-templates 更新依赖）；因全部域 owns 路径都在 `/opt/silkspool/dsh/data/` 下（未挂载），断言 3 成立。若未来域 owns 文件落入 `$HOME`（如 ~/.config），须收窄 HOME 挂载为只读 + 显式白名单子路径——已列入 §四 开放问题。

#### 2.2.5 代理注入

`env_proxy: true` 且目标**非全内网**时注入 `http_proxy/https_proxy/HTTP_PROXY/HTTPS_PROXY = <defaults.egress_proxy>`（默认 `http://127.0.0.1:8899`）。内网判定 `isInternalHost`：`localhost` / `*.singll.net` / `*.internal` / `*.lan` / RFC1918（10/8、172.16/12、192.168/16）/ 169.254/16 / 127/8 → 直连（公网代理到不了内网）。全部目标均内网 → 直连；混合 → 注入（内网目标走代理失败的兜底由工具重试/负知识沉淀承担）。

### 2.3 事务与联动

#### 2.3.1 事务边界

exec 域后端为 file——**没有跨行事务需求**：单文件追加（flows/imports/events）依赖 O_APPEND 单次 write 原子性；runDir 多文件落盘非原子但天然按 run 隔离（半落盘 run 由 meta.json 缺失/exit_code null 识别，retention 兜底清理）。命令语义上的"事务"= 守卫全过才 spawn、落盘完成才发事件（失败不发，宪法 §四.6）。

#### 2.3.2 域间联动实现（run_cli 后处理，顺序固定）

| 步 | 目标域 | 形态 | 失败语义 |
|---|---|---|---|
| ① | know | `dispatch('know','pb_outcome',{name:"tool:<tool>",success,duration_ms})` | 弱：audit 记 `dispatch_failed`，run 结果不受影响 |
| ② | fact（仅 exit≠0 且有 program） | `dispatch('fact','upsert',{fact_key:"note/fail-<tool>-<host>"…, confidence:"tentative", source:"auto:runcli-fail"})` | 弱：同上 |
| ③ | 总线 EventBus | 发布 `exec.run.completed`（proposal 摘要） | 弱：订阅者（asset/endpoint/vuln）失败记 `subscriber_failed`，可重放 |

parser 注册表（`parsers/` 目录，v4 parsers.js 172 行平移）：路由三级——`<parser>_<tool>` 精确 → `<parser>` 通用 → 回退 `ingest` 纯正则抽取（回退路径 v5 同样只产 proposal）。解析器**只读 stdout 文本、只写 proposal.json**，不 import 任何域模块、不开数据库连接——v4 `applyParsedResult` 里 `db.upsertAsset/upsertEndpoint/addFinding/fpAdd` 四处直写全部废止。

#### 2.3.3 审批联动（G5/G9 拒绝点）

intrusive 拒绝 / S5 写动词拒绝 → `dispatch('approval','request',{kind:"tool-intrusive", subject:"<tool>:<target>", payload:{tool,risk,target,params(脱敏),program[,guard,verb,url]}})`；approval 域负责登记与看板渲染；批准后 scope 域写白名单 → 本域无需订阅任何事件（重试时 G5/G9 查 scope 域数据自然放行）。审批落库失败不改变拒绝语义，但当前实现仅退回通用 hint、**不产生独立 audit 记录**；这是 2026-09-12 审查确认的可观测性缺口。

### 2.4 后端适配器

repository 接口（JSDoc 定义，方法名 = 原语）：

```js
// backend/repository.js（exec 域唯一后端 = file）
listManifests() → string[]
loadManifest(name) → object|null
createRunDir(prefix) → {runId, runDir}                    // mkdir -p results/<id>
writeCmd(runDir, text) / appendStdout 流式 / writeMeta(runDir, meta)
writeProposal(runDir, proposal)
readRunDirTree(runId) → 文件清单（grep 用）
appendFlow(date, line) / appendImport(id, line)
listRuns(filter) → 不提供（执行史浏览走总线 audit_tail）
```

能力矩阵：

| 命令/查询 | file | sqlite-local | http-remote |
|---|---|---|---|
| 全部命令与查询 | **full** | unsupported（无 owned 表） | unsupported |

exec 域**没有** sqlite/http 后端计划——owns 全是文件，域内无结构化查询（grep/page 是文件原语）。`E_CAPABILITY_UNSUPPORTED` fail-closed。

### 2.5 缓存与失效

| 缓存 | 位置 | 失效 |
|---|---|---|
| QPS 桶容量 | 进程级单例 | `scope.rules.changed` 事件（**mtime 轮询废止**） |
| scope 数据 | **不在本域**（G4 每目标同步查 scope 域 `scope_check`，缓存归 scope 域管辖） | scope 域自治 |
| manifest | 无缓存（每次 dispatch 读文件解析；31 个 YAML × 每日数百次调用 <10ms 级，不值得缓存换失效复杂度；v4 同款决策保留） | — |
| grep/page | 无缓存（文件原语直读） | — |

### 2.6 性能与容量

| 指标 | 现状（v4.7 实测口径） | 预期 |
|---|---|---|
| manifest 数 | 31 | 缓增（+数个/季） |
| results/ | 30 天 retention；每日数十~数百 run，单 run 数 KB~数十 MB | 不变 |
| events/exec.jsonl | run.completed ~1KB/条 × 每日数百 ≈ 数百 KB/日 | 留痕无轮转上限，年 ~200MB 可接受（后续按域轮转进总线议题） |
| QPS 桶 | 进程级，零开销 | — |
| grep 全 run 目录 | 单 run 文件数 <100，全扫 <50ms | — |

### 2.7 平台资产声明（exec 域周边的不动清单）

exec 域的运行依赖一批**平台层边缘资产**——它们不属于任何域、v5 不改造不域化（"DSH 平台层不动"宪法边界），但 exec 域的契约语义与其耦合，在此集中声明以防漂移（本节是**声明不是 owns**）：

| 平台资产 | 实况 | 与 exec 域的耦合点 |
|---|---|---|
| `silksec-shared-browser.service` | 常驻 Chromium（CDP **:9222**），持久化 profile=登录态，人机共用 | **浏览器共驾底座**：模型经 `@silksec/dsh-browser` 工具操作的就是这个实例；登录态观测回填 endpoint 域（04-endpoint C1） |
| `@silksec/dsh-browser` fork | 上游 DSH 浏览器插件 fork（tarball + `dsh-browser-upstream.index.js` / `browser-manager.js` patch）；patch 注入 `SEC_FLOW_PROXY` 出口代理 | 模型工具面成员之一（投影规则同 17-llm-surface；fork 维护见 18-migration §九） |
| 浏览器出口代理（`SEC_FLOW_PROXY` → xray :7777） | 浏览器全部流量经 xray 被动扫描（:7777 入口）→ webhook :7788 → 本域 `exec_flow_append` 落 flows/ | **7777 入口是 flows 数据的另一半来源**（§1.3.7 只写了 7788 落点）——浏览器会话产生的被动扫描发现同样进 flow 管道 |
| `silksecagent-edge` :9223 浏览器入口 | edge-Caddyfile：basicauth + browser.html 落地页 + DevTools 前端自托管反代 | 人机共用浏览器的 LAN 访问入口（探活进 01-bus §2.7 冒烟）；Web UI 主入口 :3080 的 Host/Origin 改写详见 18-migration §九 |
| `oob/interactsh-server` | 已部署未启用（占位 `OOB_DOMAIN_TBD`，阻塞=公网 NS 委派） | OOB 带外验证通道（盲 SSRF/盲 RCE 回连证据）。证据形态 `oob:` 前缀与轮询归属见 02-vuln §四.7；启用前工具面须能感知"OOB 不可用"并降级 |
| `silksec-intel.timer` | 每日 nuclei 模板更新（intel-refresh.sh → `~/nuclei-templates` → `data/intel/intel.jsonl` 追加一行版本记录） | **域外单写者声明**：intel.jsonl 由 systemd timer 写入（不经总线、无事件）——它不在本域 owns 内，`exec_intel_hunt` 是其**消费方**（模板库检索）；版本追溯经文件读取而非事件回放，01-bus §2.7 的 data/events 统一口径对它豁免 |

**不动清单的边界**：上表资产出问题时（浏览器崩/OOB 启用/intel.jsonl 格式变化）的处置走 18-migration §九部署通道与运维手册，不改域契约；域文档只在耦合点语义变化时同步本表。

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

来源：`bundles/dsh/templates/dsh-plugin-sec-suite.js`（index.js 2142 行）+ `dsh-plugin-sec-suite.parsers.js`（172 行）+ `dsh-plugin-sec-suite.dashboard-rpc.js` + `dsh-plugin-sec-suite.webhook.js`。

| # | v4 位置（文件:行） | 内容 | v5 去向 |
|---|---|---|---|
| 1 | index.js:1078-1101 | renderTemplate / shellSplit | `commands/run-cli.js` 渲染段 |
| 2 | index.js:1206-1417 | runCli 主体（守卫编排/执行/落盘/摘要） | `commands/run-cli.js`（守卫拆为网关 invariants G0-G9） |
| 3 | index.js:1103-1115 | extractTargets（target_param / *_file 清单） | 守卫 G3 |
| 4 | index.js:186-214, 931-947 | hostOf / entryMatches / cidrContains / checkTarget | **授权语义归 scope 域**（08-scope.md）；exec 保留 hostOf 工具函数（归一化是执行域的参数处理，白名单判定是 scope 域查询） |
| 5 | index.js:164-184 | ipToInt / cidrContains | scope 域（S1 判定用）；exec 域不复制 |
| 6 | index.js:949-971 | checkRisk + toolNameOfRiskCheck 桥 | 守卫 G5（白名单查询经 scope 域；桥变量废止——守卫签名显式带 tool） |
| 7 | index.js:973-1032 | RESERVED_CIDRS / ipInReserved / verifyResolved | 守卫 G6（原样保留，DNS resolve4 容错语义不变） |
| 8 | index.js:42-50, 1041-1058 | WRITE_VERBS 33 词表 / findWriteVerbHit | 守卫 G9（词表冻结进契约） |
| 9 | index.js:236-259 | qpsBucket / acquireQpsToken / throttleQps | 2.2.3（mtime 轮询→rules.changed 订阅） |
| 10 | index.js:216-225 | loadScope / scopeCache | **废止**（scope 域接管；exec 不再读 scope.yml） |
| 11 | index.js:1148-1180 | bwrap 参数 / buildSandboxCommand | `sandbox/bwrap.js` + 2.2.4 交叉断言 |
| 12 | index.js:1359-1368 | cmd.txt / meta.json 落盘 | `commands/run-cli.js` 落盘段（meta 增 program_id） |
| 13 | index.js:1371 | exp.pbOutcome 调用 | dispatch know 命令（弱联动） |
| 14 | index.js:1373-1386 | factUpsert 负知识 | dispatch fact 命令（弱联动） |
| 15 | index.js:1392-1400 | applyParsedResult 调用（store 条件） | proposal 生成（store 条件废止） |
| 16 | parsers.js:1-172 | 解析器注册表 + 直写入库 | `parsers/` 目录；159-171 行直写循环**删除**，改写 proposal.json |
| 17 | index.js:1425-1464 | grepResult / pageResult | 查询 `queries/grep-result.js` / `queries/page-result.js` |
| 18 | index.js:1475-1522 | burpImport | `commands/burp-import.js` + `exec.import.completed` 事件 |
| 19 | index.js:1601-1744 | runWorker / spawnWorker / ROE 块 / readWorkerResult | `commands/spawn-worker.js`；workerRegister/workerFinish 调 task 域命令 |
| 20 | index.js:1747-1764 | workerStatus | **task 域查询**（worker 注册表归属；别名见 3.2） |
| 21 | index.js:1790-1844 | intelHunt | `commands/intel-hunt.js`（建任务改 dispatch） |
| 22 | dashboard-rpc.js:39-73 | planChain BFS | 查询 `queries/plan-chain.js` |
| 23 | dashboard-rpc.js:76-135 | taskChain（剪枝/建链） | 命令 `commands/task-chain.js`（建任务改 dispatch） |
| 24 | webhook.js:1-53 | startXrayWebhook（直调 addFinding） | exec 域 webhook 接收器 + `exec_flow_append` 命令 + `exec.flow.appended` 事件（addFinding 直调废止） |
| 25 | index.js:468-475 | enqueueScopeSeed 的 radar-queue 直写 | approval 域订阅者调 `ledger_radar_push`（11-ledger.md） |
| 26 | index.js:853-865 | sanitizeParamsForApproval | 审批 payload 脱敏（随 tool-intrusive 联动保留在本域） |
| 27 | index.js:1529-1594 | authzDiff | **vuln 域 C11 `vuln_authz_diff`**（02-vuln.md §1.3——判定与候选登记是漏洞域语义；exec 只留 hostOf 借用） |

### 3.2 兼容别名与观察期

总线 `aliases` 表（同样过网关全管线，不绕校验；一个观察期 7 天 audit 零使用后删除）：

| 旧名 | 新名 |
|---|---|
| `run_cli` | `exec_run_cli` |
| `spawn_worker` | `exec_spawn_worker` |
| `grep_result` | `exec_grep_result` |
| `page_result` | `exec_page_result` |
| `plan_chain` | `exec_plan_chain` |
| `task_chain` | `exec_task_chain` |
| `intel_hunt` | `exec_intel_hunt` |
| `burp_import` | `exec_burp_import` |
| `worker_status` / `worker_list` | `task_worker_status` / `task_worker_list`（**task 域**，跨域别名） |
| `proxy_pool_report_bad` | `exec_report_bad_proxy`（v4 工具面与 v5 命令同名归一；proxy 域另有 RPC 面） |

prompt 引用同步：persona/objective/skills/technique-index 中工具引用由脚本化改写（复用 p14-1-tool-refs.py 模式），改写后 discipline-audit 增加"悬空工具引用"断言（宪法 §十五.4）。

### 3.3 数据迁移脚本要点

1. **零迁移**：results/、flows/、imports/、tools.d/ 原样接管（文件格式不变，run_id 语义不变）。
2. tools.d manifest 批量脚本：31 个 yaml 注入 `domain` 字段（按 parser/产物映射表：jsonl_httpx→asset+endpoint、jsonl_nuclei→vuln、治理脚本→none）；`store` 字段读侧忽略、写入侧停发、观察期后删除。
3. flows 文件名日期口径切换：新写入北京日期；存量 UTC 命名文件不重命名（查询按通配 `xray-*.jsonl` 聚合）。
4. meta.json 增加 `program_id` 列：存量 run 缺列读取层容错（null = 未解析归属）。
5. 回滚：域插件独立 revert（bundle 配置摘除挂载行即回到 v4 路径；文件层无破坏性变更）。

---

## 四、开放问题

| # | 问题 | 当前倾向 |
|---|---|---|
| 1 | `$HOME` 可写挂载是沙箱已知开口（nuclei-templates 更新需要）。若未来任何域 owns 文件落入 $HOME，断言 2.2.4-3 失效 | 收窄为 `--ro-bind $HOME` + 显式可写白名单子目录（如 ~/.cache/nuclei）；等首个真实需求再动 |
| 2 | `exec_run_cli` 的 `explicit_only` 幂等策略是宪法 §六三级之外的第四种（执行类动词特有） | 已在 manifest 声明层容纳；若 05-task.md 的 task_run_now 出现同需求，考虑把 explicit_only 升为宪法正式条目 |
| 3 | 代理注入对"混合目标"（部分内网部分公网）一刀切注入，内网目标走代理必失败 | 保持现状（负知识自动沉淀兜底）；按目标分进程执行是模型侧纪律（拆两次 run_cli） |
| 4 | events/exec.jsonl 无轮转（年 ~200MB） | 总线层议题（按域轮转策略统一设计），不在本域单独处理 |
| 5 | `exec_manifest_list` 的 `domain` 字段与事件订阅路由是两份人工同步的真相 | 接受（标注仅文档性）；setup.sh 冒烟可加"domain 字段与订阅方清单一致性"软断言 |

## 五、2026-09-12 深度审查结论

| 维度 | 结论 |
|---|---|
| 逻辑/功能 | 11/11 契约通过；scope/risk/sandbox/QPS/timeout/parser proposal/worker 守卫链完整。 |
| 静默错误 | 自动 approval 落库失败被 `fileApproval` 吞掉并退回通用 hint，无独立 audit；intel_hunt 建任务失败也不阻断检索。 |
| 性能 | run_cli 输出全量落盘、只回 20 行摘要，设计正确；大文件由 grep/page 分页。 |
| 风险 | task `worker_recent` 查询失败时 dedupe 预检被跳过，极端情况下可重复 spawn；worker 并发上限仍兜底。 |
| hook 判定 | parser 只写 proposal + 事件，由 asset/endpoint/vuln 域消费；合格。 |
| 独立升级 | 支持单域替换；须与 scope、task、proxy、know 及三个 parser 消费域联测。 |
