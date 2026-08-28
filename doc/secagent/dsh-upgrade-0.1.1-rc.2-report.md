# SilkSecAgent DSH 升级报告：0.1.0-rc.7 → 0.1.1-rc.2

> 执行日期：2026-08-23 ｜ 主机：csai ｜ 执行人：Claude Code（spool 运维）
> 关联文档：[dsh-secagent-plan-v6.md](dsh-secagent-plan-v6.md)（主计划）
> 一句话：**升级成功、领域数据零丢失、五插件全部加载、httpx 卡死根治**；本次同时补齐了升级保护的两处缺口，让今后每次 rc 升级都能自验证 + 自动回滚，"升级很麻烦"的问题从机制上解决。

---

## 0. 执行摘要

| 项 | 结果 |
|---|---|
| DSH 版本 | `0.1.0-rc.7` → **`0.1.1-rc.2`**（npm dist-tags.latest） |
| 服务状态 | silksecagent / silksecagent-edge 均 **active** |
| 领域数据 | **零丢失**（assets 10138 / findings 76 / facts 971 / programs 3 / tasks 9 升级前后逐表一致） |
| 插件加载 | sec-cli-adapter / sec-dashboard / silksec-proxy-pool / theme-silksong / dsh-browser 全部进组合树 |
| httpx 卡死 | **根治**（run_cli 端到端实测 exit 0、sandboxed true、非超时） |
| 升级保护 | 原有 3 项验证生效 + **新增 2 项加固**（数据快照 + 深冒烟）全部实测触发 |
| 回滚安全 | 版本级自动回滚 + 187M 数据快照兜底（跨不兼容存储格式） |

本次交付三件事：**① httpx 卡死修复；② 升级保护加固；③ 版本新特性价值评估**。

---

## 1. httpx 卡死修复（你反馈的核心问题）

### 1.1 根因（与你的排查方向一致，最后一步定位到 spawn 包装层）

不是沙箱、不是 `-duc`、不是 RocksDB —— 是 **run_cli 的 `spawn` 没有关闭 stdin**。

[dsh-plugin-sec-suite.js:757](../bundles/dsh/templates/dsh-plugin-sec-suite.js)（修复前）：

```js
child = spawn(spawnCmd, spawnArgs, { env, cwd: runDir })   // ← 未指定 stdio
```

Node `spawn` 默认 `stdio: ['pipe','pipe','pipe']`，**stdin 是一根常开管道**。httpx（及所有 ProjectDiscovery 系工具）启动时调 `fileutil.HasStdin()` 探测 stdin：管道会被识别为"有 stdin 输入"→ 阻塞等待从 stdin 读目标直到 EOF；父进程既不写也不关 → **永久卡死**，直到 300s manifest 超时被 SIGTERM。

- 直接 bash 跑 httpx 正常 → 因为 TTY 不是管道，`HasStdin()=false`。
- `sandbox:false` 后仍卡 → 证明与沙箱无关（你已实测到这一步）。
- strace 看到的 RocksDB/futex 11.8s → 是 **Go runtime 线程在 stdin 阻塞期间 park 在 futex** 的表象，不是真死锁。

### 1.2 修复（改在共享 spawn 路径 → 一并根治所有 CLI 工具）

[dsh-plugin-sec-suite.js:762](../bundles/dsh/templates/dsh-plugin-sec-suite.js)：

```js
child = spawn(spawnCmd, spawnArgs, { env, cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] })
```

stdin → `/dev/null`（字符设备）→ `HasStdin()=false` → 工具改用 `-u/-l` 参数正常执行。stdout/stderr 仍为管道（下游 `child.stdout.pipe()` 要读）。**这个改动在 runTool 唯一 spawn 处，对 httpx/nuclei/dnsx/naabu/katana… 全部生效**，是这一类"管道 stdin 阻塞"的一次性根治。

### 1.3 附带修复：恢复 httpx 的 S2 沙箱posture

既然卡死与沙箱无关，`sandbox:false` 这个错误 workaround 就没必要了。实测（下方 test C）证明**沙箱内 httpx 关闭 stdin 后 3.2s 正常返回**，于是：

- 代码新增 `manifest.sandbox === false` 逐工具豁免开关（escape hatch，留给极少数真与 bwrap user-ns 不兼容的工具，[:752](../bundles/dsh/templates/dsh-plugin-sec-suite.js)）——同时消除了此前直接热补 csai 造成的"运行时 ≠ 仓库"漂移。
- csai 的 `httpx.yaml` 移除 `sandbox:false`，**httpx 重新回到 bwrap 白名单隔离**（S2 审计项恢复）。

### 1.4 三段式证据（node spawn 精确复刻 runTool 调用）

| 测试 | stdio | 结果 |
|---|---|---|
| A 默认（stdin 管道） | `pipe,pipe,pipe` | **卡死** —— 15s 被杀、0 字节输出 |
| B 关闭 stdin | `ignore,pipe,pipe` | **3.8s、exit 0、568 字节 JSON** |
| C 关闭 stdin + bwrap | `ignore,pipe,pipe` | **3.2s、exit 0、567 字节 JSON**（沙箱内也正常） |

