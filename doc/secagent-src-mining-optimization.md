# SilkSecAgent SRC 漏洞挖掘优化方案

> 版本：v1.0 · 2026-08-27
> 性质：Living Document，随时修订。基于对 csai 主机 SilkSecAgent（DSH sec-suite）的只读检查与 08-20 ~ 08-27 实际运行数据。
> 适用范围：meituan-src / bytedance 双项目每日 recon+vuln 自动挖掘链路。

---

## 目录

1. [现状检查结论](#一现状检查结论)
2. [做得好的 / 做得不好的](#二做得好与做得不好)
3. [资产收集补强清单](#三资产收集补强清单)
4. [流程优化：四级漏斗管线](#四流程优化四级漏斗管线)
5. [资产×漏洞覆盖矩阵规范](#五资产漏洞覆盖矩阵规范)
6. [漏洞卡片（VulnCard）规范](#六漏洞卡片-vulncard-规范)
7. [登录态测试方法论与账号获取策略](#七登录态测试方法论与账号获取策略)
8. [输入/输出规范与会话接力](#八输入输出规范与会话接力)
9. [落地路线图](#九落地路线图)

---

## 一、现状检查结论

### 1.1 体系全景（2026-08-27 实测）

| 维度 | 现状 |
|---|---|
| 编排框架 | DSH sec-suite 插件（asset-db / facts 黑板 / exp 经验卡 / playbooks / knowledge 224 篇 / intel / scheduler） |
| 每日链路 | recon 03:00 → vuln 04:00，interval 自动续排，双项目同构 |
| 授权管控 | scope.yml + scope-guard 硬校验，max_risk=active，统一 mubeng 代理池（live_pool 173） |
| 资产面 | 美团 6309 域/存活 127；字节 3546 域/存活 276；子域连续 3-4 日 diff=0 |
| 产出 | findings 美团 187 + 字节 89；high/medium 共 12 条**全部来自 08-20 早期手工战役**；近 6 天自动化仅 +1 条 low（CORS #287） |
| xray | 被动监听 7777 常驻，8 天累计 11.2 万条 flow，**无下游消费（死库）** |
| 工具 | 已装 20+（dalfox/katana/arjun/afrog/sqlmap/ffuf/naabu/graphql-cop/ZAP…），实际仅调用 5 种（subfinder/nuclei/httpx/gau/dnsx） |
| 知识库 | 224 篇外部知识导入后 kb_search 仅 2 次调用 |
| 数据质量 | 276 条 findings 中 273 条 vuln_type 未填；报告落点分散（沙箱拒写 5 天，工作区/自动报告并存） |

### 1.2 一句话诊断

**当前是"资产维护型"系统，不是"漏洞挖掘型"系统。** 覆盖率和判定纪律是强项；深度攻击链（登录态越权/逻辑/SQLi/XSS）基本空转；"子域 diff=0 多日"更可能是**被动源枯竭的伪收敛**而非真实面收敛。

---

## 二、做得好与做得不好

### 2.1 应保留并固化的

1. **判定纪律**：catch-all 基线差分、认证封闭判定（401/403/参数错误 → huntlist 而非漏洞）、权威 DNS 复核移除、误报闭环 + 负账本、每日复验漂移。直接消灭 SRC 提交中最致命的误报问题。
2. **合规边界硬控**：scope-guard fail-closed、exclude 域硬拒绝、intrusive 需人工、全程代理留痕。
3. **经验沉淀机制**：exp 卡被后续任务 adopt 18 次；playbooks（大厂首扫闭环、N-day 证伪闭环）形成方法论资产。
4. **候选主域核证流程**：web_search 核实归属 → 人工评审 → scope 扩容 13 主域。
5. **调度韧性**：interval 续排、≤3目标/≤600s 派单纪律、meta.json 幂等重跑。

### 2.2 问题清单（按损失排序）

| # | 问题 | 证据 |
|---|---|---|
| 1 | **深度为零**：所有高价值面停在"登录态不可达"，IDOR/越权/逻辑从未真正尝试 | authz_diff 零调用；credentials 表无引用；huntlist 空转 |
| 2 | **工具闲置**：装了不用 = 能力缺口伪装成"没有漏洞" | dalfox/arjun/afrog/graphql-cop/katana/sqlmap 零调用 |
| 3 | **xray 死库**：11.2 万条 flow 无参数提取/敏感信息回扫/未授权重放 | flows/*.jsonl 只增不读 |
| 4 | **知识库闲置**：kb_search 仅 2 次，与实际挖掘脱节 | 224 篇 vs 2 次检索 |
| 5 | **huntlist 无生命周期**：无前置条件/TTL，超期条目无限滚动移交 | 08-26 遗留 4 条到 08-27 仍"需登录态未执行" |
| 6 | **数据规范缺失**：vuln_type 大面积空缺、报告落点不一、证据粒度不均 | 273/276 未填类型；report-*.md 多次空壳 |
| 7 | **资产源单一**：subfinder 实际仅 certspotter 一源工作，diff=0 被误读为收敛 | crt.sh 502、hackertarget 限配额；asnmap/mapcidr/alterx/uncover 未进链路 |
| 8 | **无逐资产×逐漏洞的覆盖记录**：只知道"扫过 nuclei"，不知道"哪个资产测过哪类漏洞、哪类因无功能不适用、哪类被条件阻塞" | 无 attempts 台账 |

---

## 三、资产收集补强清单

按投入产出排序：

| 优先级 | 方法 | 工具/源 | 状态 |
|---|---|---|---|
| P0 | **URL/端点历史挖掘**（域名级→接口级的关键一跃） | waybackurls（已装未用）、gau（仅 7 次）、katana、ParamSpider | 127+276 存活站从未系统性跑 URL 收集 |
| P0 | **JS 端点自动化提取** | subjs + LinkFinder/SecretFinder，或 katana -jc | 手工做过 4 次效果好（CORE_HOST/内网域泄露），须工具化进每日链路 |
| P1 | 被动 DNS 多源 | SecurityTrails、VirusTotal、OTX、urlscan.io、RapidDNS、bevigil；uncover 已装 | 解决单源枯竭 |
| P1 | 证书/空间测绘深化 | censys、fofa/hunter/quake API（fofa.conf、fofa_search.sh 已存在未日常化） | 同证书反查、favicon hash 反查 |
| P1 | 子域爆破+排列 | puredns/dnsx bruteforce + alterx（已装） | 被动源枯竭后的增量主力 |
| P1 | **子域接管排查** | nuclei takeover 模板 / subzy，全量 CNAME 跑一次 | 0 成本高收益，从未做过 |
| P2 | ASN/IP 面 + 端口 | asnmap/mapcidr → naabu → httpx | scope 允许时；T3/ActiveMQ 先例证明价值 |
| P2 | 移动端/小程序 | APK 反编译（jadx）、微信小程序解包、同开发者 App | 美团/字节业务大头在 App 端，纯 Web 收集天然漏 API 面 |
| P2 | 代码泄露面 | GitHub/GitLab 关键词监控、网盘/文库泄露检索 | 找源码、凭据、内部文档 |
| P3 | 云存储桶枚举 | S3/OSS/TOS/COS 桶名爆破 | 配合 JS 提取的桶名（已有 s3.meituan.net 先例） |

---

## 四、流程优化：四级漏斗管线

当前为串行两段式（recon → vuln），建议改为：

```
L1 资产层（每日 recon 保持现状 + 补源）
   域名/IP/端口/存活 → 资产库

L2 接口层（新增，当前缺失——最重要的一层）
   存活站点 → katana/waybackurls/gau → JS 提取 → 参数面清单
   产出 endpoints.tsv（url, method, params, auth_required, source）

L3 工具矩阵层（按指纹/形态自动分派，替代"只跑 nuclei"）
   有参数          → dalfox(XSS) / sqlmap --level 1 --risk 1(SQLi) / arjun(隐藏参数)
   有 GraphQL      → graphql-cop
   CNAME 外部指向  → takeover 检测
   指纹命中组件    → 对应 CVE 模板 + afrog
   登录框          → JWT 分析 / SSO 配置审计 / 登录接口本身的安全测试（见 §7.4）
   表单/上传       → ffuf 路径 + 上传面标记

L4 深度层（需凭据或人工，单独队列）
   登录态越权/逻辑漏洞/业务风控绕过 → huntlist 带前置条件跟踪
```

配套机制改动：

1. **打破"覆盖 100%"幻觉**：覆盖指标从"资产扫过一次"改为**接口层覆盖率**（存活站中完成 URL 收集的比例）+ **漏洞卡覆盖率**（见 §五）。当前 100% 是域名级假饱和。
2. **huntlist 生命周期**：每条带 `precondition`（账号/出口/工具）+ `ttl`（默认 3 天）+ `next_action`。开局先判条件；不满足的进入"创造条件"动作；超 TTL 进"人工/放弃"队列，**禁止无限滚动移交**。
3. **xray 流量激活**（零新增成本）：每日 vuln 链加一步——当日 flows 提取带参数 URL → 去重 → 喂 dalfox/sqlmap；flow 敏感信息正则回扫（token/key/idcard）；未授权 200 API 重放标注。
4. **nuclei 噪音治理**：默认排除 info 级（或独立低优通道），报告默认 severity≥low；命中必须过基线差分（纪律已有，须工具化）。
5. **kb 进流程**：开局强制 `kb_search(当日目标指纹)` 与 exp_search 并行，把"指纹→已知打法"变成机械动作。

---

## 五、资产×漏洞覆盖矩阵规范

### 5.1 问题定义

当前只知道"某资产扫过一次 nuclei"，无法回答：
- 这个资产测过哪些漏洞类型？
- 哪些没测？是因为**没测到**（PENDING）、**无对应功能**（NOT_APPLICABLE）、还是**条件不满足**（BLOCKED，如缺账号）？
- 上次测的时点、工具版本、结论是什么？资产变化后哪些测试需要重跑？

### 5.2 覆盖状态机

每个 `资产 × 漏洞卡` 组合处于且仅处于一个状态：

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `PENDING` | 未测试 | 默认初始态 |
| `TESTED_CLEAN` | 已测，未发现 | 按漏洞卡 detect 流程完整执行且无命中 |
| `CONFIRMED` | 已确认漏洞 | 按漏洞卡 verify 流程确认，生成 finding |
| `FALSE_POSITIVE` | 曾命中但证伪 | verify 阶段证伪，进负账本 |
| `NOT_APPLICABLE` | 无对应功能/前提，不适用 | 资产无该攻击面（须填 `na_reason`，见下） |
| `BLOCKED` | 条件不满足，暂不可测 | 缺凭据/缺出口/风险级超限（须填 `blocker`） |
| `STALE` | 结论过期需重测 | 资产形态变化 / 漏洞卡版本升级 / 超过 retest_after 天数 |

### 5.3 NOT_APPLICABLE 必须填理由（na_reason）

"不适用"不允许裸标，必须从受控词表选值，防止用 N/A 偷懒掩盖漏测：

| na_reason | 说明 | 示例 |
|---|---|---|
| `no-param-surface` | 无查询参数/表单 | 纯静态官网 |
| `no-auth-feature` | 无登录/会话体系 | 公开文档站 |
| `no-upload-feature` | 无文件上传点 | — |
| `no-graphql` | 无 GraphQL 端点 | — |
| `static-site` | 整站静态无后端交互 | 营销页 |
| `scope-excluded` | scope 规则排除 | *.sankuai.com |
| `cdn-edge-only` | 纯 CDN 边缘无源站交互 | 静态资源域 |
| `tech-mismatch` | 技术栈不匹配该漏洞类 | 非 Java 站不测 log4j |

### 5.4 覆盖矩阵的物理形态

不落大宽表（几千资产 × 几十漏洞卡会爆炸），用**稀疏台账**推导：

- 事实层：`attempts-{program}.tsv`（append-only，见 §8.3）
- 视图层：由台账聚合生成 `coverage-{program}-{date}.md`，每日报告引用：

```
## 覆盖矩阵摘要（2026-08-27）
| 漏洞卡 | TESTED_CLEAN | CONFIRMED | N/A | BLOCKED | PENDING |
|---|---|---|---|---|---|
| VC-001 CORS 误配 | 112 | 2 | 8(静态) | 0 | 5 |
| VC-007 未授权访问 | 98 | 0 | 12 | 14(需账号) | 3 |
| VC-012 SQLi | 45 | 0 | 60(无参数面) | 0 | 22 |
| ... |
```

**每日 vuln 任务的开局动作 = 读 PENDING/BLOCKED/STALE 清单**，而不是重新盘点全部资产。这从机制上保证"每个资产最终都被每张适用的卡测过"，且 BLOCKED 条目集中暴露了"补什么条件能解锁多少测试面"（如：补 1 个美团账号可解锁 N 条 BLOCKED）。

### 5.5 重测触发（STALE 规则）

- 资产 title/指纹/状态码变化 → 该资产全部 TESTED_CLEAN 转 STALE
- 漏洞卡版本升级（见 §6.5）→ 引用旧版的记录转 STALE
- 超过卡的 `retest_after`（如 CORS 30 天、敏感路径 7 天）→ STALE

---

## 六、漏洞卡片（VulnCard）规范

### 6.1 目标

把"每种漏洞怎么探测、怎么验证、什么条件下适用"从模型记忆和散落经验中抽出来，变成**版本化、可迭代、被强制使用的卡片库**。每次实战使用卡片后必须反馈：卡片有没有要改的地方。

### 6.2 卡片 Schema

建议存放：`/opt/silkspool/dsh/data/vulncards/VC-xxx-{slug}.yaml`（或并入 playbooks 体系，关键是版本化）。

```yaml
id: VC-001
name: CORS 任意起源反射
cwe: CWE-942
version: 3
status: active            # active / draft / deprecated
severity_potential: [low, medium]   # 该漏洞在本类目标上的现实定级区间
risk_level: passive       # passive / active / intrusive（与 scope-guard 对齐）

# ---- 适用性判定（决定矩阵中 PENDING 还是 NOT_APPLICABLE）----
applicable_when:
  - 响应包含 ACAO 头或存在跨域 API 端点
  - 存在鉴权会话（Cookie/Token）的域
not_applicable_when:
  - na_reason: static-site
  - na_reason: cdn-edge-only

# ---- 前置条件（不满足则 BLOCKED）----
prerequisites:
  egress: 任意            # 任意 / 国内出口 / 固定IP
  auth: none              # none / single-account / dual-account
  tools: [curl]

# ---- 探测（detect）----
detect:
  summary: 多 Origin 差分 + ACAC 联合判定
  steps:
    - 无 Origin 基线请求，记录 ACAO/ACAC
    - Origin: https://evil.example.net，观察是否反射
    - Origin: null / 子域绕过 / 后缀绕过（evil{domain}）变体各一次
  tool_cmd: "bash/curl 差分（禁止用 nuclei cors 模板单独定论）"
  fp_baseline: 反射但 ACAC:false 且无敏感数据 → 降级 info 或不报

# ---- 验证（verify，确认必须全过）----
verify:
  must_pass:
    - 反射 Origin 与请求 Origin 精确一致（非 *）
    - ACAC: true 或响应含敏感数据
    - 连续 ≥2 次复现（间隔换出口）
  falsification:
    - catch-all/网关统一反射检查（对 404 路径同样反射 → 边缘行为，降级）
  evidence_required: [request.txt, response.txt, 复现x2记录]

# ---- SRC 提交要点 ----
src_notes: |
  美团/字节对纯 CORS 反射定级多为 low；需说明可窃取的数据类型才有 medium 可能。
  报告须附可利用的端点实际返回的敏感字段示例。

# ---- 运维字段 ----
retest_after_days: 30
usage_count: 9            # 每次使用 +1
hit_count: 2              # 每次 CONFIRMED +1
last_used: 2026-08-27
changelog:
  - v3 2026-08-26: 增加"404 路径对照"证伪步骤（字节边缘网关误报教训）
  - v2 2026-08-22: 增加 null origin 变体
```

### 6.3 首批应建立的卡片清单

| ID | 漏洞类 | 探测主力 | 风险级 |
|---|---|---|---|
| VC-001 | CORS 误配 | curl 差分 | passive |
| VC-002 | 子域接管 | nuclei takeover / subzy | passive |
| VC-003 | 敏感路径暴露（actuator/swagger/.git/api-docs） | ffuf 专项字典 + 基线差分 | active |
| VC-004 | 反射/存储 XSS | dalfox + 人工复核 | active |
| VC-005 | SQL 注入 | sqlmap --level 1 --risk 1（限速） | active |
| VC-006 | CRLF 注入 | crlfuzz | active |
| VC-007 | 未授权访问（API/管理面） | 路径遍历 + 方法变换 + 鉴权头摘除 | active |
| VC-008 | 越权 IDOR（水平/垂直） | authz_diff 双账号差分 | active（需凭据） |
| VC-009 | SSRF | URL 取参端点 + 内网探针 | active |
| VC-010 | GraphQL 内省/滥用 | graphql-cop | active |
| VC-011 | JWT 弱密钥/算法混淆 | jwt_tool 类 | active（需 token） |
| VC-012 | OAuth/SSO 逻辑（redirect_uri/state/code 重放） | 手工 + 浏览器 | active |
| VC-013 | 文件上传绕过 | ffuf + 手工变形 | active |
| VC-014 | 信息泄露（JS 密钥/源码 map/备份文件/云桶） | SecretFinder + ffuf + 桶枚举 | passive |
| VC-015 | 登录接口安全（爆破保护/短信轰炸/验证码绕过/账号枚举/密码重置逻辑） | 手工 + 限速脚本 | active（无需账号，见 §7.4） |
| VC-016 | N-day 组件漏洞 | nuclei/afrog 模板 + 前提校验 | 按模板定 |
| VC-017 | 业务逻辑（价格/数量/重放/竞态） | 手工 + 并发脚本 | active（需凭据） |
| VC-018 | 中间件暴露面（T3/AJP/ActiveMQ 等非常规端口） | naabu + 协议探针 | active |

每张卡的 detect/verify 内容应从本次复盘已沉淀的方法论初始化（如 catch-all 基线差分、Supabase 五端点验证法、456 反爬识别等），后续在使用中迭代。

### 6.4 卡片使用反馈环（强制）

每次任务使用卡片后，在当日 attempts 台账之外，追加一条**卡片使用记录**：

```
card_usage-{date}.jsonl:
{"card_id":"VC-001","asset":"e.waimai.meituan.com","result":"CONFIRMED",
 "card_version":3,"deviation":"发现该站对 origin 后缀绕过也反射，卡片未覆盖",
 "suggest":"detect.steps 增加 evil{domain} 后缀变体"}
```

**卡片修订触发器**（满足任一即应更新卡片版本）：
1. 实战中出现卡片未覆盖的绕过/变体 → 补 detect 步骤
2. 出现误报且卡片 falsification 未能拦截 → 补证伪步骤
3. 同一卡连续 `usage_count` ≥ 20 而 `hit_count` = 0 → 评审：是目标面问题还是探测方法失效（如 WAF 规则更新），必要时降低优先级或标 deprecated
4. intel/kb 出现新技术（新绕过手法、新工具）→ 相关卡升级
5. SRC 平台对该类漏洞的收录政策变化 → 更新 src_notes

**纪律：卡片修订必须 bump version + 写 changelog**；版本升级触发引用旧版的覆盖记录转 STALE（§5.5），形成"方法改进 → 自动重测"的正循环。

### 6.5 与现有体系的关系

- playbooks = **跨漏洞的流程级方法论**（如"大厂首扫闭环"）；VulnCard = **单漏洞的探测/验证规程**。两者互补，不合并。
- exp 经验卡偏"软性经验"，VulnCard 是"硬性规程"——每日 vuln 任务契约应直接引用当日待执行的卡片 ID 清单。

---

## 七、登录态测试方法论与账号获取策略

### 7.1 先纠正一个认知偏差：按"登录后增益"给资产分级

观察正确：很多前台站点登录/未登录区别不大。因此**不要为所有资产搞账号**，而是给资产打 auth-value 分级，只向高增益面投入账号成本：

| 分级 | 特征 | 示例（实测面） | 策略 |
|---|---|---|---|
| A 级（必投） | 登录后暴露全新功能面：管理后台/商家端/运营端/API 控制台/开发者平台 | admin.erp、cloud-erp、livehub 40+ 端点、keeservice 工作台、lbs 控制台、saiyan/live_console、carrier proxy 网关 | 集中资源搞账号 |
| B 级（选投） | 登录后多个人数据/订单/消息面，IDOR 价值高 | waimai 订单、火山开发者中心 user 系列端点 | 有现成账号就挂 |
| C 级（不投） | 登录/未登录几乎同面 | 官网、营销页、文档站、静态站 | 不投入，标 na_reason=no-auth-feature 或直接维持匿名测试 |

### 7.2 账号获取的七条路径（按可行性排序）

**路径 1：可自行注册的公开入口（成本最低，优先穷尽）**
- 美团：美团/点评 C 端账号（手机号）、美团开放平台开发者、美团商家版（个体户资质可试）、快驴/优选等业务线注册入口、Keeta 海外站（邮箱即可）。
- 字节：抖音 C 端、巨量引擎/巨量百应试用、火山引擎个人试用（送额度，ark/console 面直接解锁）、coze 国内版、Trae 开发者账号。
- **每个 A 级资产先回答一个问题："它的注册入口在哪？"** 把"找注册入口"本身作为 recon 任务（搜 "域名+注册/试用/开放平台/开发者"），产出注册可行性清单交人工执行。

**路径 2：一个主账号打通生态（SSO 乘数效应）**
- 美团通行证（unitivelogin SSO，08-27 已测绘出完整链路）一号通多子系统；字节通行证同理。**1 个主账号的实际覆盖远超 1 个系统**，优先打通。

**路径 3：开放平台/沙箱/试用凭据**
- 开发者平台 API Key、沙箱环境、免费试用额度，往往能拿到合法 token 直接测 API 面（lbs 控制台 /api/key/*、火山引擎 Ark 均属此类）。

**路径 4：无法注册时的"无账号登录态测试"（重要，常被忽略）**
登录接口本身就是攻击面，**不需要账号**：
- 账号枚举（登录/注册/找回密码响应差异）
- 短信/邮件轰炸（频率限制缺失）
- 验证码绕过（复用、万能码、响应包泄露）
- 密码重置逻辑（token 可预测、未绑定校验）
- 爆破/撞库保护缺失（限速脚本低频探测，注意合规）
- SSO/OAuth 配置缺陷（redirect_uri 白名单、state 缺失）
- 默认口令/弱口令仅对**测试环境/自有靶场**做，生产 SRC 谨慎

**路径 5：泄露凭据的合规利用（灰色转白）**
- GitHub/网盘/公开文档中泄露的测试账号、demo 账号（很多后台有 demo/demo123 类公开演示账号，属厂商自暴露）
- JS bundle 中的测试凭据（已有 JS 测绘管线，加 SecretFinder 规则）
- **红线：仅使用"厂商自暴露"的凭据；绝不使用拖库/暗网凭据，绝不登录真实用户账号**。发现泄露凭据本身即可作为信息泄露漏洞提交。

**路径 6：邀请制系统的合规申请**
- 企业试用（销售通道、edu/企业邮箱申请）、内测申请、问卷招募。把候选列成清单交人工，人每周花 30 分钟批量申请。

**路径 7：放弃并标注**
- 确实无路的（纯内部系统外网暴露面），标 `BLOCKED(blocker=no-registration-channel)`，转入"登录面测试"（路径 4）+ 定期复评。**不让它无限占 huntlist。**

### 7.3 账号资产的管理规范

- 凭据入 credentials 表，字段：`program / system / account_type(self-registered|demo|leaked-public) / risk_ack / scope_binding`
- scope.yml rules 关联：凭据仅用于对应 program
- **双账号原则**：测水平越权必须同系统 2 个账号（A 创建资源，B 访问 A 的资源 ID），注册时即成对注册
- 测试数据隔离：只用自己创建的测试数据做 IDOR/逻辑测试，绝不触碰真实用户数据（SRC 通用红线，写进卡片 prerequisites）
- 会话维持：shared-browser profile 持久化登录态 + xray 7777 挂为浏览器代理 → **一次打通"认证爬虫 → 被动扫描 → authz_diff 越权差分"**；cookie 失效自动告警转人工重登

### 7.4 登录后的挖掘方法（有账号后干什么）

1. **功能全覆盖爬虫**：katana/浏览器带会话爬全功能面，流量全过 xray → 被动扫描 + 参数面沉淀
2. **authz_diff 双账号差分**：同一请求换 B 账号凭证重放，响应数据归属比对 → 水平越权；摘除/降级凭证 → 垂直越权
3. **对象 ID 遍历**：user_id/order_id/doc_id/coupon_id 数字/短哈希枚举（限速），重点关注 JS 已泄露的真实 ID 作为种子
4. **业务逻辑**：价格/数量篡改、负值、重放、竞态（单端点并发 N 请求）、优惠券/积分规则绕过
5. **GraphQL/批量接口**：内省、字段遍历、批量别名滥用
6. **管理面特有**：角色权限矩阵（低权账号访问高权端点）、审计日志缺失、导出接口未脱敏

---

## 八、输入/输出规范与会话接力

### 8.1 开局包（输入规范）

每会话不再自由盘点，读固定结构 `brief-{program}-{date}.md`：

```
## 昨日状态
- 存活/新增/移除资产数（数字指针）
- PENDING/BLOCKED/STALE 覆盖清单（§5.4 聚合视图）
- 复验到期 finding 清单
## 今日硬指标
- recon: diff 三数 + 新增资产 100% 形态确认
- vuln: 指定漏洞卡 × 指定资产批次的执行清单、kb_search ≥2 次、
        huntlist 条件判定 100%、卡片使用记录落盘
## 禁止项
- 负账本条目清单/查询式（禁止重跑）
- info 级噪音进 findings
```

### 8.2 资产台账（recon 必输出）

`assets-{program}.tsv`（append-only，单一权威源，替代当前 probe-out 四代并存）：

```
domain  ip  cname  status  title  tech  first_seen  last_seen  source  probe_date  egress_note
```

配套每日 `asset-diff-{date}.md`：新增/漂移/移除三表。

### 8.3 漏洞尝试台账（vuln 必输出，当前完全缺失）

`attempts-{program}.tsv`（append-only）：

```
ts  asset  endpoint  card_id  card_ver  tool  result  na_reason/blocker  evidence_path  run_id
2026-08-27T04:12  e.waimai.meituan.com  /api/x  VC-001  3  curl-diff  CONFIRMED  -  ev/287/  wmt9xxx
2026-08-27T04:20  cloud-erp.meituan.com  /actuator/*  VC-003  1  ffuf  TESTED_CLEAN  -  tmp/cloud-erp.tsv  bash-3
2026-08-27T04:30  kat.test.meituan.com  -  VC-004  1  dalfox  NOT_APPLICABLE  static-site  -  -
2026-08-27T04:35  admin.erp.meituan.com  /api/*  VC-008  1  authz_diff  BLOCKED  no-credential  -  -
```

`result ∈ {TESTED_CLEAN, CONFIRMED, FALSE_POSITIVE, NOT_APPLICABLE, BLOCKED}`。覆盖矩阵由此聚合（§5.4）。

### 8.4 Finding 证据包（可提交性留痕）

每条 finding 强制目录化 `evidence/{finding_id}/`：

- `request.txt` / `response.txt`：原始报文，含时间戳与出口 IP
- `reproduce.md`：编号复现步骤，**直接可贴进 SRC 提交框**
- `screenshot.png`：browser 插件已有，应强制
- `verify-log.md`：每次复验追加一行（时间/出口/结果/响应哈希）

finding 字段补全：`vuln_type`(CWE)、`severity`、`affected_url`、`param`、`poc_summary`、`src_ready`(bool)。存量 273 条缺类型的回填至少到类型级。

### 8.5 会话交接包（接力复用）

每日收尾产出 `handoff-{program}-{date}.md`，固定五段：

```
1. 状态快照：资产数/覆盖矩阵摘要/未闭环项（全指针，不内联数据）
2. 今日动作摘要：attempts 行数 + 关键结论 ≤10 行
3. 明日队列：huntlist（含 precondition/ttl/next_action）
4. 阻塞与求助：需人工事项（账号申请、授权、intrusive 批准）——按"解锁多少 BLOCKED"排序
5. 数据指针：所有产物绝对路径清单
```

下一会话任务提示只需引用 handoff 路径 + brief，不翻全量黑板（顺带解决黑板键 60+、开局重复全量检索的 token 浪费）。

---

## 九、落地路线图

| 期 | 动作 | 预期收益 |
|---|---|---|
| 第一周 | ① attempts 台账 + handoff 交接包 + brief 进任务契约；② nuclei info 噪音隔离；③ 存量 findings 回填 vuln_type；④ 首批 18 张漏洞卡骨架（从既有方法论初始化） | 留痕/接力/覆盖可见性立即改善，成本≈0 |
| 第二周 | ⑤ L2 接口层管线（katana+waybackurls+gau+JS 提取工具化）；⑥ xray flows 每日消费（参数→dalfox/sqlmap、敏感信息回扫）；⑦ 子域接管全量扫一次（VC-002 首跑） | 域名级→接口级，工具矩阵转动 |
| 第三周 | ⑧ 被动源扩容（uncover/fofa API 日常化）；⑨ huntlist 生命周期（precondition/ttl）；⑩ kb 开局强制检索；⑪ 卡片反馈环机制化 | 破资产伪收敛，卡片开始自我进化 |
| 持续（需人配合） | ⑫ **凭据策略**：按 §7.2 路径 1/2/3 注册双项目成对测试账号 → 浏览器挂 xray → authz_diff；把"注册入口侦察"列入 recon 任务，每周交人工一批申请清单 | 唯一能带回 high/medium 产出的动作，解开 90% BLOCKED |

### 关键原则

1. **覆盖率的新定义**：不是"资产扫过一次"，而是"每个资产 × 每张适用的漏洞卡都有终态结论，且有台账可查"。
2. **BLOCKED 不是垃圾桶**：每个 BLOCKED 必须写明解锁条件，且汇总成"人工待办"按解锁收益排序——这把"需要人做什么"变成了精确的最小请求。
3. **卡片是活的**：每次使用都是一次评审机会；方法改进通过版本号自动触发重测，经验不再随会话结束而流失。
4. **留痕即接力**：attempts + handoff + 证据包三件套，保证任何新会话（或换人）能在 5 分钟内接续到上一次的精确断点。

---

*本文档基于 2026-08-27 对 csai 的只读检查生成，未对远端做任何变更。修订时请注意同步更新相关章节。*
