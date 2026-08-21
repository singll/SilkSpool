# SilkSecAgent（DSH）安全审计报告

> 审计对象：`bundles/dsh`（SilkSecAgent）已部署实例（主机 csai）+ 方案文档 [dsh-pi-secagent-plan.md](dsh-pi-secagent-plan.md)
> 审计日期：2026-08-21　　审计方式：运行时实测（服务/端口/权限/认证）+ 核心自研插件源码通读 + rc.7 依赖盘点
> 结论定位：**系统已真实运行、数据真实、多数正向声明成立；主要风险在「文档声称的防护强度 > 代码实际强度」，且部分护栏依赖的能力 rc.7 已内置却未接入。**

---

## 0. 结论摘要（TL;DR）

- 认证、最小权限、token 经济、fail-closed 硬校验、资产/漏洞数据规模 —— 经实测**均成立**，不是纸面。
- 但方案 §十「代码层硬约束」10 条中，**至少 5 条（解析后校验 / 沙箱 / 出口白名单 / 注入防护 / 流量加密）在代码中不存在或未接入**。安全文档把未落地项写成「硬约束」，是本次审计判定的**最高层级问题**——它会让使用者高估防护面。
- 关键放大因素：rc.7 其实**自带** `dsh-sandbox` / `dsh-spill` / `dsh-session-query-sqlite` / `dsh-credentials` / `dsh-output-retention` 等底座。因此 S2（无沙箱）、S7（无保留期）不是"没有轮子"，而是"轮子在库里没装上车"——修复成本远低于文档暗示。
- 无严重可直接 RCE 的缺陷；参数注入面存在但受 argv（非 shell）约束，不可直接命令执行。

| 级别 | 数量 | 编号 |
|---|---|---|
| 🔴 高 | 2 | S1 解析后校验缺失、S2 run_cli 无沙箱 |
| 🟠 中 | 4 | S3 scope 依赖 manifest 声明无网络兜底、S4 参数注入、S5 .env 权限、S6 公网仅密码认证 |
| 🟡 低 | 3 | S7 流量明文无保留期、S8 无注入污点标记、S9 供应链仅静态扫描 |
| 🔵 运营 | 3 | 残留 failed 单元 / sentinel.lease / 审计无 rotation |

---

## 1. 审计范围与方法

**范围**：
- 自研插件：`dsh-plugin-sec-suite.js`（802 行，sec-cli-adapter + scope-guard + asset-graph 桥 + spawn_worker + authz_diff + burp_import）、`.asset-db.js`、`.experience.js`、`dsh-plugin-proxy-pool.js`；
- 部署脚本：`setup.sh`、`tools-manager.sh`、`dsh-upgrade.sh`、`manifest.yaml`、`plugins.lock`；
- 运行时：csai 上服务状态、端口、文件权限、认证行为、asset-graph.db 规模；
- 上游：rc.7 已安装的 `@deepseek-ai/dsh-*` 包全量清单。

**方法**：白盒源码审计（keystone 数据流手工追踪）+ 灰盒运行时验证（spool exec 实测）+ 文档-实现一致性比对（§十逐条）。

**不在范围**：DSH 上游本体代码安全性、LLM 供应商侧、mubeng/xray 二进制本身的 CVE。

---

## 2. 详细发现

### 🔴 S1　scope-guard 缺少方案声称的「解析后校验」

- **等级**：高
- **现象**：§5.1 与 §十#1 明写 scope 校验"含解析后校验：DNS 解析 IP、HTTP 重定向、回调参数指向 scope 外同样拦截"。实际 `checkTarget` 仅做**字面主机**的字符串/CIDR/后缀匹配。
- **证据**：
  - `bundles/dsh/templates/dsh-plugin-sec-suite.js:170` `hostOf()` —— 仅剥离 scheme/path/port 后小写，纯字面主机提取；
  - 同文件 `:212` `checkTarget()` —— 对 `hostOf` 结果做匹配，默认拒绝（fail-closed）；
  - 全文件 grep 无 `dns.lookup`/`dns.resolve`；`authz_diff` 用 `redirect: 'manual'`（`:542`）不跟随跳转。
- **影响**：授权域名 CNAME/解析到 scope 外 IP、302 跳转到 scope 外主机、SSRF 式回调参数，均**不被拦截**。对含生产资产的真实 SRC（scope 内已是 `*.meituan.com` 等），存在越界触达风险。
- **建议**：对 `active` 及以上风险的目标，执行前追加 DNS 解析后 IP 复核 + 关键跳转落点校验；或**将 §5.1/§十#1 承诺降级为实际能力**，不得让读者以为存在解析后防线。二者择一，不可维持现状。

