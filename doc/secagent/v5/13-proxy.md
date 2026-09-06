# 13 · proxy 域设计（免费代理池：采集提案落池、轮换网关消费、会话保持）

> 版本：v5.0 ｜ 状态：草案 ｜ 契约版本：1
> 依赖：**订阅**：无（不订阅任何事件）；**被订阅**：`proxy.pool.refreshed` / `proxy.bad.reported` / `proxy.sticky.bound`（当前零强联动订阅者——mubeng 热加载不依赖事件，见 §2.3 论证）；**被引用**：exec 域（env_proxy 8899 注入前引用 `proxy_stats` 做健康观测）、16-dashboard（网关健康展示）。
> 上位文档：[`00-conventions.md`](00-conventions.md)（冲突以它为准）。

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 域名 | `proxy` |
| cordis 服务名 | `secDomain.proxy`（provide）|
| 插件包名 | `@silksec/sec-domain-proxy` |
| 后端插件包名 | `@silksec/sec-backend-proxy-file`（file 后端单实现）|
| profile 挂载 | web + headless 均挂载（worker 会话要用 sticky_bind / list）|
| owns（单写者）| `{POOL_DIR}/pool.json`、`live.txt`、`blocklist.txt`、`stats.json`、`sticky.json` 五文件（POOL_DIR = env `SEC_PROXY_POOL_DIR`，默认 `/opt/silkspool/dsh/proxy-pool`）|
| 只读 inbox（非 owns）| `{POOL_DIR}/out/proxies.json`（proxy-scraper-checker 采集验证原始产物）、`{POOL_DIR}/out/proposal.json`（proxy_grade.py 纯计算产出的落池提案）|
| 环境变量 | `SEC_PROXY_POOL_DIR`（池目录）、`SEC_EGRESS_PROXY`（网关地址，默认 `http://127.0.0.1:8899`）|

owns 边界说明：v4 中 mubeng 网关消费 `live.txt`（`-w` watch 模式），本域是 live.txt 的**唯一写者**（v4 的 toolReportBad/toolRefresh/采集链三处写收敛为三个域命令）；`out/` 下产物归采集链（脚本）所有，域只读——这是"脚本产 proposal、命令落库"模式（与 asset 域 asset_grade 同构）在 file 后端的体现。

### 1.2 命令（写动词）总表

| 动词 | 一句话语义 | actor 白名单 | 幂等键 | 事件 |
|---|---|---|---|---|
| `proxy_refresh` | 读采集 proposal，应用 blocklist/分级过滤，原子落池五文件 | script, model, dashboard, human | 自然键（proposal 内容 sha1）| `proxy.pool.refreshed` |
| `proxy_report_bad` | 失效代理入 blocklist + 从 live 同步移除 | model, script, dashboard, human | 自然键（hostport）| `proxy.bad.reported` |
| `proxy_sticky_bind` | 会话保持：同 sticky_key 复用同出口，失效自动重选 | model, script | 自然键（sticky_key）| `proxy.sticky.bound` |

### 1.3 命令逐个详述

#### 1.3.1 `proxy_refresh`（采集脚本改纯计算产 proposal → 本命令落池）

**语义**：把"采集→验证→匿名度分级"的**纯计算产物**（`out/proposal.json`）落成池文件族（pool.json / live.txt / stats.json），blocklist 与 transparent 级过滤在落池时执行。`trigger_collect: true` 时先异步触发 systemd 采集单元并立即返回（不落池）。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `trigger_collect` | boolean | 否 | `false` | true = `sudo -n systemctl start --no-block silksec-proxy-refresh.service`（systemd 单元名沿用 v4），返回 collecting 状态，**不执行落池** |
| `proposal_path` | string | 否 | `{POOL_DIR}/out/proposal.json` | 必须位于 POOL_DIR 前缀内（防穿越）；须为可解析 JSON |
| `force` | boolean | 否 | `false` | false 且 proposal 未变化（sha1 与上次落池相同）→ 幂等命中返回 replay |

**落池算法（网关不变量顺序执行，实现者照抄）**：

