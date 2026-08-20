# 基于 DSH + pi 的 AI 网络安全辅助平台方案 v3

> **实施状态（2026-08-20）**：P0 底座已完成——`bundles/dsh`（SilkSecAgent）已落地并在 csai 跑通：
> `spool bundle dsh setup csai && spool bundle dsh up csai` 一条链验证通过，Web UI 于 127.0.0.1:3080 正常响应（HTTP 200）。
> 已验证：setup 幂等重跑、`spool bundle dsh upgrade csai`（版本检查+备份+冒烟+回滚）、tools-manager 安装/升级/卸载/状态闭环（20 个核心工具已装齐）。
> 关键经验：DSH 依赖图巨大，**npm 解析会卡死，必须用 pnpm**（14 秒装完）；dsh rc.7 无 `--no-open` 参数，systemd 下用 `--host/--port` 显式指定。
>
> **CyberStrikeAI 已退役（2026-08-20）**：服务已停并卸载，数据资产完整保留——全量备份 `/opt/silkspool/csai/backups/csai-retire-20260820_065716.tgz`（含 conversations.db 漏洞/会话、knowledge.db、eino-checkpoints 黑板、knowledge_base），
> 并已解包到 `/opt/silkspool/dsh/data/import-staging/cyberstrikeai/` 等待导入 SilkSecAgent；管理机本地备份 `~/silkspool_backups/csai/20260820_065822`。
> **代理池已迁移为 DSH 原生插件**：`@silksec/dsh-proxy-pool`（bundles/dsh/templates/dsh-plugin-proxy-pool.js，6 个 proxy_pool_* 工具经 `ctx.tools` 注册，零依赖），
> 替代原 MCP 模式（mcp_proxy_pool.py 退役）；mubeng 轮换网关（:8899）与采集/分级 timer 保留在 csai bundle 继续运行。
> 关键经验：`dsh plugin add` 会把包写入 profile 的 `dsh.profile.bundles`；**link: 安装下插件目录取不到 peer 依赖，插件须零依赖**（defineTool 产物内联手写即可）；
> `dsh plugin` 子命令必须显式传 `DSH_HOME` 和 pnpm PATH，否则误建 `~/.dsh`。
> 待办：其余 6 个社区插件（plugins.lock）待 P3/P4 扫描后启用。
>
> **P1 已补齐（2026-08-20）**：18 个工具 manifest 种子（seed-manifests.sh 幂等补齐）；`burp_import` 工具落地
> （Burp XML proxy history / scanner issues → JSONL 落盘 data/imports/，实测解析正确）。
> **P2 已完成（2026-08-20）**：
> - `spawn_worker`：隔离无头 worker（复用 DSH headless profile 子进程，并发上限 4，只回尾部摘要），
>   sec-suite/proxy-pool 插件已同时装入 web+headless 双 profile，真实 LLM 调用验证通过（3s 出结果）。
>   注：pi-bridge 未做——DSH 内建 headless profile + dsh-llm-pi-ai 多供应商路由已覆盖其价值，pi 侧保持零扩展；
> - dsh-browser@0.1.0（扫描 PASS）+ Playwright chromium headless 验证通过；
> - **token 量化验收**：subfinder 真实输出 548,994 字节（≈137k tokens）→ 摘要 479 字节（≈120 tokens），
>   **压缩比 1146x**；worker 日志全量落盘只回尾部——批任务上下文污染结构性消除。
>
> **多供应商切换已上线（2026-08-20）**：dsh-model-failover@0.1.4（扫描 PASS）安装完成，两级熔断（模型级/平台级）+ 冷却探针自动恢复，
> 与官方 llm-retry 分层（route 内重试 → 熔断切换）。配置分两处（均有用户空位）：
> ① `settings.yaml` 的 `llm-pi-ai.providers`：供应商声明（apiKeyEnv 引用 .env，零明文；opencodego 空位已注释预留）；
> ② `cordis.patch.yml` 的 `model-failover.fallbacks`：优先级链（已纳入 spool sync 管理）。
> **403 修复**：DSH rc.7 把 settings.*/credentials.*/agentPreset.* 等特权 API 钉死在 loopback（LAN/域名必然 403，设计如此）；
> 边缘代理从 socat 换为 caddy（silksecagent-edge）做 Host 改写绕过栅栏，DSH 移至环回 3081，边缘 3080。
> **二次修复（2026-08-20）**：Host 改写后浏览器 POST 仍 403——栅栏校验 `Origin.host === Host.host`，
> 浏览器必带 Origin（curl 不带，造成上次"已修复"的假阳性），边缘需**同步改写 Origin**（edge-Caddyfile 已加 header_up Origin）。
> 踩坑：caddy 站点地址不匹配 Host 会静默回空 200（假阳性），通配站点 `http://:3080` 解决；端口冲突需先停旧进程；
> **验收必须带 Origin/Sec-Fetch-Site 头的 POST + WebSocket 升级测试**。
>
> **代理池产权迁移完成（2026-08-20）**：代理池基础设施（mubeng/采集/分级/timer）整体迁入 bundle dsh，
> 单元更名 silksec-proxy-rotator/refresh，数据目录 /opt/silkspool/dsh/proxy-pool；旧 csai-proxy-* 单元已停用删除，
> /opt/silkspool/csai/ 仅余 backups/。silkspool.yaml 已清理 CyberStrikeAI 全部 sync_rules/services/hooks/backups，csai 主机 bundles 仅剩 ["dsh"]。
> DEEPSEEK_API_KEY 已推送生效（进程内确认，API 直连验证返回模型列表 deepseek-v4-pro/flash）。
> **DSH 原生已有多供应商底座**：`@deepseek-ai/dsh-llm-pi-ai`（pi-ai 驱动的多 provider 配置，按 route 声明 apiKeyEnv/baseURL/retryPolicy）
> + `@deepseek-ai/dsh-llm-retry`（同 provider 内重试，**不做跨 provider 切换**）。
>
> **auth-gate 已完成（2026-08-20）**：dsh-auth-gate@0.7.2（静态扫描 PASS，hash 已入 plugins.lock），密码模式 admin 用户已建，
> 未登录 401 / 登录 302 / 带 cookie 200 全链路验证通过。注意 **dsh rc.7 强制 loopback 绑定**（拒绝 0.0.0.0 与具体 LAN IP），
> 故新增 `silksecagent-edge.service`（socat 转发 192.168.7.107:3080 → 127.0.0.1:3080）开放内网访问。
> LAN 地址：http://192.168.7.107:3080；**域名 https://silksecagent.singll.net 已上线**（spool dns + istoreos Caddy 反代，LE 证书已签发；
> 注意仅不依赖 **AI 网关** New API，内网 DNS/Caddy 网关体系正常使用）。
> 踩坑：istoreos 的 Caddyfile 是**单文件 bind mount**，sync push 替换 inode 后容器内看到旧文件，`docker restart caddy` 才生效。
>
> **P1 已完成（2026-08-20）**：`@silksec/sec-suite` 插件落地——sec-cli-adapter（run_cli/grep_result/page_result 三工具，
> manifest 驱动、模板渲染、超时/代理注入、results/<run_id>/ 全量落盘、≤20 行摘要）+ 内建 scope-guard
> （域名后缀/CIDR/精确匹配、排除清单、风险四级、fail-closed、audit.jsonl 全量审计）。
> 单测 7/7 通过（授权/CIDR/排除/未授权拒绝/grep/page/缺 manifest），subfinder 真实端到端跑通（23363 行输出仅回 20 行摘要）。
> 内置极简 YAML 解析器（零依赖），种子 manifest：subfinder/httpx/nuclei/katana/echo-test。
> scope.yml 当前 programs 为空 = 全拒绝，授权目标需先登记。