### 🔴 S2　run_cli 未使用沙箱（rc.7 已内置沙箱能力却未接）

- **等级**：高
- **现象**：§5.1/§十#2/架构图均称工具经"官方 sandbox 包（bwrap/Landlock 隔离）"执行；`setup.sh:25` 也确实把 `bubblewrap` 装为 apt 依赖。实际 `run_cli` 是裸 `spawn`，**无任何沙箱包裹**。
- **证据**：
  - `bundles/dsh/templates/dsh-plugin-sec-suite.js:356` `child = spawn(binary, argv, { env, cwd: runDir })` —— 无 bwrap/Landlock；有超时（`:365`）、代理注入（`:347`），唯独无隔离；
  - `setup.sh:25` 安装 bubblewrap 但 `run_cli` 从不调用它；
  - **rc.7 明确存在沙箱能力**：`dsh-sandbox` / `dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-bash-sandbox` / `dsh-fs-sandbox`（依赖盘点确认）——即"有轮子未装上车"。
- **影响**：26 个攻击工具全部以 `silkspool` 完整权限、完整文件系统可见性运行。叠加 S4（参数注入）与本机代码审计工具（semgrep/codeql 可被指向 `/opt/silkspool/dsh/.env` 等敏感文件），缺乏第二层遏制。
- **建议**：`run_cli` 执行路径接 `dsh-sandbox` 或直接 `bwrap`（只读挂 bin、绑定 runDir 可写、`--unshare-*`、资源限制），至少对 `active/intrusive` 强制。修复成本因 rc.7 已有底座而显著降低。

### 🟠 S3　scope 强制完全依赖 manifest 的 `target_param`，无网络层兜底

- **等级**：中
- **现象**：scope 只对 `extractTargets` 能取到的目标校验；`extractTargets` 依赖 `manifest.target_param`。无 `target_param` 的 manifest → 目标集为空 → 校验循环空转 → 命令直接放行。
- **证据**：
  - `bundles/dsh/templates/dsh-plugin-sec-suite.js:288-289` `extractTargets()`：`const tp = manifest.target_param`，缺失即返回 `[]`；
  - `runCli`（`:309`）仅对 `extractTargets` 结果逐个 `checkTarget`。
- **现状不是活漏洞**：当前 5 个无 `target_param` 的 manifest（semgrep/codeql/gitleaks/osv-scanner/trufflehog）全是**本机代码扫描器、passive、不打网络目标**，合理；18 个网络工具都声明了 `target_param`。
- **风险**：结构脆弱——将来新增网络 manifest 漏写 `target_param`、或工具目标走了非 `target_param` 参数/配置文件，即**静默绕过 scope**；而方案 §十#4 声称的网络层白名单兜底 `egress-guard` **未安装**（见 plugins.lock），没有第二道防线。
- **建议**：`runCli` 增守卫——"manifest 无 `target_param` 且 `risk≥active` → 拒绝或强制人工放行"；并将 `egress-guard`（或等价出口白名单）真正接上，同时兜住 S1/S3。

### 🟠 S4　参数注入（非 RCE，但可注入危险 flag）

- **等级**：中
- **现象**：参数先插入模板字符串，再切分为 argv。因无 `shell:true`，**不构成命令注入 RCE**；但参数值含空白会分裂出额外 argv token，向 nuclei/sqlmap/ffuf 等注入危险 flag（写文件、`--os-shell`、加载任意模板等）。
- **证据**：
  - `bundles/dsh/templates/dsh-plugin-sec-suite.js:263` `renderTemplate()` 先插值；
  - 同文件 `:276` `shellSplit()` 再切分为 argv → `spawn`（`:356`）。
- **影响**：目标/LLM 派生的不可信参数可改变工具行为（超出预期的文件写入、交互式利用开关等）。
- **建议**：对标量参数做类型校验（禁止空白/元字符），或在 manifest 显式声明"多 token"参数白名单；不可信参数与命令结构隔离。

### 🟠 S5　`.env` 全局可读（644）

- **等级**：中
- **现象**：`/opt/silkspool/dsh/.env`（含 `DEEPSEEK_API_KEY`、`OPENCODE_GO_API_KEY`）权限 `-rw-r--r--`（644）；而 `settings.yaml` 已是 600，不一致。
- **证据**：运行时 `ls -l` 实测；`manifest.yaml` defaults 生成 `dsh/.env` 未设权限。
- **影响**：主机上任意本地用户可读明文密钥。systemd 以 root 读 `EnvironmentFile`，600 完全够用。
- **建议**：`chmod 600 .env`，并在 `manifest.yaml`/`setup.sh` 固化 600（否则 re-setup 退回 644）。**分钟级修复。**