1. 解析 proposal（结构 = v4 `out/proxies.json` 的 enriched 数组 + grade 字段：`{protocol, host, port, username?, password?, timeout, exit_ip, geolocation, grade}`）；
2. 过滤：剔除 `grade=transparent` 的 HTTP(S) 条目（INV-P4）；剔除 blocklist.txt 命中的 hostport（INV-P1）；
3. 排序：按 timeout（延迟）升序；
4. 生成 `pool.json`（全量过滤后数组）、`live.txt`（elite/anonymous 的 http + 全部 socks，延迟靠前截 LIVE_LIMIT=400 条，INV-P3）、`stats.json`（`{refreshed_at: epoch 秒, total, by_protocol, by_grade, blocked_applied, proposal_sha}`）；
5. **sticky 清理**：sticky.json 中绑定出口已不在新 live 的键 → 删除（INV-P5 前置）；
6. 三文件全部 tmp+rename 原子写（INV-P6，mubeng `-w` watch 读完整文件）；
7. 发 `proxy.pool.refreshed` 事件。

**返回信封 data**：

```json
{
  "status": "applied",            // applied | collecting | replay
  "pool_total": 1823,
  "live_count": 400,
  "blocked_applied": 57,
  "transparent_dropped": 112,
  "sticky_invalidated": 3,
  "refreshed_at": 1789000000,
  "proposal_sha": "a3f8..."
}
```

（`trigger_collect:true` 时返回 `{status:"collecting", detail:"采集已后台运行（5-15 分钟），完成后由 timer 链自动落池；也可稍后 proxy_stats 查看"}`。）

**错误清单**：

| code | 触发 | hint 文案 |
|---|---|---|
| `E_SCHEMA` | 参数类型错 | message 指明字段 |
| `E_PROXY_NO_PROPOSAL` | proposal 不存在/损坏/空 | "proposal 缺失——先 trigger_collect:true 触发采集，或等 30min timer 自动链" |
| `E_PROXY_LIVE_EMPTY`（警告级，不报错）| 过滤后 live 为空 | 返回 live_count=0 + hint："池被过滤空，检查 blocklist 是否误报过多或采集源失效" |
| `E_BACKEND_UNAVAILABLE` | POOL_DIR 不可写 / systemd 调用失败 | retryable=true |
| `E_ACTOR_FORBIDDEN` | webhook/approval/scheduler/system 调用 | — |

**幂等**：自然键 = proposal 文件内容 sha1 → `proxy:refresh:sha:{hash}`。同 proposal 重放 → 返回首次结果 + `replay: true`（文件不重写）；不同 proposal（新采集）→ 正常落池。

**actor**：`script`（**timer 链主通道**——silksec-proxy-refresh.service 的 ExecStartPost 调总线 CLI，§2.3）、`model`（手动触发采集/落池）、`dashboard`（看板刷新按钮）、`human`。

**RoE**：采集是 5-15 分钟异步动作，触发后靠 `proxy_stats` 观察；transparent 级代理**永不入池**（经它发请求会泄露真实 IP）；落池后 mubeng `-w` 自动热加载，无需任何 reload 动作；timer 每 30 分钟自动跑全链，模型通常无需手动刷新。

**side_effects 声明**：`[files: pool.json/live.txt/stats.json/sticky.json, events: proxy.pool.refreshed, caches: 无]`

#### 1.3.2 `proxy_report_bad`

**语义**：上报失效/被目标封禁的代理——hostport 入 blocklist.txt + 从 live.txt 移除（同一次命令内保证一致性 INV-P1），mubeng `-w` 热加载自动生效。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `proxy` | string | 是 | — | `http://1.2.3.4:8080` 或 `1.2.3.4:8080`；解析出 hostport（`split('://').pop().split('@').pop()`，照抄 v4 L164）；必须含 `:` 端口 |
| `reason` | string | 否 | `''` | ≤128 字符；建议枚举语义：`timeout` / `banned_403` / `captcha` / `dead` / `ssl_error` |

**返回信封 data**：`{blocked: "1.2.3.4:8080", removed_from_live: true, live_remaining: 398, sticky_invalidated: 1}`

**错误清单**：

| code | 触发 | hint 文案 |
|---|---|---|
| `E_PROXY_BAD_ADDRESS` | proxy 无法解析出 host:port | "代理地址格式：http://1.2.3.4:8080 或 1.2.3.4:8080" |
| `E_BACKEND_UNAVAILABLE` | 文件读写失败 | retryable=true |

**幂等**：自然键 = hostport → `proxy:report_bad:{hostport}`。已 blocklisted 的重放 → `replay: true`，返回 `{blocked, removed_from_live: false}`（不重复追加）。注意：**blocklist 无撤销动词**（下一轮采集不会复活被拉黑条目——blocklist 是跨轮持久语义），误报的代价是永久失去该代理。

**actor**：`model`（工具调用）、`script`（exec 域 run_cli 失败诊断脚本、verify_replay 重放失败自动上报）、`dashboard`、`human`。