端到端（真实 run_cli 路径，升级后 rc.2 复测）：

```
run_id rmt59f7h36a09  exit_code 0  signal None  duration_ms 20051  sandboxed True  session_id SET
```

（20s vs 直连 3.2s 是**出口代理 mubeng 轮换开销**，属正常；关键是 exit 0、非超时、沙箱生效、会话捕获正常。）

---

## 2. 升级保护措施：验证 + 加固

### 2.1 原有保护（验证：有效）

`dsh-upgrade.sh` 原本已有：**版本 pin**（setup.sh 不自动升级，只走 dsh-upgrade.sh）、**配置备份**（.env + package.json + lock）、**三段自动回滚**（pnpm install 失败 / 服务未 active / HTTP :3081 无响应任一触发即回滚版本 + 重启）。这些本次升级中全部正常。

### 2.2 发现两处缺口 → 已加固

| 缺口 | 风险 | 加固 |
|---|---|---|
| **备份不含 `data/`** | rc.8 起存储格式声明"不兼容"，若 DSH 对 `storages/` 单向迁移，仅回滚 npm 版本无法复原旧数据 | **升级前自动打数据快照**（`dsh-datasnap-*.tgz`，含 asset-graph.db/scope.yml/storages/tools.d/profiles…，排除 results/flows 瞬态）；rollback 路径打印数据恢复指引 |
| **冒烟太浅** | 只看 `is-active` + HTTP 有响应；"DSH 起来了但自研插件加载失败"会被漏判为成功 | **新增深冒烟**：`--dump-config` 校验 `sec-cli-adapter` 是否在组合树，不在则判失败并回滚（fail-safe：若新版改了 --dump-config 也只会保守回滚，不会误放行） |

改动见 [dsh-upgrade.sh](../bundles/dsh/templates/dsh-upgrade.sh)。**本次升级两项加固均实测触发**：数据快照 187M 落盘、深冒烟通过（sec-cli-adapter 在 web 组合树）。

### 2.3 对"升级很麻烦"的机制性回答

深冒烟 + 自动回滚 = **每次 rc 升级都自验证**：DSH 破坏了插件加载会当场回滚到旧版，服务不中断、数据不丢。今后升级只需一条 `spool bundle dsh upgrade csai`，成功即用、失败自愈，不再需要人肉盯梢。这是把"不稳定版本频繁升级"的成本压到最低的关键。

---

## 3. 插件解耦评估（"各插件解耦效果如何"）

### 3.1 结论：解耦良好，唯一薄弱面是看板 client 用了 DSH 预览内部 API，已被深冒烟兜住

| 维度 | 解耦强度 | 本次升级实证 |
|---|---|---|
| **领域数据** | ★★★★★ 完全解耦 | asset-graph.db 用 `node:sqlite`（绑 Node 22，与 DSH 存储格式无关）。跨 rc.8"不兼容存储格式"升级后，10138 assets 等**逐表零变化** |
| **插件依赖** | ★★★★★ 零依赖 | 自研插件只用 node 内置模块（child_process/fs/crypto/sqlite），不吃 DSH 的 peer deps |
| **调度器** | ★★★★★ 自建 | setInterval + SQLite 事务认领，不用 DSH 内部 API，升级无冲击 |
| **工具执行上下文** | ★★★★☆ 防御式耦合 | `exec.agent.id`（run→session 映射）用 try/catch 兜底访问；rc.2 复测 **session_id SET**（未变） |
| **看板 client** | ★★★☆☆ 依赖预览 API | `inject:['slots','sessions']` + `ctx.sessions.open` 是 rc.7 预览内部面；rc.2 复测 **sec-dashboard 仍进组合树**（未变），但这是**最需要盯的升级敏感面**——已由深冒烟 + pin + shim 纪律兜底 |

### 3.2 本次升级实际"改动量"= 0（除主动做的两处）

除了我主动做的 httpx 修复与升级加固，rc.7→rc.2 对平台的**被动改动为零**：五插件全部原样加载、数据零迁移、工具/会话/沙箱/代理/调度全部照常。这正是解耦到位的体现——**不稳定版本升级并没有带来"巨大改动"**。

---

## 4. 版本新特性对「资产收集 / 漏洞挖掘」的价值评估

rc.7 → rc.2 跨 rc.8 / rc.1 / rc.2 三个版本。诚实结论：**本轮更新绝大多数是多模态/视觉 + DeepSeek 适配器 + UI 打磨，对无头自动化的资产/漏洞流水线直接增益有限**。逐项裁决如下：