### 🟠 S6　公网暴露 + 仅密码认证，无锁定/MFA

- **等级**：中
- **现象**：`auth-gate` 为 `mode: password` 单 admin，未见失败锁定/限速/MFA；服务经 istoreos Caddy 暴露于 `https://silksecagent.singll.net`。
- **证据**：`cordis.patch.yml` auth-gate 配置；plan §auth-gate 段落记录公网上线。
- **影响**：一个握有 26 个攻击工具 + 代理池 + 真实 SRC scope 的平台，公网入口仅一层可爆破口令。
- **建议**：优先挪到已有的 txhk/Authelia forward-auth（MFA）之后；受自建域名约束时，至少在 Caddy 层加 IP 白名单 / fail2ban / 速率限制。

### 🟡 S7　流量/结果明文留存，无保留期与加密（rc.7 已有 output-retention 可用）

- **等级**：低（数据敏感度高，但为本地留存）
- **现象**：`results/`、`flows/` 明文落盘，无 rotation/retention/加密。§十#7 明写"流量归档加密存储、保留期策略、脱敏"。
- **证据**：运行时目录实测；rc.7 存在 `dsh-output-retention` / `dsh-spill-policy` 包但未见接入 flows/results。
- **影响**：真实 SRC 流量含凭据/PII，长期明文堆积扩大数据泄露面。
- **建议**：接 `dsh-output-retention` 做保留期清理 + 敏感区脱敏；或降级 §十#7 承诺。

### 🟡 S8　注入防护（taintguard）声称硬约束却未装

- **等级**：低
- **现象**：§十#6 把"目标返回内容 taintguard 污点追踪"列为**代码层硬约束**，但 `taintguard` 在 plugins.lock 仍为 PENDING。
- **证据**：`plugins.lock` 待评估段；目标站响应经浏览器/流量总线/kb_import 流入 LLM，无污点标记。
- **影响**：目标可控内容进入模型上下文，存在提示注入反制风险（安全平台尤其刚需）。
- **建议**：接 `taintguard` 或等价污点标记；kb_import 外部知识入库前过注入扫描（§5.6 已设计，需落地）。

### 🟡 S9　供应链治理仅静态扫描，无运行时约束

- **等级**：低
- **现象**：plugins.lock 记录"先扫后装 + hash"，但社区插件装入后无运行时出口/权限沙箱约束（§十#8 只覆盖安装期）。
- **证据**：`plugins.lock` 仅 hash + 静态 verdict；无运行时 egress 限制（egress-guard 未装）。
- **影响**：任一已装插件（auth-gate/model-failover/dsh-browser/dsh-bill）若后续版本引入外联，静态扫描无法在运行期拦截。
- **建议**：egress-guard 落地后将插件外联纳入白名单审计；升级窗口复扫 hash（已有纪律，需执行）。

### 🔵 运营卫生（低危，顺手清理）

- `systemctl --failed` 残留 `cyberstrikeai.service`（CyberStrikeAI 已退役）→ `systemctl reset-failed cyberstrikeai.service`；
- `data/sentinel.lease` 残留（dsh-sentinel 已移除）→ 清理；
- `audit.jsonl` / `results/` / `flows/` 无 rotation → 接 logrotate 或 output-retention。

---

## 3. 方案 §十「合规护栏」落地对照

| # | 护栏声称 | 实际状态 | 证据 |
|---|---|---|---|
| 1 | scope 白名单硬校验（含解析后校验） | ⚠️ 字面校验✅ / 解析后校验❌ | S1 |
| 2 | 风险四级（passive/active/intrusive/manual） | ✅ 已实现 | scope-guard 四级 |
| 2 | sandbox（bwrap/Landlock）隔离执行 | ❌ 未接（rc.7 有能力） | S2 |
| 3 | 全量审计（run_id 落库、可回放） | ✅ 已实现 | audit.jsonl |
| 4 | 出口统一 mubeng + egress-guard 白名单 | ⚠️ mubeng✅ / egress-guard❌ | S3 |
| 5 | Web UI 必装 auth-gate | ✅ 已实现（但见 S6） | 401 实测 |
| 6 | 注入防护（taintguard 污点追踪） | ❌ 未装 | S8 |
| 7 | 流量归档加密 + 保留期 + 脱敏 | ❌ 未落地（rc.7 有 output-retention） | S7 |
| 8 | 插件供应链先扫后装 + pin + hash | ⚠️ 安装期✅ / 运行期❌ | S9 |
| 9 | 仅限授权测试 / SRC / HW | ✅ scope fail-closed 支撑 | — |