**RoE**：**谨慎上报**——一次 timeout ≠ 失效（免费代理抖动大），确认重试仍失败或目标返回 403/captcha 再报；`banned_403` 类原因必须带（用于后续按目标维度分析）；上报即从轮换队列移除且不可撤销。

**side_effects 声明**：`[files: blocklist.txt/live.txt/sticky.json, events: proxy.bad.reported]`

#### 1.3.3 `proxy_sticky_bind`

**语义**：会话保持——同 sticky_key 的多次调用复用同一出口 IP（登录态/会话 cookie 场景）；缓存出口失效（不在 live）时按过滤条件重选（**延迟最优前 5 随机取一**，防固定出口指纹）。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `sticky_key` | string | 是 | — | 1-128 字符；建议语义命名如 `meituan-login-flow` |
| `protocol` | string | 否 | `''` | enum `['', 'http', 'https', 'socks4', 'socks5']` |
| `max_latency_ms` | integer | 否 | 0（不限）| 100-60000 |
| `country` | string | 否 | `''` | ISO 两位码（如 `US`），大小写不敏感 |
| `rebind` | boolean | 否 | `false` | true = 强制换出口（当前绑定仍健康也重选）|

**返回信封 data**：

```json
{
  "proxy": "http://1.2.3.4:8080",
  "protocol": "http", "grade": "elite",
  "latency_ms": 812, "exit_ip": "1.2.3.4",
  "country": "US", "city": "Ashburn",
  "sticky": true,          // true=命中缓存复用；false=本次新选
  "sticky_key": "meituan-login-flow"
}
```

**绑定算法**：① 读 sticky.json，缓存命中且 `cached.proxy ∈ live` 且（未传过滤参数或与缓存元数据匹配）→ 返回 `{...cached, sticky: true}`；② 否则按 protocol/max_latency_ms/country 过滤 live ∩ pool → 按延迟排序取前 5 → 随机取一 → 写 sticky.json（tmp+rename）→ 返回 `sticky: false`。

**错误清单**：

| code | 触发 | hint 文案 |
|---|---|---|
| `E_PROXY_POOL_EMPTY` | live.txt 为空 | "可用队列为空，先 proxy_refresh（trigger_collect:true）" |
| `E_PROXY_NO_MATCH` | 过滤条件无命中 | "无符合过滤条件的代理——放宽 max_latency_ms/country 或 proxy_list 查看可用面" |

**幂等**：自然键 = sticky_key → `proxy:sticky_bind:{key}`。同 key 同参重放 → 返回当前绑定 + `replay: true`（缓存健康即复用，不重选）。

**actor**：`model`、`script`（worker 流程内固定出口）。

**RoE**：**同键复用同出口**——需要会话保持的流程（登录/多步交互）必须传同一 sticky_key；出口失效自动重选（新 IP，需重新过登录态）；经免费代理的流量**绝不携带真实凭证/Cookie/Token**（免费代理可被运营者嗅探）——sticky 只解决"同出口"，不解决"可信出口"。

**side_effects 声明**：`[files: sticky.json, events: proxy.sticky.bound]`

### 1.4 查询（读投影）逐个详述

#### 1.4.1 `proxy_stats`（池状态 + 网关健康）

无参数。返回：

```json
{
  "refreshed_at": 1789000000, "age_minutes": 12.3,
  "total": 1823, "by_protocol": { "http": 1200, "socks5": 500, "socks4": 123 },
  "by_grade": { "elite": 400, "anonymous": 900, "socks": 500, "unknown": 23 },
  "blocked_applied": 57,
  "live_txt_size": 400, "live_limit": 400,
  "sticky_keys": 12,
  "gateway": "http://127.0.0.1:8899",
  "rotator_status": "active",       // systemctl is-active silksec-proxy-rotator
  "refresh_timer": "active"         // systemctl is-active silksec-proxy-refresh.timer
}
```

纯读（含两条 `systemctl is-active` 只读子进程调用，各 15s 超时，失败返回 `unknown` 不抛错）。**注意口径修正**：v4 `by_grade` 含 `unknown`（探测失败的 HTTP 代理）——v5 落池时 unknown 级 HTTP 条目**保留在 pool.json 但不入 live**（与 v4 一致：live 只收 elite/anonymous + socks）。

#### 1.4.2 `proxy_list`（协议/延迟/匿名度/国家过滤）

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `protocol` | string | 否 | `''` | enum http/https/socks4/socks5 |
| `grade` | string | 否 | `''` | enum elite/anonymous/unknown/socks |
| `max_latency_ms` | integer | 否 | 0 | |
| `country` | string | 否 | `''` | ISO 两位码 |
| `limit` | integer | 否 | 20 | 1-100 |
| `offset` | integer | 否 | 0 | |

