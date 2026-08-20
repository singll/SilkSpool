# 基于 DSH + pi 的 AI 网络安全辅助平台方案 v2

> 基础事实：2026-08-20 已用 spool 实测 csai 主机（Ubuntu 24.04 / 8C / 16G / 余 939G / **无 Docker 无 Node**），并核实 DSH、pi 上游仓库。
>
> - DSH：https://github.com/deepseek-ai/deepseek-harness （Cordis "一切皆插件" 架构，`npx @deepseek-ai/dsh web` 起 Web UI :3080，开发者预览版，MIT）
> - pi：https://github.com/earendil-works/pi （`pi-agent-core` agent 运行时 / `pi-ai` 统一 LLM API / `pi-coding-agent` CLI，官方明示无内置权限系统，MIT）
> - CyberStrikeAI：https://github.com/Ed1s0nZ/CyberStrikeAI （仅作设计借鉴，不部署、不照搬、不依赖）

## 一、为什么是"DSH 为主体 + pi 融合"，以及怎么融合

### 1.1 两者互补点（实测核实后的精确分工）

| | DSH | pi |
|---|---|---|
| 本质 | **Agent Harness**（宿主）：Web UI、会话管理、调度、持久化、插件生态 | **Agent 工具库**：`pi-agent-core`（agent 运行时）、`pi-ai`（统一 LLM API）、`pi-coding-agent`（CLI） |
| 强 | 一切皆插件（Cordis）、跨会话状态、事件流/trajectory（**自主学习的抓手**）、人机交互界面 | 无头 agent 循环、多 provider 模型路由、可编译独立二进制、极轻 |
| 弱 | 批处理/无头执行不是主场景 | 无 UI、无调度、**官方明示无权限系统** |

关键事实：**两者都是 TypeScript/Node 生态，pi 的三个核心包都是 npm 库**。这决定了融合方式不是"两个进程互相调 API"，而是——

### 1.2 融合方式：pi 作为库嵌入 DSH 插件（同进程）

```
DSH 宿主（主进程，:3080 Web UI）
 └─ Cordis 插件: pi-bridge（本方案自研，npm 依赖 pi-agent-core + pi-ai）
     ├─ 注册 DSH Service: ctx.pi
     │    ├─ ctx.pi.spawn(preset, task)   → 起一个无头 pi agent 循环（子任务执行体）
     │    └─ ctx.pi.route(taskType)       → pi-ai 按任务类型选模型（蒸馏用小模型/判定用大模型）
     ├─ DSH 主会话 Agent 持有工具 spawn_worker → 把"跑 50 个 URL 的 nuclei 复扫"这类
     │   脏活派给 pi worker，worker 跑完只回结论，主会话上下文不被污染
     └─ scheduler 插件的周期任务（复扫/情报验证/复盘蒸馏）全部经 ctx.pi 派发
```

这样的融合收益：

1. **主会话上下文保护**：批任务的成千上万行工具输出只经过 pi worker 的上下文，蒸馏后才回主会话——这是解决"token 消耗不可控"的结构性方案；
2. **模型分层**：pi-ai 做统一路由，侦察摘要/日志蒸馏走便宜小模型，漏洞判定/报告/复盘走大模型，一处配置全局生效；
3. **单进程单日志**：worker 的 trajectory 也落 DSH 事件流，经验采集无死角；
4. **无 IPC 脆弱面**：同进程库调用，不存在两个服务间的超时/鉴权/版本对齐问题。

另外保留 `pi-coding-agent` CLI 作为**人的入口**：工程师用它写/调试 Playbook 和工具 manifest（它是现成的、自带文件操作能力的终端 agent，不用自己造）。

## 二、总体架构