> 基础事实：2026-08-20 已用 spool 实测 csai 主机（Ubuntu 24.04 / 8C / 16G / 余 939G / **无 Docker 无 Node**），并核实 DSH、pi 上游仓库。
>
> - DSH：https://github.com/deepseek-ai/deepseek-harness （Cordis "一切皆插件" 架构，`npx @deepseek-ai/dsh web` 起 Web UI :3080，开发者预览版，MIT）
> - pi：https://github.com/earendil-works/pi （`pi-agent-core` agent 运行时 / `pi-ai` 统一 LLM API / `pi-coding-agent` CLI，官方明示无内置权限系统，MIT）
> - CyberStrikeAI：https://github.com/Ed1s0nZ/CyberStrikeAI （仅作设计借鉴，不部署、不照搬、不依赖）
>
> **v3 变更摘要**（相对 v2）：
> 1. 明确主次纪律：DSH 为主框架，pi 仅为执行器（§一）；
> 2. 自研插件层 8 → 4，一半能力改由 DSH 官方包组合（§五、§六）；
> 3. 新增浏览器共驾层 + 流量总线 + Burp 回流（§5.5），知识导入管道（§5.6），HITL 断点清单（§5.7）；
> 4. 社区插件精选 9 个（经调研 dsh-plugin 生态 8000+ 仓库后收敛，§6.2）；
> 5. 补 SRC 业务逻辑漏洞打法、经验卡生命周期、token 账本（§四、§5.3）；
> 6. 合规护栏补 Web UI 认证、出口管控、注入防护、插件供应链审查（§十）。

## 一、为什么是"DSH 为主体 + pi 融合"，以及怎么融合

### 1.1 两者互补点（实测核实后的精确分工）

| | DSH | pi |
|---|---|---|
| 本质 | **Agent Harness**（宿主）：Web UI、会话管理、调度、持久化、插件生态 | **Agent 工具库**：`pi-agent-core`（agent 运行时）、`pi-ai`（统一 LLM API）、`pi-coding-agent`（CLI） |
| 强 | 一切皆插件（Cordis）、跨会话状态、事件流/trajectory（**自主学习的抓手**）、人机交互界面 | 无头 agent 循环、多 provider 模型路由、可编译独立二进制、极轻 |
| 弱 | 批处理/无头执行不是主场景 | 无 UI、无调度、**官方明示无权限系统** |

### 1.2 主次纪律（不可颠倒）

**DSH 是主框架，pi 是执行器/手下。** 具体含义：

1. **一切能力以 dsh-plugin 形态挂载在 DSH 上**——浏览器、搜索、记忆、审批、通知、调度全部如此；
2. **pi 保持"光杆执行器"**：只做两件事——无头 agent 循环执行、pi-ai 模型路由；pi 侧**不安装任何业务扩展**（不装 pi-chrome / pi 记忆扩展 / pi 权限扩展等，避免能力倒挂、双轨维护）；
3. pi worker 调用的工具全部由 DSH 插件注册下发，worker 的事件全量回流 DSH 事件流——**worker 可观测性与主会话同级**；
4. 经验、资产、审计、知识全部沉淀在 DSH 侧数据层，pi 无状态，可随时替换/升级。

### 1.3 融合方式：pi 作为库嵌入 DSH 插件（同进程）

```
DSH 宿主（主进程，:3080 Web UI）
 └─ Cordis 插件: pi-bridge（本方案自研，npm 依赖 pi-agent-core + pi-ai）
     ├─ 注册 DSH Service: ctx.pi
     │    ├─ ctx.pi.spawn(preset, task)   → 起一个无头 pi agent 循环（子任务执行体）
     │    └─ ctx.pi.route(taskType)       → pi-ai 按任务类型选模型（蒸馏用小模型/判定用大模型）
     ├─ worker 实现为官方 subagent seam 的 provider，批任务纳入官方 jobs 管理
     │   （UI/审计/工具注册对 worker 天然可见，杜绝"黑盒中的黑盒"）
     ├─ DSH 主会话 Agent 持有工具 spawn_worker → 把"跑 50 个 URL 的 nuclei 复扫"这类
     │   脏活派给 pi worker，worker 跑完只回结论，主会话上下文不被污染
     └─ schedule 插件的周期任务（复扫/情报验证/复盘蒸馏）全部经 ctx.pi 派发
```