返回 `{rows, total_live, limit, offset}`；rows 仅 live ∩ pool 条目（元数据投影 = v4 `meta()`：proxy URL/protocol/grade/latency_ms/exit_ip/country/city），按延迟升序。**行数 = total_live 口径说明**：total_live 是 live 总数（非过滤后数）——过滤后计数以 rows.length 为准（本域特例：live 是滚动队列，精确过滤计数无业务价值；契约测试断言改为 rows.length ≤ limit 且 rows 全部满足过滤条件）。

#### 1.4.3 `proxy_gateway`（各工具代理注入用法速查——RoE 文档型查询）

无参数。返回（内容照抄 v4 toolGateway，模型保留的 RoE 文档）：

```json
{
  "gateway": "http://127.0.0.1:8899", "rotator_status": "active",
  "usage": {
    "env前缀（通用）": "http_proxy=http://127.0.0.1:8899 https_proxy=http://127.0.0.1:8899 <命令>",
    "curl": "curl -x http://127.0.0.1:8899 <url>",
    "sqlmap": "sqlmap -u <url> --proxy=http://127.0.0.1:8899",
    "nuclei": "nuclei -u <url> -proxy http://127.0.0.1:8899",
    "httpx/ffuf": "httpx -http-proxy http://127.0.0.1:8899 / ffuf -x http://127.0.0.1:8899",
    "nmap(仅HTTP代理探测)": "经网关取单代理后: nmap -sT --proxies <proxy_url> <target>"
  },
  "notes": [
    "轮换网关仅代理 HTTP/HTTPS 流量；SOCKS 需求请用 proxy_list 取 socks5 代理自行注入",
    "经代理的流量绝不携带任何真实凭证/Cookie/Token（免费代理可被运营者嗅探）",
    "nmap 经代理只能用 -sT 全连接扫描，无 SYN/UDP",
    "会话保持场景（登录态）用 proxy_sticky_bind，不要走轮换网关"
  ]
}
```

### 1.5 事件

| 事件名 | 触发命令 | payload schema | 频控 |
|---|---|---|---|
| `proxy.pool.refreshed` | proxy_refresh | `{pool_total, live_count, blocked_applied, transparent_dropped, proposal_sha}` | ≤1 次/命令（30min timer 节流天然成立）|
| `proxy.bad.reported` | proxy_report_bad | `{proxy: "host:port", reason, live_remaining}` | ≤1 次/命令 |
| `proxy.sticky.bound` | proxy_sticky_bind | `{sticky_key, proxy: "host:port", reused: bool}` | ≤1 次/命令 |

事件落 `data/events/proxy.jsonl`。**当前零订阅者**——事件保留给观测者（看板池健康、exec 域审计对照、未来 eval 的"代理质量对工具成功率影响"分析）。**mubeng 热加载不依赖事件**（§2.3 论证）。

### 1.6 模型工具面投影（工具名 + 描述全文）

| 工具名 | 描述全文（manifest agent_note）|
|---|---|
| `proxy_refresh` | 落池代理池：读取采集 proposal（纯计算产物）过滤分级后更新 pool.json/live.txt，mubeng 网关自动热加载。trigger_collect=true 先后台触发采集（5-15 分钟，完成后 timer 链自动落池）。当池子耗尽、队列过旧或大量代理失效时调用；30min timer 平时自动维护，通常无需手动。 |
| `proxy_report_bad` | 上报失效/被目标封禁的代理：加入 blocklist 并从轮换队列移除（mubeng 热加载自动生效，不可撤销）。proxy 形如 http://1.2.3.4:8080 或 1.2.3.4:8080；reason 建议 timeout / banned_403 / captcha / dead。谨慎上报：一次 timeout 不等于失效，确认重试仍失败再报。 |
| `proxy_sticky_bind` | 会话保持：同 sticky_key 多次调用复用同一出口 IP（登录态/多步交互场景）。可按 protocol/max_latency_ms/country 过滤；出口失效自动重选（延迟最优前 5 随机取一）。返回代理 URL 及元数据，注入方式：http_proxy=<url> https_proxy=<url> <命令>。经免费代理的流量绝不携带真实凭证。 |
| `proxy_stats` | 查看代理池整体状态：总数、各协议/匿名度分布、可用队列规模、上次刷新时间、轮换网关（127.0.0.1:8899）运行状态。 |
| `proxy_list` | 列出可用代理队列（按延迟升序）。可选 protocol / grade(elite/anonymous/socks) / max_latency_ms / country 过滤，limit 默认 20 最大 100。单个 socks 代理（nmap --proxies 等场景）从这里取。 |
| `proxy_gateway` | 查看本地轮换网关用法速查。网关每请求自动更换出口 IP、失败自动轮换/剔除，是批量探测防封的首选方式；各工具的代理注入参数写法见返回。 |