**判定**：10 条中 4 条完整落地，2 条部分落地，4 条未落地。**§十标题「代码层硬约束」名不副实，须逐条标注真实状态（✅已落地 / ⏳规划中 / ❌未接）**。

---

## 4. 值得肯定的实现（经实测成立）

- **认证生效**：环回 :3080 与公网域名对无 cookie 请求均 401；
- **最小权限**：DSH 以非 root（silkspool）运行，`settings.yaml` 权限 600、零明文密钥（`apiKeyEnv` 引用 .env）；
- **fail-closed 真实存在**：`checkTarget`（`:212`）默认拒绝 + 排除清单 + CIDR + 后缀 + 逐目标审计；
- **authz_diff 正确纳入 scope 校验**：`dsh-plugin-sec-suite.js:519-525` 执行前 `checkTarget(url)` + 硬 deny 门，`redirect:'manual'` 不越界跟随——**是本套件里 scope 纪律的正面样板**；
- **token 经济真落地**：全量落盘 + `≤20 行摘要`（`:393`）+ grep/page 按需取；subfinder 实测 137k tokens → 120 tokens；
- **argv 而非 shell**：`spawn` 用参数数组，无 shell 注入 RCE 面；
- **数据规模真实**：asset-graph.db（assets/endpoints/findings/blackboard 四表 + WAL）已承载 692 资产 / 279 接口 / 57 finding / 969 黑板事实；
- **finding 状态机 + 报告**：`.asset-db.js:164-210` 已实现 new→confirmed→submitted→accepted/dup/ignored 流转 + markdown 报告落盘。

---

## 5. 修复优先级

**立即（分钟级，纯收益）**
1. `chmod 600 .env` 并在 bundle 固化（S5）；
2. `reset-failed cyberstrikeai.service` + 清 `sentinel.lease`（运营）；
3. 文档 §十 逐条标注真实状态，先堵"误判防护面"（对照表）。

**短期（小时级，堵结构性缺口）**
4. `runCli` 增守卫：无 `target_param` 且 `risk≥active` → 拒绝/强制人工（S3）；
5. 标量参数类型校验，隔离参数与命令结构（S4）；
6. `dsh-upgrade.sh` 冒烟从 liveness 升级为"passive run_cli + 一条越界 deny 断言 + DB count"。

**中期（工程投入，补齐核心承诺）**
7. `run_cli` 接 `dsh-sandbox`/bwrap 隔离（S2，rc.7 有底座）；
8. 接 `egress-guard`（网络层白名单，兜住 S1/S3）+ `taintguard`（S8）；
9. scope-guard 补 DNS/重定向后置校验（S1）；
10. auth-gate 挪到 Authelia forward-auth / 加 Caddy 层防护（S6）；
11. flows/results 接 `dsh-output-retention` 保留期 + 脱敏（S7）。

---

## 附录　审计证据索引

| 主题 | 位置 |
|---|---|
| 字面主机提取（无解析） | `dsh-plugin-sec-suite.js:170` |
| scope fail-closed 校验 | `dsh-plugin-sec-suite.js:212` |
| 参数插值 → argv 切分 | `dsh-plugin-sec-suite.js:263,276` |
| target_param 依赖 | `dsh-plugin-sec-suite.js:288` |
| 裸 spawn（无沙箱） | `dsh-plugin-sec-suite.js:356` |
| 超时/代理注入 | `dsh-plugin-sec-suite.js:347,365` |
| ≤20 行摘要 | `dsh-plugin-sec-suite.js:393` |
| authz_diff scope 门（正面） | `dsh-plugin-sec-suite.js:519-525,542` |
| spawn_worker 用 DSH headless | `dsh-plugin-sec-suite.js:634,652` |
| bubblewrap 装而未用 | `setup.sh:25` |
| 升级冒烟仅 liveness | `dsh-upgrade.sh:100` |
| rc.7 沙箱/保留期能力存在 | `node_modules/.pnpm` 盘点：dsh-sandbox*、dsh-output-retention |
| 社区插件锁 | `plugins.lock` |

---

*本报告仅覆盖授权范围内的自有系统审计，用于内部加固。*