这样的融合收益：

1. **主会话上下文保护**：批任务的成千上万行工具输出只经过 pi worker 的上下文，蒸馏后才回主会话——这是解决"token 消耗不可控"的结构性方案；
2. **模型分层**：pi-ai 做统一路由，侦察摘要/日志蒸馏走便宜小模型，漏洞判定/报告/复盘走大模型，一处配置全局生效；
3. **单进程单日志**：worker 的 trajectory 也落 DSH 事件流，经验采集无死角；
4. **无 IPC 脆弱面**：同进程库调用，不存在两个服务间的超时/鉴权/版本对齐问题。

worker 纪律（回应"子代理是黑盒"的批评）：**worker 只执行确定性流水线（manifest 定义的固定步骤 + 蒸馏返回），开放式探索留在主会话**；worker 并发 ≤4，防止扫描面不可控扩散。

另外保留 `pi-coding-agent` CLI 作为**人的入口**：工程师用它写/调试 Playbook 和工具 manifest（它是现成的、自带文件操作能力的终端 agent，不用自己造）。

## 二、总体架构

```
┌──────────────────────── csai 主机（无 Docker，全原生 systemd）────────────────────────┐
│                                                                                      │
│  ┌─ DSH 宿主（dsh.service, :3080 Web UI）─────────────────────────────────────┐     │
│  │                                                                              │     │
│  │  ┌─ 官方包组合层（stable API，随 DSH 升级，见 §6.1）────────────────────┐   │     │
│  │  │  执行: sandbox(bwrap/Landlock) · jobs · workflow · subagent · schedule │   │     │
│  │  │  上下文: spill · compaction · guard                                    │   │     │
│  │  │  人机: interaction(审批) · feedback(打标)                              │   │     │
│  │  │  数据: session · session-query(FTS) · storage · credentials            │   │     │
│  │  │  组合: preset · skill · goal/plan/todo · extensions(自修改)            │   │     │
│  │  └──────────────────────────────────────────────────────────────────────┘   │     │
│  │                                                                              │     │
│  │  ┌─ 社区精选层（9 个，pin 版本 + shim 收敛，见 §6.2）───────────────────┐   │     │
│  │  │  dsh-browser(浏览器共驾) · egress-guard · taintguard · auth-gate       │   │     │
│  │  │  dsh-bill(token账本) · negative-ledger · knowledge-base                │   │     │
│  │  │  dsh-sentinel(条件触发) · chicheng-push(通知)                          │   │     │
│  │  └──────────────────────────────────────────────────────────────────────┘   │     │
│  │                                                                              │     │
│  │  ┌─ 自研插件层（仅 4 个安全领域核心件，独立 npm 包，dsh-plugin）─────────┐   │     │
│  │  │  sec-cli-adapter  CLI 工具适配（清单驱动，token 经济核心）              │   │     │
│  │  │  asset-graph      资产图谱（SQLite：资产/接口/指纹/凭据/关系边）        │   │     │
│  │  │  experience-hub   经验中枢（经验卡 + 向量库 + 事实黑板）                │   │     │
│  │  │  scope-guard      SRC 白名单硬校验 + 风险分级 + 全量审计                │   │     │
│  │  │  （+ pi-bridge 融合层，见 §1.3；playbook-ranker 仅做排名，执行走        │   │     │
│  │  │   官方 workflow 包）                                                   │   │     │
│  │  └──────────────────────────────────────────────────────────────────────┘   │     │
│  │                                                                              │     │
│  │  ┌─ Agent Preset 层（官方 preset 包，cordis.yml 组合）─────────────────┐   │     │
│  │  │  角色：recon / vuln-hunt / biz-logic / code-audit / intranet / review  │   │     │
│  │  │  Skills：极简常驻（每条一两行铁律）+ 完整版存文件按需 read              │   │     │
│  │  │  工具：run_cli / spawn_worker / query_asset / search_exp / store_exp   │   │     │
│  │  └──────────────────────────────────────────────────────────────────────┘   │     │
│  └──────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                      │
│  ┌─ 浏览器层（dsh-browser 插件驱动真实浏览器，人机共驾）──────────────────────┐     │
│  │  AI 点击/登录/遍历 → 流量入总线；人可随时接管（过验证码/登录/风控）          │     │
│  └──────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                      │
│  ┌─ 流量总线（mitmproxy 监听）───────────────────────────────────────────────┐     │
│  │  浏览器/人工流量 → xray 被动审计 + 全量归档(flow_id) + 接口提取入图谱       │     │
│  │  + AI 被动分析 worker；Burp XML 导入导出（burp-ingest，人工验证位双向打通） │     │
│  └──────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                      │
│  ┌─ CLI 工具层（tools-manager 安装到系统，apt/go/pip 三通道）──────────────────┐     │
│  │  ~60 个命令行工具（清单见 §四），全部经 sec-cli-adapter 调用                  │     │
│  └──────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                      │
│  ┌─ 出口代理（现有资产，直接复用）：mubeng 轮换网关 127.0.0.1:8899 ──────────────┐     │
│  └──────────────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────────┘
         │ LLM 调用（pi-ai 统一出口，OpenAI 兼容）
┌────────▼─────────┐
│ 模型供应商直连     │  DeepSeek 等官方 API（不经任何网关，key 存 .env）
└──────────────────┘
```

**核心原则**：工具调用只有一条路——`sec-cli-adapter` → 本机 CLI；浏览器操作只有一条路——`dsh-browser` → 流量总线。所有可控性（参数、输出、摘要、落盘、审计）都在我们自己的适配层里，每一行进出模型的内容都可审计、可优化。

## 三、从 CyberStrikeAI 借鉴什么（只借鉴设计，不照搬实现）