### 1.7 看板 RPC 投影

| RPC 名 | 来源 | 壳层用法（16-dashboard.md）|
|---|---|---|
| `proxy.stats` | 查询 proxy_stats | 壳顶部健康区（可选 proxy 卡片：池规模/网关状态）；exec 域工具执行失败时的旁证 |
| `proxy.list` | 查询 proxy_list | （预留）proxy 视图插件 |
| `proxy.gateway` | 查询 proxy_gateway | 帮助信息（只读）|
| `proxy.refresh` | 命令 proxy_refresh | 看板"刷新代理池"按钮（actor=dashboard + operator）|
| `proxy.report_bad` | 命令 proxy_report_bad | （预留）池列表行内上报 |
| `proxy.sticky_bind` | 命令 proxy_sticky_bind | 不进看板（model/script 专用面）|

### 1.8 外部调用示例

**模型调用**：

```json
{ "name": "proxy_sticky_bind",
  "arguments": { "sticky_key": "meituan-login-flow", "protocol": "http", "max_latency_ms": 3000 } }
```

**代码调用**（exec 域注入前健康观测）：

```js
const bus = ctx.inject('secDomainBus')
const stats = await bus.query('proxy', 'stats', {})
if (stats.rotator_status !== 'active') audit.warn('proxy gateway down', { stats })
```

**脚本调用**（timer 链落池——silksec-proxy-refresh.service ExecStartPost）：

```bash
sec domain call proxy refresh --actor script \
  --args "{\"proposal_path\": \"${POOL_DIR}/out/proposal.json\"}"
```

---

## 二、内部实现（Internal）

### 2.1 数据模型

**文件族（owns，全部延续 v4 结构——mubeng/采集链零改动兼容）**：

| 文件 | 结构 | 写者 |
|---|---|---|
| `pool.json` | enriched 条目数组：`{protocol, host, port, username?, password?, timeout(秒, float), exit_ip, geolocation:{country:{iso_code}, city:{names:{en}}}, grade}`，按 timeout 升序 | proxy_refresh |
| `live.txt` | 每行一条代理 URL（mubeng 队列格式）；elite/anonymous 的 http + 全部 socks，≤400 条 | proxy_refresh / proxy_report_bad |
| `blocklist.txt` | 每行 `host:port  # reason timestamp` | proxy_report_bad |
| `stats.json` | `{refreshed_at, total, by_protocol, by_grade, blocked_applied, proposal_sha}` | proxy_refresh |
| `sticky.json` | `{sticky_key: <meta 投影对象>}`（v4 全量 meta 缓存，返回形态兼容；权威判据只有 `cached.proxy ∈ live`）| proxy_sticky_bind |

**inbox（采集链 owns，域只读）**：`out/proxies.json`（scraper-checker 产物）、`out/proposal.json`（proxy_grade.py 纯计算产物，结构与 pool.json 条目一致 + grade 字段）。

**匿名度分级算法要点（proxy_grade.py 纯计算段，v5 只改输出目标不改算法）**：

1. 真实 IP 探测：直连 `api.ipify.org` / `ipv4.icanhazip.com` / `ifconfig.me/ip`（任一成功取第一个合法 IPv4）；
2. HTTP(S) 代理分级：经代理请求 echo 服务（`httpbin.org/headers` / `httpbingo.org/headers` / `postman-echo.com/headers`，8s 超时，64 并发）——响应体含真实 IP → `transparent`（剔除）；含代理注入头（x-forwarded-for/x-real-ip/forwarded/via/client-ip/x-client-ip/x-proxy-id/proxy-connection）→ `anonymous`；两者皆无 → `elite`；全 echo 失败 → `unknown`；
3. SOCKS4/5 不修改 HTTP 头，天然匿名，grade=`socks` 直接收录；
4. 控制时长：只对延迟最优的前 600 个 HTTP 代理做分级探测；
5. UA 固定 Chrome 桌面形态。

### 2.2 状态机与不变量