```
┌──────────────────────── csai 主机（无 Docker，全原生 systemd）────────────────────────┐
│                                                                                      │
│  ┌─ DSH 宿主（dsh.service, :3080）─────────────────────────────────────────────┐     │
│  │                                                                              │     │
│  │  ┌─ 官方/社区插件层 ────────────────────────────────────────────────────┐   │     │
│  │  │  Web UI · 会话/调度 · trajectory 事件流                                │   │     │
│  │  └──────────────────────────────────────────────────────────────────────┘   │     │
│  │                                                                              │     │
│  │  ┌─ 自研插件层（本方案核心，全部为独立 npm 包，dsh-plugin）───────────────┐   │     │
│  │  │  pi-bridge        pi 融合层（worker 池 + 模型路由）                     │   │     │
│  │  │  sec-cli-adapter  CLI 工具适配（清单驱动，token 经济核心）              │   │     │
│  │  │  asset-graph      资产图谱（SQLite：资产/指纹/凭据/关系边）             │   │     │
│  │  │  experience-hub   经验中枢（经验卡 + 向量库 + 事实黑板）                │   │     │
│  │  │  intel-feeder     CVE/POC/模板情报订阅 → 命中生成任务                   │   │     │
│  │  │  scope-guard      授权白名单硬校验 + 风险分级审批 + 全量审计            │   │     │
│  │  │  playbook-ranker  调用链沉淀/排名/灰度晋升                              │   │     │
│  │  └──────────────────────────────────────────────────────────────────────┘   │     │
│  │                                                                              │     │
│  │  ┌─ Agent Preset 层（每会话）───────────────────────────────────────────┐   │     │
│  │  │  角色：recon / vuln-hunt / code-audit / intranet / review（复盘）       │   │     │
│  │  │  Skills：验证铁律 · 黑板纪律 · 原语凑链 · 输出规范 · 复盘沉淀           │   │     │
│  │  │  工具：run_cli / spawn_worker / query_asset / search_exp / store_exp   │   │     │
│  │  └──────────────────────────────────────────────────────────────────────┘   │     │
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
│ aigateway（现有）  │  New API 多模型网关，密钥一处管理
└──────────────────┘
```

**核心原则**：工具调用只有一条路——`sec-cli-adapter` → 本机 CLI。所有可控性（参数、输出、摘要、落盘、审计）都在我们自己的适配层里，每一行进出模型的内容都可审计、可优化。

## 三、从 CyberStrikeAI 借鉴什么（只借鉴设计，不照搬实现）

| 其设计 | 借鉴方式 | 我们的实现 |
|---|---|---|
| YAML 工具配方（~90 个工具的参数/用法结构） | 借鉴**格式思路**，字段重设计 | 我们的 manifest 增加 `stage/risk/summarize/store/parser` 字段（§五），内容按我们工具链自己写 |
| pentest-verification（验证铁律） | 借鉴**纪律** | Skill：`任何漏洞结论必须附 run_id + 原始输出路径，否则视为幻觉打回` |
| pentest-blackboard（黑板） | 借鉴**机制** | experience-hub 内的事实黑板表：凭据/存活主机/已试路径，跨会话共享 |
| capability-primitive-search（能力原语凑链） | 借鉴**算法思路** | 每个 manifest 声明 `requires: [活着的web资产]` / `produces: [指纹]`，Agent 卡壳时做前提-产出图搜索 |
| component-vuln-intel（组件识别触发搜洞） | 借鉴**触发器模式** | intel-feeder：指纹入库事件 → 自动检索 N-day → 生成验证任务 |
| 17 个角色 | 借鉴**划分思路** | 收敛为 5 个 Preset（角色太多反而稀释经验积累），但扫描/挖掘/审计/内网/复盘的边界参考它 |
| 知识库（HackTricks/PATT 式分类） | 借鉴**组织方式** | knowledge/ 目录按漏洞类别组织 markdown，经验卡沉淀时自动归链 |
| tools-manager 的 apt/go/pip 三通道幂等安装 + verify 冒烟 | 借鉴**工程模式** | 我们 bundle 的 tools-manager.sh 同构重写（这是 shell 工程模式，不涉及其代码） |

**不借鉴的**：MCP 全量挂载（token 不可控的根源）、Web 对话式主交互（我们用 DSH 的，更强）、其整体 Go 单体架构。

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
| ffuf / feroxbuster | [go] | 目录/端点 Fuzz |
| fscan / kscan | [bin]/[go] | 边界快扫 + 弱口令 |
| fofa/quake/hunter API 封装 | 自研脚本 | 测绘查询（key 存 .env） |

### 4.2 漏洞挖掘

| 工具 | 通道 | 用途 |
|---|---|---|
| nuclei | [go] | 模板扫描主引擎（-jsonl，模板自动更新） |
| afrog | [go] | 国产 POC 库补充 |
| xray（被动 webhook 模式） | [bin] | 挂 katana 流量被动审计 |
| sqlmap / ghauri | [apt]/[pip] | SQLi 双引擎复核 |
| dalfox / xsser | [go]/[apt] | XSS |
| SSTImap / commix / crlfuzz | [pip]/[go] | 模板注入/命令注入/CRLF，按指纹触发 |
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
  → scope-guard 硬校验目标在 scope.yml 内（不依赖模型自觉）
  → 渲染命令 → 沙箱执行（超时/资源限制/代理注入/全量审计日志）
  → parser 结构化 → 全量落盘 results/<run_id>/ → store 入 asset-graph
  → 返回 ≤20 行摘要 + run_id