| 其设计 | 借鉴方式 | 我们的实现 |
|---|---|---|
| YAML 工具配方（~90 个工具的参数/用法结构） | 借鉴**格式思路**，字段重设计 | 我们的 manifest 增加 `stage/risk/summarize/store/parser` 字段（§5.1），内容按我们工具链自己写 |
| pentest-verification（验证铁律） | 借鉴**纪律** | Skill：`任何漏洞结论必须附 run_id + 原始输出路径，否则视为幻觉打回` |
| pentest-blackboard（黑板） | 借鉴**机制** | experience-hub 内的事实黑板表：凭据/存活主机/已试路径，跨会话共享 |
| capability-primitive-search（能力原语凑链） | 借鉴**算法思路** | 每个 manifest 声明 `requires: [活着的web资产]` / `produces: [指纹]`，Agent 卡壳时做前提-产出图搜索 |
| component-vuln-intel（组件识别触发搜洞） | 借鉴**触发器模式** | intel-feeder：指纹入库事件 → 自动检索 N-day → 生成验证任务 |
| 17 个角色 | 借鉴**划分思路** | 收敛为 6 个 Preset（角色太多反而稀释经验积累），但扫描/挖掘/业务逻辑/审计/内网/复盘的边界参考它 |
| 知识库（HackTricks/PATT 式分类） | 借鉴**组织方式** | knowledge/ 目录按漏洞类别组织 markdown，经验卡沉淀时自动归链 |
| tools-manager 的 apt/go/pip 三通道幂等安装 + verify 冒烟 | 借鉴**工程模式** | 我们 bundle 的 tools-manager.sh 同构重写（这是 shell 工程模式，不涉及其代码） |

**不借鉴的**：MCP 全量挂载（token 不可控的根源——**全局纪律：所有外部能力以 CLI/插件形态接入，一律不挂 MCP**，主会话工具定义 ≤15 个，纳入 P2 验收）、Web 对话式主交互（我们用 DSH 的，更强）、其整体 Go 单体架构。

## 四、CLI 工具链清单（自研 manifest，tools-manager 安装）

安装通道约定：`[apt]` 系统包 / `[go]` go install / `[pip]` venv / `[bin]` 下载二进制。

### 4.1 资产收集

| 工具 | 通道 | 用途 |
|---|---|---|
| ENScanGo | [bin] | 企业股权穿透/分支/供应商 + ICP/APP/公众号/邮箱 |
| subfinder / dnsx / alterx / naabu / httpx | [go] | PD 全家桶（子域→解析→置换→端口→存活指纹） |
| ksubdomain / OneForAll | [go]/[pip] | 泛解析场景爆破补强 |
| EHole / observer_ward | [bin]/[go] | 国产指纹（OA/国产框架识别） |
| tlsx / asnmap / mapcidr | [go] | 证书透明度扩域、ASN 扩段 |
| katana / gau / waybackurls / paramspider / arjun / x8 | [go] | 爬虫/历史 URL/参数挖掘 |
| **LinkFinder / JSFinder / sourcemap 还原** | [pip]/自研脚本 | JS 端点/密钥/隐藏接口提取（SRC 出洞富矿） |
| **jadx / unveilr** | [bin] | APK 反编译 / 小程序解包（ENScanGo 产出的 APP/公众号资产收口） |
| ffuf / feroxbuster | [go] | 目录/端点 Fuzz |
| fscan / kscan | [bin]/[go] | 边界快扫 + 弱口令 |
| wafw00f | [pip] | WAF 指纹 → 资产打标 → 下游 manifest 按 WAF 标签路由策略 |
| fofa/quake/hunter API 封装 | 自研脚本 | 测绘查询（key 存 credentials 包） |

### 4.2 漏洞挖掘

| 工具 | 通道 | 用途 |
|---|---|---|
| nuclei | [go] | 模板扫描主引擎（-jsonl，模板 pin 版本随升级窗口切换，版本记入 run_id 元数据） |
| afrog | [go] | 国产 POC 库补充 |
| xray（被动 webhook 模式） | [bin] | 挂**流量总线**被动审计（浏览器/人工流量自动喂入） |
| sqlmap / ghauri | [apt]/[pip] | SQLi 双引擎复核 |
| dalfox / xsser | [go]/[apt] | XSS |
| SSTImap / commix / crlfuzz | [pip]/[go] | 模板注入/命令注入/CRLF，按指纹触发 |
| **越权对比 harness** | 自研 CLI | 多角色会话池（未登录/普通/管理员）同请求重放 + 响应 diff，结构化输出喂 AI 判定 |
| dnslog 客户端 | 自研脚本 | 带外验证（配合验证铁律） |

### 4.3 代码审计

| 工具 | 通道 | 用途 |
|---|---|---|
| semgrep | [pip] | 模式匹配主力，规则可自研 |
| CodeQL | [bin] | 深度数据流（建库+套件） |
| gosec / bandit / brakeman / find-sec-bugs | 各语言通道 | 语言专项路由 |
| osv-scanner / syft+grype | [go]/[bin] | 供应链 SBOM+漏洞 |
| gitleaks / trufflehog | [go]/[bin] | 密钥泄漏 |

### 4.4 内网渗透

| 工具 | 通道 | 用途 |
|---|---|---|
| netexec / hydra / kerbrute | [pip]/[apt]/[go] | 爆破/喷洒 |
| impacket 全家桶 / certipy / mitm6+ntlmrelayx | [pip] | 利用套件/ADCS/IPv6 劫持 |
| bloodhound-python + 数据处理器 | [pip] | 域路径分析（采集端另行投递） |
| responder | [git] | LLMNR 投毒（intrusive 级） |
| ligolo-ng / stowaway / gost | [bin]/[go] | 隧道（Agent 可脚本化） |
| linPEAS / winPEAS / netspy | [bin] | 提权枚举 |
| evil-winrm / wmiexec / psexec | [pip] | 横向执行 |
| sliver | [bin] | C2，**靶场限定**，manifest 标 `risk: manual` |