**状态机**：本域刻意**无行级状态机**——pool 每轮全量重建（无"代理条目生命周期"）；blocklist 条目单态（active，附 reason+时间戳）；sticky 绑定两态 `bound → invalidated`（失效时静默删除，下次 bind 重选）。

**不变量清单**：

| # | 不变量 | 校验点 | 失败处理 |
|---|---|---|---|
| INV-P1 | blocklist ∩ live = ∅（被拉黑代理绝不在轮换队列）| proxy_refresh 落池后断言；proxy_report_bad 写后断言 | E_INTERNAL + audit（不应出现——两处都在命令内同批完成）|
| INV-P2 | live ⊆ pool（每条 live URL 在 pool.json 有同 URL 条目）| proxy_refresh 落池后断言 | 同上 |
| INV-P3 | live ≤ LIVE_LIMIT(400) | 生成时截断 | 结构保证 |
| INV-P4 | pool 不含 transparent 级 HTTP 代理 | proxy_refresh 过滤步骤 | 结构保证 |
| INV-P5 | sticky 绑定出口 ∈ live | sticky_bind 读取时校验；refresh 后清理 | 失效绑定静默删除（不抛错——重选是正常语义）|
| INV-P6 | 五文件一律 tmp+rename 原子写 | file 后端实现 | 写失败整体回退旧文件 |
| INV-S1（安全基线）| **免费代理流量绝不携带真实凭证/Cookie/Token** | RoE 纪律 + exec 域协作（见下）| — |

INV-S1 的执行面：① 本域所有工具描述与 proxy_gateway notes 显式声明；② exec 域 run_cli 沙箱本就对工具隐藏平台密钥（bwrap 只读挂载），凭证注入工具的 manifest 声明 `env_proxy: false`（互斥声明，exec 域守卫链校验：`env_proxy:true` 的工具参数禁含 `credential`/`cred_ref` 类字段——详 10-exec.md）；③ 模型层纪律（sec-runtime-discipline 既有条款延续）。

### 2.3 事务与联动

**采集链（30min timer → 纯计算 proposal → 命令落池）**：

```
silksec-proxy-refresh.timer (30min)
  └─ silksec-proxy-refresh.service (oneshot)
       ├─ ExecStart:   proxy-pool-run-refresh.sh          # proxy-scraper-checker（TUI 伪终端包装）→ out/proxies.json
       ├─ ExecStartPost[1]: python3 proxy_grade.py --proposal-only   # 纯计算：匿名度分级+排序 → out/proposal.json（不再直写 pool 族）
       └─ ExecStartPost[2]: sec domain call proxy refresh --actor script   # 本域命令落池（唯一写入口）
mubeng (silksec-proxy-rotator.service, -w watch live.txt)  # 热加载消费方
```

改造点：v4 的 proxy_grade.py main 直接写 pool.json/live.txt/stats.json（三处裸写绕过域）；v5 拆成"纯计算段（`--proposal-only` 出 proposal 文件）+ 落池段（删——移入 proxy_refresh 命令）"。timer/service/rotator 三个 systemd 单元除 ExecStartPost 链外**零改动**。

**mubeng 热加载机制的论证（订阅事件 vs 原生 watch）**：

问题：proxy_report_bad / proxy_refresh 改 live.txt 后，mubeng 如何感知？两个候选：

| 方案 | 描述 | 评价 |
|---|---|---|
| A（采用）| **依赖 mubeng 原生 `-w` watch**：rotator 启动参数已带 `-w`（watch 文件变更自动重载队列），配合本域 tmp+rename 原子写保证 mubeng 总是读到完整文件 | 零新增部件；热加载成功与否由 mubeng 自身保证（`--rotate-on-error --remove-on-error` 的运行时容错兜底）；事件通道保持纯观测语义 |
| B | 域发布 `proxy.pool.refreshed` → mubeng 侧订阅者收到后再触发 reload | 需要一个常驻订阅进程桥接事件→signal；订阅者失败会被网关记 `subscriber_failed` 但**池文件其实已更新**——"命令成功但热加载失败"与"命令失败"在错误语义上混淆；为已有原生机制引入额外失败面 |

**结论：方案 A。** `proxy.pool.refreshed` / `proxy.bad.reported` 事件保留给观测者（看板/exec 域审计/未来分析），**不承载任何热加载职责**——事件是"发生了什么"的记录，不是"谁去干活"的指令链。这与总线"跨域联动走事件"公理不冲突：mubeng 不是域，是本域后端文件的原生消费者（同 vault 同步链路消费 rules/ 文件的关系）。

**与 exec 域的接口（env_proxy 8899 注入约定）**：