Agent 需要细节时：grep_result(run_id, pattern) / page_result(run_id, n) 按需取
```

**可控性的三个抓手**：① 每条命令模板化渲染，参数注入在适配层完成并校验（不是模型自由拼 shell）；② 每个 run_id 的输入/输出/耗时/退出码全落库，trajectory 可回放；③ 摘要策略写在 manifest 里，调优摘要=改 YAML，不动代码。

### 5.2 pi-bridge（融合层）

```ts
// 独立 npm 包 @sec/pi-bridge，DSH 插件入口
export function apply(ctx: Context) {
  ctx.plugin(PiBridgeService)          // ctx.pi 服务
  ctx.tools.register('spawn_worker', …) // 主会话派批任务
}
// PiBridgeService 内部:
//   - pi-ai: 统一 LLM 出口（base_url 指向 aigateway，按 taskType 路由模型）
//   - pi-agent-core: worker 生命周期（spawn/流式事件转发到 DSH 事件流/超时回收）
//   - worker 与主会话共用同一套 run_cli 工具实现（工具逻辑只有一份）
```

### 5.3 自主学习系统（DSH 的核心优势，四环闭环）

**环 1 沉淀**：任务结束由 review Preset（复盘角色）强制读 trajectory + run_id 日志，蒸馏经验卡：

```json
{
  "scenario": "若依 CMS / Spring / 有 WAF",
  "attempts": [{"tool": "nuclei -t spring", "result": "fail", "why": "WAF 拦截", "run_id": "r8841"}],
  "chain": ["enscan→子域→httpx→EHole→若依→druid 未授权"],
  "takeaway": "带 WAF 的若依优先目录 Fuzz 而非模板扫描",
  "evidence": ["r8841", "r8842"]
}
```

**环 2 增强**：新任务开局，用目标画像检索向量库（Chroma，本地嵌入模型）Top-K 经验卡 + 黑板事实，注入 Preset。

**环 3 进化**：成功调用链沉淀为 Playbook；playbook-ranker 按成功率/耗时/误报率排名（时间衰减）；新工具/新链灰度对比后晋升。**评测基线：Vulhub/VulnTarget 靶场回归，指标（发现率/误报率/打点耗时）入库，周报由 pi worker 生成**——没有评测集的"进化"是自嗨。

**环 4 情报**：intel-feeder 周期执行——`nuclei -ut`/afrog 库更新 → 存量资产自动重扫；CVE/POC 订阅命中资产图谱指纹 → 生成验证任务；ENScanGo 差异资产（新增子域/端口变化/指纹变化）→ 高优队列。

### 5.4 自主优化机制

DSH 一切皆插件 → **系统可以改自己**。开放两个受控的自优化口子：

1. **摘要策略自优化**：review 角色统计各工具"摘要后还需 grep 原文"的比率，比率高的工具自动建议（人确认后）修改 manifest 的 `summarize` 字段；
2. **Skill 草稿自进化**：复盘发现的通用教训，由 Agent 起草 Skill 补丁存 `skills/draft/`，人在 Web UI 一键采纳才进正式 Skill——**自动进化、人工把关**，防止系统自己跑偏。

## 六、DSH 版本更新规避设计

原则：**自研逻辑与 DSH 本体之间只隔一层薄适配，数据与配置完全外置**。DSH 大版本来了，最多重构适配层，功能与资产零损失。

| 措施 | 具体做法 |
|---|---|
| **锁版本** | bundle 部署 pin 到已验证的 commit/tag；升级只走 `dsh-upgrade.sh` 显式触发，脚本内含版本检查→备份→构建→冒烟验证→失败回滚 |
| **shim 隔离层** | 所有自研插件对 Cordis API 的使用收敛到一个 `@sec/dsh-shim` 包（封装 `ctx.tools.register`、`ctx.plugin`、事件流、存储等我们实际用到的 ~10 个 API 面）；插件代码只 import shim。上游 breaking change 只改 shim 一个包 |
| **数据外置** | asset-graph（SQLite）、经验卡、向量库、tools.d、knowledge/、Playbook、scope.yml 全部放 `/opt/silkspool/dsh/data/`，**与 DSH 安装目录分离**，且全部走 `spool sync` 可备份。DSH 重构=重装软件，数据不动 |
| **Preset/Skill 文件化** | 角色与 Skill 全部是 data 目录下的纯 markdown/yaml，shim 负责注入 DSH；上游 Preset 机制怎么改，内容资产都在 |
| **升级冒烟套件** | `dsh-upgrade.sh` 内置 e2e：起服务→跑 3 个代表性 run_cli（被动工具）→查库→比对预期，通过才切流量 |
| **pi 侧同理** | pi-agent-core/pi-ai 在 package.json pin 精确版本，升级随 DSH 升级窗口一起走冒烟 |

**重构预案**（若上游大变）：数据层（SQLite/文件）与工具层（CLI manifest）与 DSH 完全解耦，最坏情况重写 shim + 插件入口（估计 2–3 天工作量），所有资产、经验、工具清单、审计日志无损迁移。

## 七、spool bundle 落地（复用搭建的载体）

新建 `bundles/dsh/`（type: script，范式对照现有 csai bundle 的幂等 setup 模式）：

```
bundles/dsh/
├── manifest.yaml              # type: script；.env 注入 aigateway 端点/key、代理地址
└── templates/
    ├── setup.sh               # 幂等：apt 依赖 → Node LTS+pnpm → clone DSH(锁版本) → pnpm build
    │                          #   → npm 安装自研插件包 → 生成 dsh.yaml → reconcile_service
    ├── dsh.service            # systemd unit（EnvironmentFile 注入代理/网关配置）
    ├── dsh-upgrade.sh         # 锁版本升级 + 冒烟 + 回滚（含 e2e 套件）
    ├── tools-manager.sh       # apt/go/pip/bin 四通道幂等安装 §四 工具 + verify 冒烟
    ├── sync-manifests.sh      # tools.d 清单 lint/校验
    ├── scope.yml              # 授权白名单初始模板
    └── seed/                  # 首批 ~20 个核心工具 manifest + 5 个 Preset + 6 个 Skill 草稿