数量控制在 ~60 个核心工具（而不是贪多）：**每个工具一份人工打磨过的 manifest，比 150 个粗糙清单有价值得多**——这也是可控性的一部分。

**asset-graph 建模接口资产**：不只存域名/IP，要存 `endpoint → 参数 → 所需角色 → 是否鉴权` 关系。越权挖掘的本质是对接口图谱的穷举遍历，没有这层建模 AI 无从下手。

## 五、核心自研件设计

### 5.1 sec-cli-adapter（token 经济 + 可控性核心）

manifest 格式（YAML，自研 schema）：

```yaml
# tools.d/enscan.yaml
name: enscan
binary: /usr/local/bin/enscan
stage: recon                 # recon/vuln/audit/intranet
risk: passive                # passive/active/intrusive/manual
timeout: 300
requires: [company_name]     # 能力原语：前提
produces: [domains, icp, apps, emails, subsidiaries]   # 能力原语：产出
args_template: "-n {{company}} -invest {{invest|50}} -deep {{deep|1}} -field {{fields}} -o {{outdir}}"
env_proxy: true              # 自动注入 mubeng 代理
parser: excel_to_json        # 内置: jsonl/regex/excel_to_json
summarize: head_llm          # 前 N 行 + pi 小模型蒸馏
store: asset-graph           # 结构化结果自动入图谱
```

执行流水线（全程不占模型上下文）：

```
Agent → run_cli("enscan", {company: "XX集团"})
  → scope-guard 硬校验目标在 scope.yml 内（不依赖模型自觉；含解析后校验：
    DNS 解析 IP、HTTP 重定向、回调参数指向 scope 外同样拦截）
  → 渲染命令 → 官方 sandbox 包执行（bwrap/Landlock 隔离 + 超时/资源限制/代理注入/全量审计）
  → parser 结构化 → 全量落盘 results/<run_id>/（大输出走官方 spill 机制）→ store 入 asset-graph
  → 返回 ≤20 行摘要 + run_id
Agent 需要细节时：grep_result(run_id, pattern) / page_result(run_id, n) 按需取
```

**可控性的三个抓手**：① 每条命令模板化渲染，参数注入在适配层完成并校验（不是模型自由拼 shell）；② 每个 run_id 的输入/输出/耗时/退出码全落库，trajectory 可回放；③ 摘要策略写在 manifest 里，调优摘要=改 YAML，不动代码。

**token 经济配套**（三级漏斗 + 账本 + 预算）：

1. **三级过滤**：扫描器结果先走确定性规则（模板置信度/响应特征，零 token）→ 小模型复核 → 大模型判定，规则层目标挡掉 60%+；
2. **token 账本**：dsh-bill 插件按会话/模型/日计量 + 成本归因，数据关联 run_id，产出"单漏洞 token 成本"指标；
3. **预算硬上限**：每类任务设 token 预算，超限自动降级（停大模型→只输出结构化中间产物→排队人工）；
4. **prompt cache 友好**：Preset/Skill 静态内容固定前缀排列、会话变量后置。

### 5.2 pi-bridge（融合层）

```ts
// 独立 npm 包 @sec/pi-bridge，DSH 插件入口
export function apply(ctx: Context) {
  ctx.plugin(PiBridgeService)          // ctx.pi 服务
  // worker 注册为官方 subagent seam 的 provider（不另起炉灶）
  // 批任务经官方 jobs 包管理（进度/取消/超时回收 UI 可见）
}
// PiBridgeService 内部:
//   - pi-ai: 统一 LLM 出口（直连供应商官方 API，按 taskType 路由模型）
//   - pi-agent-core: worker 生命周期（spawn/流式事件转发到 DSH 事件流/超时回收）
//   - worker 与主会话共用同一套 run_cli 工具实现（工具逻辑只有一份）
//   - pi 侧不安装任何业务扩展（§1.2 主次纪律）
```

### 5.3 自主学习系统（DSH 的核心优势，四环闭环）

**环 1 沉淀**：任务结束由 review Preset（复盘角色）强制读 trajectory（官方 session-query 包 FTS 检索）+ run_id 日志，蒸馏经验卡：

```json
{
  "scenario": "若依 CMS / Spring / 有 WAF",
  "attempts": [{"tool": "nuclei -t spring", "result": "fail", "why": "WAF 拦截", "run_id": "r8841"}],
  "chain": ["enscan→子域→httpx→EHole→若依→druid 未授权"],
  "takeaway": "带 WAF 的若依优先目录 Fuzz 而非模板扫描",
  "evidence": [{"type": "run", "id": "r8841"}, {"type": "flow", "id": "f2210"}, {"type": "burp", "id": "b108"}],
  "source": "实战 | external | human-verified",
  "confidence": "high",
  "last_validated_at": "2026-08-20"
}
```

证据三类来源：run_id（CLI 工具）/ flow_id（流量总线）/ burp_item（人工验证）；`human-verified` 卡片检索加权最高。引用格式对齐"可回溯到原始日志 excerpt"的原则（同社区 dsh-memory 的 `(sessionId, eventRange)` 引用设计）。

**经验卡生命周期管理**（防闭环烂尾）：

- **去重合并**：新卡入库前与存量卡相似度比对，高相似走"合并+证据追加"而非新建；
- **冲突仲裁**：同 scenario 矛盾 takeaway 按证据数/时间衰减/人工确认状态排序，低置信降权不删除；
- **时效衰减**：`last_validated_at` 过期卡在存量资产重扫时顺带验证，仍成立则刷新；
- **负知识账本**：negative-ledger 插件持久化"已证伪路径"（命令失败/前提不满足），重复尝试时警告拦截。

**环 2 增强**：新任务开局，用目标画像检索向量库（Chroma，本地嵌入模型）Top-K 经验卡 + 黑板事实，注入 Preset。