1. exec 域 run_cli：manifest `env_proxy: true` 且目标是公网（isInternalHost 判定保留在 exec 域：localhost/.singll.net/.internal/.lan/RFC1918/169.254/127 → 直连）→ 注入 `http_proxy=http://127.0.0.1:8899 https_proxy=http://127.0.0.1:8899`；
2. v5 增强：注入前 exec 域引用本域 `proxy_stats` 查询（loopback，毫秒级）——`rotator_status !== 'active'` 时记 audit 警告（kind=guard，warn 级），**注入决策不变**（fail-open 限定于此：代理是可用性增强不是安全边界，mubeng Restart=always 自愈，中断采集不值得）；
3. SOCKS / 单代理需求：模型走 `proxy_list` 挑选自行注入（RoE 见 proxy_gateway notes）；
4. verify_replay（CONFIRMED 机械复核）默认走 8899 的 v4 行为保留（sec-pipeline → ledger 域迁移时维持）。

**跨域读**：无（本域不读其他域）。被读：exec/dashboard 读 proxy_stats。

### 2.4 后端适配器

repository 接口（file 后端原语）：

```js
readPool()                      // pool.json → array
readLiveSet()                   // live.txt → Set<url>
appendBlocklist(hostport, reason, ts)
removeFromLive(hostport)        // tmp+rename
writePoolAtomic(pool, live, stats)   // 三文件同批原子写（refresh 主路径）
readSticky() / writeStickyAtomic(obj)
readProposal(path)              // inbox 解析
readStats()
```

**能力矩阵**：

| 命令/查询 | file（唯一实现）| sqlite-local | http-remote |
|---|---|---|---|
| proxy_refresh / report_bad / sticky_bind | full | N/A（本域无表）| unsupported（说明：http 后端对本域的想象空间是"上游付费代理 API 作为采集源"——只影响采集链输入，不影响域存储，不构成后端差异）|
| proxy_stats / list / gateway | full | N/A | unsupported |

系统调用依赖（systemctl is-active / sudo systemctl start）：仅 file 后端实现内封装（15s 超时、失败降级字符串），不进 repository 接口。

### 2.5 缓存与失效

**无缓存层**——五文件即真相，每次查询直读（文件 ≤ 数百 KB，读盘 <10ms）。sticky.json 是**数据不是缓存**（绑定关系的持久状态）。v4 工具层的 readJSON fallback（文件缺失返回空集）保留为 file 后端的容错语义：live.txt 缺失 = 空池（E_PROXY_POOL_EMPTY 引导 refresh），不抛崩溃。

### 2.6 性能与容量

| 项 | 现状/预期 |
|---|---|
| pool.json | 数千条目（采集源全量），~1MB 级 |
| live.txt | ≤400 条（LIVE_LIMIT），mubeng 池规模匹配 |
| 采集周期 | 30min timer；单轮 5-15 分钟（scraper-checker 验证 + 600 条 HTTP 分级探测 64 并发 8s 超时）|
| 查询开销 | 全文件读 <10ms；proxy_stats 含 2 次 systemctl（<1s）|
| sticky.json | 十余键，无膨胀风险（refresh 时清理失效键；无 TTL——键生命周期跟会话）|
| blocklist | 单调增长（每条一行），年千行级无压力；不设上限（防封语义优先）|

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