```

纪律（沿用现有 csai bundle 已验证的原则）：setup 幂等可重跑；配置已存在不覆盖；data 目录与程序目录分离；代理池只检测复用（127.0.0.1:8899），不重装；**验收标准 = 干净 Ubuntu 24.04 上 `spool bundle dsh setup <host> && spool bundle dsh up <host>` 一条链跑通**。

部署目标：先在 csai 主机与现有服务共存（8C/16G 够，masscan/nuclei 并发在 manifest 设上限）；资源紧张时 pi worker 可随 bundle 部署到另一台——bundle 化天然支持多机复制。

## 八、实施路线图

| 阶段 | 周期 | 交付物 | 验收 |
|---|---|---|---|
| **P0 底座** | 第 1 周 | `bundles/dsh/` 全套；csai 上 setup+up 跑通，:3080 可访问 | 干净虚拟机一条链复现 |
| **P1 工具链** | 第 2–3 周 | dsh-shim + sec-cli-adapter + scope-guard；tools-manager 装齐 4.1/4.2；首批 20 manifest | 会话内"公司名→资产清单"全自动；越界拦截测试通过 |
| **P2 融合层** | 第 3–4 周 | pi-bridge（worker 池 + 模型路由）；scheduler 周期任务走 pi | 批任务不污染主会话上下文（token 对比量化） |
| **P3 流水线+图谱** | 第 4–5 周 | asset-graph；4.3/4.4 工具与 manifest；5 个 Preset + 核心 Skill（验证铁律等） | 四阶段各跑通一个真实授权目标 |
| **P4 学习闭环** | 第 6–8 周 | experience-hub（经验卡+向量库+黑板）；intel-feeder；playbook-ranker；靶场回归评测 | 同类目标二次任务耗时下降可量化；靶场发现率周报产出 |

## 九、合规护栏（代码层硬约束）

1. `scope.yml` 白名单在适配层硬校验，一切越界命令直接拒绝——不依赖模型自觉；
2. 风险四级：`passive` 放行 / `active` 限流+代理池 / `intrusive` 人工确认 / `manual`（sliver 等）默认禁用；
3. 全量审计：命令、参数、输出、外发请求按 run_id 落库，trajectory 可回放；
4. 出口统一走 mubeng 代理池 + 速率上限；
5. 仅限授权测试 / SRC / HW 防守自查。

## 十、风险提示

- DSH 开发者预览版 API 漂移 → §六 全套规避已内建，最坏情况重构 shim 层（2–3 天），数据资产无损；
- ENScanGo Cookie 保活（存 .env 不进 git，查询加随机延迟）；
- "CLI 省 token"的前提是摘要/分页策略到位——P1 验收必须把 token 对比作为量化指标，防止适配层形同虚设；
- 单机 8C/16G 资源上限：扫描并发受限，批任务排队由 scheduler 控制，必要时 worker 迁机。