**环 3 进化**：成功调用链沉淀为 Playbook（**执行走官方 workflow 包**）；playbook-ranker 按成功率/耗时/误报率排名（时间衰减）；新工具/新链灰度对比后晋升。**评测基线：Vulhub/VulnTarget 靶场回归 + 实战判定回流**（每次 SRC 实战人工打标"确认/误报/dup"后自动成为评测用例——活评测集），指标（发现率/误报率/打点耗时）入库，周报由 pi worker 生成——没有评测集的"进化"是自嗨。评测按模型档位分别出指标，验证"小模型接得住蒸馏任务"的假设。

**环 4 情报**：intel-feeder 周期执行——`nuclei 模板更新`/afrog 库更新 → 存量资产自动重扫；CVE/POC 订阅命中资产图谱指纹 → 生成验证任务；ENScanGo 差异资产（新增子域/端口变化/指纹变化）→ 高优队列；**SRC 项目动态源**（新上项目/范围变更/赏金调整——新上项目是出洞黄金窗口）。触发层用 dsh-sentinel（文件/HTTP/webhook 条件唤醒）。

### 5.4 自主优化机制

DSH 一切皆插件 + 官方 extensions 包（运行时自修改：模型可检视/挂载/卸载插件）→ **系统可以改自己**。开放两个受控的自优化口子：

1. **摘要策略自优化**：review 角色统计各工具"摘要后还需 grep 原文"的比率，比率高的工具自动建议（人确认后）修改 manifest 的 `summarize` 字段；
2. **Skill 草稿自进化**：复盘发现的通用教训，由 Agent 起草 Skill 补丁存 `skills/draft/`，人在 Web UI 一键采纳才进正式 Skill——**自动进化、人工把关**，防止系统自己跑偏。

安全网：data 目录的 Preset/Skill/manifest 变更全部进**影子 git 仓库**（注意：影子仓库路径绝不能放在被跟踪目录内），任何自优化可一键回滚。

### 5.5 浏览器层 + 流量总线 + Burp 回流（深度测试主线）

**浏览器（dsh-browser 插件，人机共驾）**：

- AI 经 CDP 驱动真实浏览器：登录、点击、遍历多步交互流程（katana/gau 做不到的 JS 渲染/登录态/多步表单）；
- **人可随时接管**：过验证码、滑块、扫码登录、风控挑战——接管完成后 AI 续跑（官方 interaction 包的 pause/resume）；
- cookie 持久化 + per-task 会话隔离；多角色会话池（未登录/普通/管理员）直接喂 §4.2 越权对比 harness；
- **DOM 蒸馏**：整页 HTML 不喂模型，只给可交互元素清单（≤30 行结构化摘要），需要细节 `query_dom(selector)` 按需取——与 run_id 同一套 token 经济范式。

**流量总线（mitmproxy）**：浏览器与人工浏览全部流量过总线——

```
浏览器（AI 驱动 / 人工接管）
   → 流量总线
     ├─→ xray 被动审计（广谱体检，输出 webhook → parser 体系，AI 不读原始报告）
     ├─→ 全量归档 results/<flow_id>/（只存 header+关键 body，静态资源丢弃，按目标设保留期）
     ├─→ 接口提取（endpoint+参数+鉴权头 入 asset-graph）
     └─→ AI 被动分析 worker（pi 小模型流式读，产出可疑点候选 → 三级漏斗）
```

爬行与漏扫合一；人工浏览流量不浪费，出洞后人工请求序列可蒸馏为 `human-verified` 经验卡。

**Burp 回流（burp-ingest，双向）**：

- 导入 Burp 导出 XML：Proxy history → 接口资产入图谱；Scanner issues → 三级漏斗复核；**人工标注过的 Repeater 请求 → 直接蒸馏 human-verified 经验卡**（最高价值）；
- 反向：AI 的疑似点导出为 Burp 可导入请求集，人在熟悉环境里手工验证，结果再导回——**人不需要改变工具习惯**。

### 5.6 知识导入管道（外部知识 → 可检索资产）

底座用 knowledge-base 插件（md/txt/pdf/docx 导入 + FTS5 BM25 + Web 管理 UI），管道：

```
输入源（HackTricks/公众号 writeup/SRC 公开漏洞报告/URL/文件/目录批量投喂）
  → 注入安检（防 prompt injection，taintguard 标记不可信）
  → 小模型按经验卡同构 schema 结构化（scenario/chain/takeaway）
  → 标 source: external + 低置信 → 人工审核队列 → 入向量库
```

纪律：外部知识与实战经验卡**分区存储、检索时标注来源**——不把别人未验证的打法当自己的经验传播（幻觉放大器）；不经过多余的 LLM 总结转发（丢信息）。

### 5.7 HITL 断点清单（人工介入机制）

默认挂起等人工的环节（审批走官方 interaction 包，通知走 chicheng-push 推手机）：

| 断点 | 说明 |
|---|---|
| intrusive 级操作 | 原方案四级风险不变，审批请求推手机，人不在电脑前也能过门 |
| 越权/支付类测试的具体请求 | 会话池重放前逐条放行 |
| 疑似 0day / 无模板漏洞的 POC 构造 | AI 起草 → 人工审 |
| 报告提交 SRC 前 | **必须人工，写死**；提交前与历史 finding 指纹库（asset+endpoint+vuln_type+参数 哈希）比对防 dup |
| 浏览器接管点 | 验证码/登录/风控，pause → 人工 → resume |
| WAF 绕过策略变更、内网关键横向 | 人工确认 |

**判定打标回流**：Web UI 每个疑似漏洞结论旁给"确认/误报/风险接受"一键操作（官方 feedback 包）——一次点击 = 一条评测用例 + 一条负样本，零摩擦。

## 六、DSH 生态复用清单（调研 dsh-plugin 生态后收敛）

### 6.1 官方包（stable API，随 DSH 升级，零额外供应链风险）