| v4.x 位置（dsh-plugin-proxy-pool.js）| 内容 | v5 去向 |
|---|---|---|
| L22-47 | 插件骨架 / 常量（POOL_DIR/GATEWAY/五文件路径/三个 systemd 单元名）| `@silksec/sec-domain-proxy` manifest（owns/环境变量/单元名声明）|
| L51-95 | readJSON/loadPool/loadLiveUrls/proxyUrl/meta/systemctl/systemctlSudo | file 后端 repository 实现（systemctl 封装保留）|
| L99-110 | `toolStats()` | 查询 `proxy_stats`（+live_limit/sticky_keys 字段增强）|
| L112-146 | `toolGet()`（sticky 缓存/过滤/前 5 随机）| **拆分**：sticky 路径 → 命令 `proxy_sticky_bind`；纯过滤列举路径 → 查询 `proxy_list`（"取一个代理"的 ad-hoc 语义由网关 8899 承接，见 §3.2 别名说明）|
| L148-160 | `toolList()` | 查询 `proxy_list`（+offset/country 参数增强）|
| L162-187 | `toolReportBad()`（blocklist 追加/live 移除）| 命令 `proxy_report_bad`（+sticky 失效清理、INV-P1 同批断言）|
| L189-193 | `toolRefresh()`（systemctl start）| 命令 `proxy_refresh` 的 trigger_collect 分支；落池主路径为新增（原直写链在采集脚本里，本就不在插件）|
| L195-213 | `toolGateway()`（用法速查 + 安全注记）| 查询 `proxy_gateway`（内容照抄）|
| L223-300 | 6 个 ctx.tools.register（手写 schema）| ToolProjector 自动投影（schema 单一来源 = manifest）|
| `proxy_grade.py` main（L120 起：读 out/proxies.json → 分级 → 直接写 pool.json/live.txt/stats.json）| 纯计算与落库混杂 | **拆两段**：分级/过滤/排序逻辑保留（`--proposal-only` 输出 out/proposal.json）；写 pool 族三处删除（移入 proxy_refresh 命令）|
| `silksec-proxy-refresh.service` | ExecStartPost 直接跑 proxy_grade.py | ExecStartPost 改两步：`proxy_grade.py --proposal-only` → `sec domain call proxy refresh --actor script` |
| `silksec-proxy-rotator.service` | mubeng `-w` watch live.txt | **零改动**（热加载机制保留，§2.3 论证）|
| `proxy-pool-infra-setup.sh` / `proxy-pool-plugin-setup.sh` | 基础设施与插件安装 | 域化后归 setup 脚本链（sec-domain-proxy-plugin-setup.sh）；infra 段不动 |

### 3.2 兼容别名与观察期

| v4 旧工具名 | v5 新名 | 语义差异说明 |
|---|---|---|
| `proxy_pool_stats` | `proxy_stats` | 无差异 |
| `proxy_pool_list` | `proxy_list` | 无差异（参数超集）|
| `proxy_pool_gateway` | `proxy_gateway` | 无差异 |
| `proxy_pool_report_bad` | `proxy_report_bad` | 无差异（+sticky 失效清理增强）|
| `proxy_pool_refresh` | `proxy_refresh` | **语义增强**：v4 只触发采集（结果由脚本直写池）；v5 主语义是落池，`trigger_collect:true` 才触发采集。别名期行为：无参调用 → trigger_collect:true 等价（兼容旧用法"叫一声就采集"），hint 引导新语义 |
| `proxy_pool_get` | `proxy_sticky_bind` | **语义收窄**：v4 允许无 sticky_key 单取一个（延迟前 5 随机）；v5 单次取用改走 8899 网关（自动轮换更优）或 proxy_list 自选。别名映射到 sticky_bind 且 sticky_key 必填——无 key 调用得 E_SCHEMA + hint："单次取用走网关 8899（proxy_gateway 查看用法）；会话保持用 proxy_sticky_bind" |

别名过网关全管线；删除走废弃三段式（deprecated 标记 → 7 天 audit 零使用 → 删）。prompt 体系中 `proxy_pool_*` 引用（technique-index/skills）脚本化改写。

### 3.3 数据迁移脚本要点

**零数据迁移**——五文件格式与 systemd 链完全延续，切换日仅部署顺序有讲究：

1. 部署域插件 + 总线；
2. 改 `silksec-proxy-refresh.service` ExecStartPost 链（proxy_grade.py 加 `--proposal-only`；追加 sec CLI 落池调用）+ `systemctl daemon-reload`；
3. 首轮验证：`systemctl start silksec-proxy-refresh.service` → 观察 out/proposal.json 生成 → proxy_stats 返回 refreshed_at 更新 + live_txt_size > 0；
4. 回滚 = revert 单元文件 + 重部署 v4 插件（文件格式无差异，回滚无损）；
5. 切换窗口选在两次 timer 之间（避免半新半旧的采集轮）；mubeng 全程不动。

---

## 四、开放问题

1. **proxy_view 看板视图**：池健康是否值得一个独立看板 tab（当前规划只进壳顶部健康区）——等 exec 域失败诊断需求落地后再评估。
2. **sticky TTL**：绑定键无过期，长期运行的小概率泄漏键是否需要 7d 空闲回收。
3. **blocklist 撤销**：误报永久损失代理（§1.3.2）；是否需要 human actor 的 `proxy_unblock`（与"谨慎上报"RoE 权衡）。
4. **付费代理源**：http-remote 采集输入（商业代理 API 直灌 proposal）的账号与配额管理归 authz 域还是本域。
5. **代理质量信号回流**：proxy.bad.reported 事件按 reason/目标维度聚合分析（哪些目标对免费代理敌意高）——eval 域还是本域查询，待 eval 域定稿。