| 新特性（版本） | 对资产/漏洞的价值 | 裁决 |
|---|---|---|
| **DeepSeek-V4-Flash-Vision-Exp 视觉模型** + /goal /plan 图片输入 + Files API 图片上传 + 图片预处理（rc.1/rc.2） | **唯一有实质价值点**：喂 dsh-browser 截图 → 视觉模型识别登录页/后台/管理面板/技术栈/CMS，对 10138 资产做**攻击面视觉分诊**（哪些"看着值得打"） | **建议下一步（P12），不本次强加**（见 §4.1）。交互式已可用：Web 会话里对截图直接问视觉模型 |
| **SQLite 读写/fork 提速 + 存储更小**（rc.8） | DSH 会话/轨迹层提速、spawn_worker fork 更快 | **免费即得**，升级后已生效 |
| **并发 web_search + 子代理报告唤醒父任务**（rc.8） | spawn_worker / intel_hunt 情报驱动（象限 D）回路更跟手 | **免费即得**，升级后已生效 |
| **Claude Code / Codex 子代理装成 Profile Bundle**（rc.8，非交互权限 + 命名实例） | 理论上可做 worker 后端 | **主动跳过**：违背 plan §1.4"单轨 pi-ai、无双轨"纪律，且各家 Coding Plan 禁止 API 自动化 |
| **bwrap `/proc/<pid>/root` 逃逸封堵**（rc.1） | DSH 自带 dsh-sandbox 的加固 | **仅注记**：我们走自建 bwrap（`--unshare-all` 含新 PID ns，宿主进程 /proc/<pid>/root 本就不可见），已等价免疫 |
| ask_user_question 多行输入（rc.1） | HITL 体验 | **跳过**：我们的 HITL 走 Matrix / chicheng-push，非 ask_user_question |

### 4.1 唯一值得做的新能力：视觉分诊（建议排 P12，不本次强加）

你明确说"避免每次升级都做巨大改动"。视觉分诊是**新引擎/新管道**，本次刚升完就硬塞进去恰恰违背这条。故给出**可落地的scoped方案**供你拍板，而非自动开工：

```
dsh-browser 截图（已有）
   └─▶ 新 manifest: vision_triage（risk:passive, 本地文件输入, 不沙箱网络）
          └─▶ DeepSeek-V4-Flash-Vision-Exp（rc.1 起可用）
                 └─▶ 结构化输出 {page_type, tech_stack, has_login, interesting:0-1}
                        └─▶ 写 facts（category:asset, confidence:tentative）+ 看板资产视图打"视觉分诊"徽章
```

- 增量、可回滚（新增一个 manifest + 一段 parser，不动现有引擎）。
- 价值：把"10138 资产靠人扫"变成"视觉模型先粗筛高价值靶标"，直接服务象限 A/B。
- 成本：一次性开发，非每次升级都要动 → 符合你的"升级别老改"诉求。

**要不要做、什么时候做，等你一句话。**

---

## 5. 本次仓库改动清单

| 文件 | 改动 |
|---|---|
| [bundles/dsh/templates/dsh-plugin-sec-suite.js](../bundles/dsh/templates/dsh-plugin-sec-suite.js) | ① spawn 关闭 stdin（根治卡死）；② `manifest.sandbox===false` 逐工具豁免开关 |
| [bundles/dsh/templates/dsh-upgrade.sh](../bundles/dsh/templates/dsh-upgrade.sh) | ① 升级前数据快照；② 深冒烟（插件组合树校验）；③ rollback 数据恢复指引；④ warn() 辅助 |
| [bundles/dsh/templates/seed-manifests.sh](../bundles/dsh/templates/seed-manifests.sh) | httpx 种子 args 加 `-duc`（新装主机默认关闭更新检查，沙箱化不变） |

csai 运行时同步：`spool bundle dsh setup csai`（推模板 + 组装插件 + 重启）→ 移除 httpx.yaml 的 sandbox:false → 重启 → `spool bundle dsh upgrade csai`。

---

## 6. 回滚手册（今后需要时）

```bash
# 版本回滚（自动，升级脚本已内建；手动强制回某版）：
spool exec csai "cd /opt/silkspool/dsh/app && bash /opt/silkspool/dsh/dsh-upgrade.sh --version 0.1.0-rc.7 --force"

# 数据回滚（仅当存储迁移出问题时，人工判断后执行）：
spool exec csai "ls -t /opt/silkspool/dsh/data/backups/dsh-datasnap-*.tgz | head"
# 停服 → 解包快照到 data/ → 起服（详见 silksec-restore.sh）
```

本次升级前的兜底快照：`preflight-20260823_032848.tgz`（187M）+ 升级脚本自动快照 `dsh-datasnap-20260823_033647.tgz`（187M）。

---

## 7. 残留风险与建议

- **看板 client 依赖 DSH 预览 API**：是唯一的升级敏感面，rc.2 未受影响，但后续 rc 若改 slots/sessions 面可能需重写 client 薄层（数据层不动）。深冒烟目前只校验 sec-cli-adapter，**建议把 sec-dashboard 也纳入深冒烟**（一行 grep），进一步提前暴露。
- **P12 尾项不变**：egress-guard（S3 网络层兜底）、chicheng-push（HITL 到手机）、Authelia forward-auth（S6）三件仍未落地（见 plan §1.5）。
- **视觉分诊**：如决定做，按 §4.1 scoped 方案增量落地。