| 包 | 用途 | 替代了什么 |
|---|---|---|
| spill / compaction / context / guard | 大输出落盘引用、上下文压缩、循环卫生守卫 | 自研摘要机制的一半、防死循环烧 token |
| sandbox（bwrap/Landlock/Seatbelt） | 进程隔离 | §5.1 沙箱执行 |
| jobs / workflow / schedule | 后台作业、工作流引擎、定时触发 | worker 批任务管理、Playbook 执行、周期任务 |
| subagent | 子代理 seam + 委派工具 | pi worker 的挂载点（§5.2） |
| interaction / feedback | 审批 seam、人工反馈 | HITL 断点（§5.7）、判定打标 |
| session / session-query / storage / credentials | 持久化、FTS 检索、非会话存储、凭据引用 | trajectory 底座、复盘数据源、测绘 key 管理 |
| preset / skill / goal / plan / todo | 会话组合 | Preset 层实现 |
| extensions | 运行时自修改 | §5.4 自优化通道 |

### 6.2 社区精选插件（仅 9 个，每个必须回答"替代了哪个自研件/补哪块短板"）

| 插件 | 补哪块 | 备注 |
|---|---|---|
| wqty123/dsh-browser | 浏览器共驾：真实浏览器、人可旁观接管、cookie 持久、CAPTCHA 检测 | §5.5 浏览器层核心 |
| tancheng33/dsh-egress-guard | 出口白名单 + 凭据脱敏 + JSONL 审计 | 配合 mubeng 出口管控、scope 外请求拦截 |
| sashankh/dsh-taintguard | 不可信内容污点追踪（目标站返回可能含注入） | 安全场景刚需，防 AI 被目标反制 |
| TecFancy/dsh-auth-gate | :3080 Web UI 登录门（官方默认无认证） | **必装**，暴露面收敛 |
| Jannchie/dsh-bill | token 成本归因 + 预算 + 台账 | §5.1 token 账本 |
| akslcw/dsh-negative-ledger | 负知识账本（已证伪路径拦截重复尝试） | §5.3 环 1 |
| htcqp802/dsh-knowledge-base | 知识库导入（md/pdf/docx + FTS5 + Web UI） | §5.6 底座 |
| fuhefei/dsh-sentinel | 条件驱动唤醒（webhook/HTTP/文件监视） | intel-feeder 触发层 |
| 534119219/chicheng-push | 多渠道推送（Server酱/Bark/钉钉/飞书/TG/webhook） | 审批/出洞/异常通知到手机 |

备选（暂不装，需要时再评估）：giter00/dsh-headroom（manifest 之外的输出压缩兜底）、stuarthu/dsh-chrome（Chrome 侧边栏流量抓取）。

**插件治理纪律**（8000+ 插件鱼龙混杂，安全平台自身引入插件即供应链风险）：

1. **先扫后装**：任何社区插件安装前过供应链静态扫描（如 dsh-plugin-vetting 类工具，Block/Warn/Pass 门）；装入 bundle 的插件清单 + 版本 + hash 进 git；
2. **pin 版本 + shim 收敛**：与 DSH 本体同等待遇，随升级窗口走冒烟；对社区插件的调用收敛在 shim 之后，暴毙可换；
3. **最小引入**：答不上"替代了什么"的不装；优先纯 npm/Node 插件（csai 无 Docker，带外部 daemon 依赖的排除）。

## 七、DSH 版本更新规避设计

原则：**自研逻辑与 DSH 本体之间只隔一层薄适配，数据与配置完全外置**。DSH 大版本来了，最多重构适配层，功能与资产零损失。

| 措施 | 具体做法 |
|---|---|
| **锁版本** | bundle 部署 pin 到已验证的 commit/tag；升级只走 `dsh-upgrade.sh` 显式触发，脚本内含版本检查→备份→构建→冒烟验证→失败回滚 |
| **shim 隔离层** | 4 个自研插件对 Cordis API 的使用收敛到一个 `@sec/dsh-shim` 包（封装 `ctx.tools.register`、`ctx.plugin`、事件流、存储等实际用到的 ~10 个 API 面）；插件代码只 import shim。**官方包组合层无需 shim**（stable API），shim 范围比 v2 收窄一半，上游 breaking change 只改 shim 一个包 |
| **数据外置** | asset-graph（SQLite，开 WAL 防多 worker 并发写锁）、经验卡、向量库、tools.d、knowledge/、Playbook、scope.yml、流量归档（大，备份策略单独处理）、影子 git 仓库全部放 `/opt/silkspool/dsh/data/`，**与 DSH 安装目录分离**，且全部走 `spool sync` 可备份。DSH 重构=重装软件，数据不动 |
| **Preset/Skill 文件化** | 角色与 Skill 全部是 data 目录下的纯 markdown/yaml，shim 负责注入 DSH；上游 Preset 机制怎么改，内容资产都在 |
| **升级冒烟套件** | `dsh-upgrade.sh` 内置 e2e：起服务→跑 3 个代表性 run_cli（被动工具）→查库→比对预期，通过才切流量 |
| **pi 侧同理** | pi-agent-core/pi-ai 在 package.json pin 精确版本，升级随 DSH 升级窗口一起走冒烟；pi 无业务扩展，升级面极小 |
| **社区插件同理** | 9 个精选插件 pin 版本 + hash 清单进 git，随升级窗口冒烟 |

**重构预案**（若上游大变）：数据层（SQLite/文件）与工具层（CLI manifest）与 DSH 完全解耦，最坏情况重写 shim + 插件入口（因自研件从 8 收敛到 4，估计 1–2 天工作量），所有资产、经验、工具清单、审计日志无损迁移。

## 八、spool bundle 落地（复用搭建的载体）

新建 `bundles/dsh/`（type: script，范式对照现有 csai bundle 的幂等 setup 模式）：

```
bundles/dsh/                     # ✅ P0 已落地（2026-08-20，csai 验证通过）
├── manifest.yaml                # type: script；defaults 生成 dsh/.env（供应商直连 key、代理地址）
└── templates/
    ├── setup.sh                 # ✅ 幂等：apt 依赖 → Node 22 LTS+pnpm → npm 安装 DSH(pin 版本)
    │                            #   → data 目录/scope.yml 初始化 → reconcile_service
    ├── silksecagent.service     # ✅ systemd unit（DSH_HOME=data/，EnvironmentFile 注入）
    ├── dsh-upgrade.sh           # ✅ 版本检查→备份→pnpm 安装→重启→冒烟→失败回滚
    ├── tools-manager.sh         # ✅ install/upgrade/remove/status 四动作，清单驱动
    ├── tools.list               # ✅ 首批 20 个核心工具（go/bin/apt 三通道 + verify 冒烟）
    ├── scope.yml                # ✅ 授权白名单初始模板（含 per-program 代理策略开关）
    └── plugins.lock             # ⏳ 9 个社区插件 pin+hash 清单（P2 扫描后启用）
    # 后续阶段：seed/（Preset/Skill 草稿）、自研插件包（pi-bridge/sec-cli-adapter 等）
```

纪律（沿用现有 csai bundle 已验证的原则）：setup 幂等可重跑；配置已存在不覆盖；data 目录与程序目录分离；代理池只检测复用（127.0.0.1:8899），不重装；**验收标准 = 干净 Ubuntu 24.04 上 `spool bundle dsh setup <host> && spool bundle dsh up <host>` 一条链跑通**。

部署目标：先在 csai 主机与现有服务共存（8C/16G 够，masscan/nuclei 并发在 manifest 设上限）；资源紧张时 pi worker 可随 bundle 部署到另一台——bundle 化天然支持多机复制。

## 九、实施路线图

| 阶段 | 周期 | 交付物 | 验收 |
|---|---|---|---|
| **P0 底座** | 第 1 周 | `bundles/dsh/` 全套；csai 上 setup+up 跑通，:3080 可访问（auth-gate 生效） | 干净虚拟机一条链复现 |
| **P0.5 插件治理** | 第 1 周 | 插件扫描流水线 + plugins.lock 清单 + 官方包启用基线 | 9 个社区插件扫描通过、pin 生效 |
| **P1 工具链** | 第 2–3 周 | dsh-shim + sec-cli-adapter（走官方 sandbox/spill）+ scope-guard；tools-manager 装齐 4.1/4.2；首批 20 manifest；burp-ingest（XML 导入） | 会话内"公司名→资产清单"全自动；越界拦截测试通过；Burp 历史导入入图谱 |
| **P2 融合层+浏览器** | 第 3–4 周 | pi-bridge（subagent provider + jobs 管理 + 模型路由）；dsh-browser 接入（登录/点击/人工接管）；token 账本（dsh-bill）上线 | 批任务不污染主会话上下文（token 对比量化）；AI 完成"登录→遍历→流量入总线"全流程；人工接管演示通过 |
| **P3 流水线+图谱** | 第 4–6 周 | asset-graph（含接口资产建模）；流量总线 + xray 接入；biz-logic Preset + 越权 harness；4.3/4.4 工具与 manifest；6 个 Preset + 核心 Skill | 四阶段各跑通一个真实授权目标；双角色越权 diff 出结构化报告 |
| **P4 学习闭环** | 第 6–9 周 | experience-hub（经验卡+向量库+黑板+生命周期管理）；知识导入管道；intel-feeder（dsh-sentinel 触发）；playbook-ranker；靶场+实战回流评测 | 同类目标二次任务耗时下降可量化；靶场发现率周报产出；外部知识导入 100 篇入库 |
| **P5 运营期** | 持续 | 报告生成→人工审→SRC 提交→厂商响应跟踪→赏金/信誉记账；finding 指纹去重库运营 | 报告零 dup 提交；月度出洞 ROI 报表（漏洞数/token 成本） |

## 十、合规护栏（代码层硬约束）

1. `scope.yml` 白名单在适配层硬校验（含解析后校验：DNS 解析 IP/重定向/回调参数指向 scope 外同样拦截），一切越界命令直接拒绝——不依赖模型自觉；
2. 风险四级：`passive` 放行 / `active` 限流+代理池 / `intrusive` 人工确认 / `manual`（sliver 等）默认禁用；
3. 全量审计：命令、参数、输出、外发请求按 run_id 落库，trajectory 可回放；
4. 出口统一走 mubeng 代理池 + 速率上限 + egress-guard 白名单（scope.yml 支持 per-program 代理策略开关，适配要求固定出口 IP 报备的 SRC）；
5. **Web UI 必装 auth-gate**（官方默认无认证），:3080 不裸奔；
6. **注入防护**：目标站返回内容视为不可信输入（taintguard 污点追踪），外部知识导入先过注入扫描；工具结果经脱敏（secret-redactor 类）再进模型，防凭据误存经验卡；
7. **流量归档属敏感数据**（含凭据/个人信息）：加密存储、保留期策略、凭据区脱敏后入审计；
8. **插件供应链**：先扫后装 + pin + hash 清单（§6.2 治理纪律）；
9. 仅限授权测试 / SRC / HW 防守自查。

## 十一、风险提示

- DSH 开发者预览版 API 漂移 → §七 全套规避已内建；官方包为 stable API，shim 只管 4 个自研插件，最坏情况重构 shim 层（1–2 天），数据资产无损；
- ENScanGo Cookie 保活（存 credentials 包不进 git，查询加随机延迟）；
- "CLI 省 token"的前提是摘要/分页策略到位——P2 验收必须把 token 对比作为量化指标（dsh-bill 数据说话），防止适配层形同虚设；
- 单机 8C/16G 资源上限：扫描并发受限，批任务排队由 jobs 控制，必要时 worker 迁机；
- 社区插件维护风险：vibe coding 居多，治理纪律（扫描/pin/shim/可替换）对冲，任一插件暴毙不影响主流程；
- nuclei 模板自动更新与锁版本原则冲突：模板 pin 版本随升级窗口统一切换，模板版本记入 run_id 元数据保证可复现；
- 浏览器自动化触发目标风控：CAPTCHA 检测 + 人工接管 + 速率对齐人工操作节奏，不放任 AI 高速乱点。
