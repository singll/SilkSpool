# 02 · vuln 域设计（漏洞信号 / 候选队列 / 证据 / 提交）

> 版本：v5.0 ｜ 状态：草案
> 依赖：**遵守** [`00-conventions.md`](00-conventions.md)（全局契约宪法，冲突以它为准）；被总线 `@silksec/sec-domain-bus` 宿主挂载。
> 订阅（本域消费）：`exec.run.completed`（parser proposal 机器直灌分流）。
> 被订阅（本域发布）：`vuln.candidate.registered / vuln.candidate.promoted / vuln.candidate.claimed / vuln.signal.registered / vuln.signal.confirmed / vuln.signal.rejected / vuln.signal.submitted`——消费方：eval 域（判定回流）、fgs 域（节点状态联动）、report 域（提交统计）、asset 域（总览缓存失效）。
> 契约版本：manifest `version: 1`（repository 接口 `repository-v1`）。
> 定位：**v5 试点域**——总线抽象的表达力在此域先行验证；候选池状态机是 v5 对 v4.x 实证缺陷（2026-09-06「执行确认但待验证候选不消减」，31 条 confirmed 僵君 + 25 条终态滞留）的根治点。

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| cordis 服务名 | `secDomain.vuln`（`ctx.provide('secDomain.vuln', service)`） |
| 域插件包 | `@silksec/sec-domain-vuln` |
| 后端插件包 | `@silksec/sec-backend-vuln-sqlite`（默认）/ `@silksec/sec-backend-vuln-http`（Phase 4） |
| 后端切换 | bundle 配置一行：`sec_domain_vuln_backend: sqlite-local` 或 `http-remote`；运行时热切换仅允许 sqlite↔sqlite，切 http 需重启宿主面（连接池初始化） |
| profile 挂载 | **web 与 headless 双面挂载**（worker 要登记/确认/认领候选；双面各自实例化域服务，SQLite WAL 跨进程，写收敛于各进程内 CommandGateway——与 README §六取舍一致） |
| owns（单写者律） | 表：`findings`（asset-graph.db，**不改名不迁库**，sqlite-local 后端直接接管现表）；文件：`data/evidence/{finding_id}/`（证据包目录树 + verify-log.md 追加写，C9）。**不 own 任何 md 报告文件**——提交草稿归 report 域（12-report.md 方案 A：report owns `reports/` 全树含 `submissions/`；v4 工具 `submission_draft` 经总线别名指向 `report_draft_submission`，本域契约不再含草稿动词） |
| owns × 沙箱白名单 | setup.sh 冒烟交叉断言：asset-graph.db 与 `data/evidence/` 对 run_cli 沙箱不可写 |
| 模型禁入通道 | `vuln_register_candidate`（机器直灌）根本不向模型注册工具——负向保障第一层（宪法 §三.2） |

### 1.2 命令（写动词）总表

| # | 动词 | 一句话语义 | actor 白名单 | 发布事件 | 幂等键 |
|---|---|---|---|---|---|
| C1 | `vuln_register_signal` | 登记完整漏洞信号（五要素闸门为不变量；弱指纹命中候选自动 promote） | model, human | signal.registered（命中候选时另发 candidate.promoted） | 自然键=强指纹 |
| C2 | `vuln_register_candidate` | 机器直灌唯一入口（候选池登记，模型禁用） | webhook, script | candidate.registered | 自动指纹（title/host/url/source） |
| C3 | `vuln_confirm` | 候选/信号 → confirmed 原子升级（status+confidence+noise 三联动，evidence 必填） | model, dashboard | signal.confirmed（自候选池另发 candidate.promoted） | 自动指纹（finding_id+evidence_ref） |
| C4 | `vuln_reject` | 判定 false_positive / dup / ignored（候选出池 + FGS deprecated 走事件） | model, dashboard | signal.rejected | 自动指纹（finding_id+verdict+reason） |
| C5 | `vuln_submit` | confirmed → submitted（运营列回流；vendor_status=accepted 时 submitted → accepted） | model, dashboard | signal.submitted | 自动指纹（finding_id+bounty+vendor_status+platform） |
| C6 | `vuln_note` | 证据链追加（不改状态，任意状态可用） | model, dashboard | 无（防事件风暴） | 自动指纹（finding_id+note） |
| C7 | `vuln_claim` | 认领候选（防多 worker 重复验证，TTL 软锁） | model, dashboard | candidate.claimed | 自动指纹（finding_id+认领者） |
| C8 | `vuln_release` | 释放认领 | model, dashboard | 无（认领状态经 vuln_candidates 查询可见） | 宽松幂等（重放返回 ok） |
| C9 | `vuln_verify_replay` | CONFIRMED 机械复核（重放 request.txt + sha256 比对 + verify-log 追加；"LLM 不给自己当法官"） | model, script | 无（防事件风暴） | 自动指纹（finding_id+expect_hash+分钟） |
| C10 | `vuln_attach_fgs` | 关联 FGS finding 节点到行（fgs 域事件订阅回写通道，Phase 1 可选落地） | model, reactor | 无 | 自动指纹（finding_id+fgs_node_id） |

> 说明：宪法 §三 actor 表无 `parser` 类型——exec 域 parser 提案与 authz_diff 机器判定统一以 **actor=script** 注入，身份细分（`identity: "parser:nuclei:{run_id}"` / `"authz_diff:{session_id}"`）进审计，不新增 actor 枚举。

### 1.3 命令逐个详述

#### C1 · vuln_register_signal（登记完整漏洞信号）

**语义**：替代 v4 `finding_add` 的模型登记路径。这是唯一能让新行直接进入信号面（noise=0）的登记动词。五要素完整性闸门从 `addFinding` 函数体内的 if（v4.2，靠调用纪律）升级为网关不变量——不完整的登记在 v5 是 **E_INVARIANT 类型错误**，不是「自动降级为候选」（降级通道只保留给机器 actor 的 `vuln_register_candidate`）。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| title | string | 是 | — | trim 后 ≥10 字符（INV-4a）；不得为工具原始输出（`<scanner>: <plugin>` 形状由网关正则拦：`^[a-z0-9_-]+: ?\w+$` 低信息形状 → E_VULN_INCOMPLETE） |
| severity | string(enum) | 是 | — | critical/high/medium/low/info；**info → E_INVARIANT（E_VULN_INFO_SEVERITY）**：info 级模板指纹/侦察副产物不进信号面（v4 噪声闸门语义保留并收紧为拒绝） |
| host | string | 是 | — | 非空；网关归一化（去 scheme/端口/路径，小写）后入库 |
| url | string | 否 | '' | 合法 URL 或空 |
| evidence | string | 是 | — | 非空；须含证据引用（run_id / flow_id / burp_item / evidence/ 路径之一，正则 `run_\|flow:\|burp_item\|evidence/`）；不满足 → E_EVIDENCE_REQUIRED |
| reproduction_steps | string | 是 | — | trim 后非空（INV-4b） |
| impact | string | 是 | — | trim 后非空（INV-4c） |
| source | string | 否 | 'agent' | 登记来源标识 |
| vuln_type / cwe / endpoint_ref / preconditions / recommendation | string | 否 | null | 补全提交模板列 |
| confidence | string(enum) | 否 | 'tentative' | tentative/confirmed/false_positive/dup |
| fgs_node_id | integer | 否 | null | 调用方显式传入（v4 自动创建逻辑改为 fgs 域订阅 signal.registered，见 §二.3） |
| discovery_step | string | 否 | null | 发现步骤快照（P17 语义保留） |
| idempotency_key | string | 否 | — | 显式幂等键（推荐） |

**事务行为**（单事务 BEGIN IMMEDIATE）：

1. 计算强指纹 `fpStrong = sha1("{host}|{title}|{url}")`、弱指纹 `fpWeak = sha1("{host}|{title}")`（**算法与 v4 完全一致，迁移零成本**）；
2. `fpStrong` 命中已有行 → 幂等返回 `{id, dup: true}`（同参 replay / 异参 E_IDEMPOTENT_CONFLICT）；
3. `fpWeak` 命中 noise=1 的候选行 → **自动 promote**：单 UPDATE 补齐字段、fingerprint 换强指纹、`noise=0`，返回 `{id, upgraded: true}`，发 `candidate.promoted`（cause_cmd=vuln_register_signal）；
4. 否则 INSERT 新行：`noise=0, status='new', confidence=COALESCE(?, 'tentative')`，发 `signal.registered`。

**返回信封示例**：

```json
{
  "ok": true, "domain": "vuln", "cmd": "register_signal",
  "data": { "id": 343, "dup": false, "upgraded": false, "noise": false, "status": "new" },
  "event_ids": ["evt_01J..."],
  "idempotency_key": "vuln:register_signal:a3f9c...",
  "replay": false
}
```

**错误码**：

| code | 触发 | hint（写给模型的纠错指引） | retryable |
|---|---|---|---|
| E_VULN_INCOMPLETE | 五要素缺失（title<10 字符 / 复现或影响为空 / 低信息标题形状） | "信号登记要求五要素完整（规范标题≥10 字符、复现步骤、具体影响、证据引用、host）。机器产出或不完整观察请勿用本动词；完成对抗性自检与双出口复现后再登记" | false |
| E_VULN_INFO_SEVERITY | severity=info | "info 级侦察副产物不进信号面。如确有安全价值，按 rules/src/severity-rating.md 重新定级（信息泄露默认低危）后以 low+具体影响登记" | false |
| E_EVIDENCE_REQUIRED | evidence 缺失或无证据引用 | "证据必须是 run_id/flow_id/burp_item/evidence 路径引用，无证据不结论（sec-verification 铁律）" | false |
| E_IDEMPOTENT_CONFLICT | 同强指纹异参重放 | "该发现已登记（同 host+title+url）。补充信息用 vuln_note；字段勘误用 vuln_note 附勘误说明" | false |
| E_SCHEMA / E_ACTOR_FORBIDDEN | 见宪法 | — | false |

**actor**：model, human。**agent_note（RoE 摘要，即工具描述全文）**：见 §1.6。

---

#### C2 · vuln_register_candidate（机器直灌唯一入口）

**语义**：xray webhook、exec parser 提案、authz_diff suspected 启发式等**机器产出**的候选登记。模型禁用（E_ACTOR_FORBIDDEN——"机器直灌不冒充漏洞信号"从闸门 if 升级为接口不存在）。缺复现/影响的登记天然落候选池（noise=1, status='new'），后续经 `vuln_confirm` 或 `vuln_register_signal` 弱指纹命中升级。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| title | string | 是 | — | 非空（机器标题规范：`<host> 被动审计候选：<插件>` / `疑似越权(IDOR): <METHOD> <url>` 等，由调用方构造） |
| severity | string(enum) | 是 | — | critical/high/medium/low/info（info 在候选通道合法——候选本就是待验证池） |
| host | string | 是 | — | 非空，网关归一化 |
| url | string | 否 | '' | — |
| evidence | string | 否 | '' | 机器证据指针（如 `flow:flows/xray-2026-09-06.jsonl`） |
| source | string | 是 | — | 机器来源标识（xray-webhook / authz_diff / parser:nuclei / parser:afrog …），必填以便追溯 |
| program_id | string | 否 | null | — |
| session_id | string | 否 | null | 网关从调用面注入（不信任参数声明） |
| idempotency_key | string | 否 | — | — |

**事务行为**：弱指纹 `fpWeak = sha1("{host}|{title}")`；命中已有行 → **宽容返回** `{id, dup: true}`（不报错、不覆盖——机器通道不因指纹冲突丢数据，v4 语义保留）；未命中 → INSERT `noise=1, status='new', confidence='tentative'`，发 `candidate.registered`。

**返回信封示例**：

```json
{
  "ok": true, "domain": "vuln", "cmd": "register_candidate",
  "data": { "id": 344, "dup": false, "noise": true, "status": "new" },
  "event_ids": ["evt_01J..."],
  "idempotency_key": "vuln:register_candidate:3c1b...",
  "replay": false
}
```

**错误码**：

| code | 触发 | hint | retryable |
|---|---|---|---|
| E_ACTOR_FORBIDDEN | actor=model（或 dashboard/human） | "机器直灌通道仅限 webhook/script。模型请走 vuln_register_signal（完整信号）或对已有候选用 vuln_confirm" | false |
| E_SCHEMA | 缺 source/title/host/severity | — | false |

**幂等**：自动指纹（title/host/url/source 核心字段）；webhook 重复投递同 payload → replay:true；同指纹不同 payload → 不报错走 dup:true 宽容路径（与 C1 的严格路径刻意不同：**模型通道严格、机器通道宽容**）。

---

#### C3 · vuln_confirm（候选 → 信号原子升级）

**语义**：v4 缺陷的根治动词。v4 `updateFinding` 只改 status/confidence/FGS/eval 回流、**从不触碰 noise 列**——确认后的候选变成 `status=confirmed AND noise=1` 僵君（2026-09-06 实测 31 条）。v5 把 `status='confirmed' + confidence='confirmed' + noise=0 + 认领清空` 收进**同一条 UPDATE 语句**（单事务原子），并必然发事件。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| finding_id | integer | 是 | — | 行存在（E_NOT_FOUND） |
| evidence | string | 是 | — | 证据引用且**真实存在**（INV-2，网关校验：`run_<id>` → `results/<run_id>/meta.json` 存在；`evidence/<finding_id>/` 目录存在；`flow:` 前缀 → 对应 flows 文件存在）。缺 → E_EVIDENCE_REQUIRED |
| note | string | 否 | '' | 确认说明（追加进证据链） |
| idempotency_key | string | 否 | — | — |

**事务行为**：

```sql
-- 单语句原子三联动 + 终态守卫 + 认领清空（changes=0 即 E_STATE）
UPDATE findings SET
  status='confirmed', confidence='confirmed', noise=0,
  claimed_by=NULL, claimed_at=NULL, updated_at=?
WHERE id=? AND status='new'
```

随后若 note 非空追加证据链；提交成功发 `signal.confirmed`（恒发）+ `candidate.promoted`（当且仅当原行 noise=1——manifest `event_limit: 2`）。

**返回信封示例**：

```json
{
  "ok": true, "domain": "vuln", "cmd": "confirm",
  "data": { "id": 341, "status": "confirmed", "signal": true, "promoted_from_candidate": true },
  "event_ids": ["evt_01J...", "evt_01J..."],
  "idempotency_key": "vuln:confirm:9e2d...",
  "replay": false
}
```

**错误码**：

| code | 触发 | hint | retryable |
|---|---|---|---|
| E_EVIDENCE_REQUIRED | evidence 缺失或引用不存在 | "确认必须附真实存在的证据引用（run_id 的 results 目录 / evidence/{id}/ 证据包）。CONFIRMED 还须 verify_replay 机械复核通过" | false |
| E_STATE | 行非 status='new'（终态再流转/已 confirmed） | "finding #N 已处于终态/已确认，不可再次流转。补证据用 vuln_note；提交用 vuln_submit" | false |
| E_VULN_CLAIMED | 候选被其他会话活跃认领（且 actor=model） | "该候选正被会话 {claimed_by} 验证（认领于 X 分钟前）。请挑 vuln_candidates 中下一条 available 候选" | true |
| E_NOT_FOUND | — | — | false |

**actor**：model, dashboard。dashboard（人工终审通道）**跳过认领校验**（认领是 worker 协作软锁，人工兜底可越——审计高亮 operator）。**幂等**：自动指纹（finding_id+evidence）。

---

#### C4 · vuln_reject（判定 false_positive / dup / ignored）

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| finding_id | integer | 是 | — | 行存在 |
| verdict | string(enum) | 是 | — | false_positive / dup / ignored（E_SCHEMA） |
| reason | string | 是 | — | trim ≥10 字（与 v4 审批 evidence 同口径——判定必须有可追溯依据） |
| dup_of | integer | 否 | null | **verdict=dup 时必填**（INV-9，指向被重复的 finding id；不存在 → E_NOT_FOUND） |
| note | string | 否 | '' | — |

**事务行为**（单 UPDATE）：

```sql
UPDATE findings SET
  status=?,                                  -- verdict
  confidence=CASE ? WHEN 'ignored' THEN confidence ELSE ? END,  -- fp→false_positive, dup→dup, ignored 不变
  claimed_by=NULL, claimed_at=NULL, updated_at=?
WHERE id=? AND status IN ('new','confirmed','submitted')
```

noise 列不动：候选行（noise=1）保持 noise=1，但 `status≠'new'` 保证其退出候选计数（**候选池 KPI 口径 = `noise=1 AND status='new'`，宪法 §十一全局定义**）。发 `signal.rejected`。

**错误码**：

| code | 触发 | hint | retryable |
|---|---|---|---|
| E_SCHEMA | verdict 非枚举 / reason<10 字 | "verdict 只能是 false_positive/dup/ignored；reason 必须 ≥10 字（判定依据可追溯）" | false |
| E_VULN_DUP_TARGET_REQUIRED | verdict=dup 缺 dup_of | "dup 判定必须指回被重复的 finding（dup_of）。可先用 vuln_dedup_check 检索同目标同类型历史" | false |
| E_STATE | 行处于 accepted / false_positive / dup / ignored 终态 | "已终态不可再流转；如需翻案（如 false_positive→confirmed）走人工通道：dashboard 侧 vuln_confirm 附 operator 审计" | false |
| E_VULN_CLAIMED | 同 C3（model 受认领约束） | 同 C3 | true |

**actor**：model, dashboard。**幂等**：自动指纹（finding_id+verdict+reason）。

---

#### C5 · vuln_submit（提交与运营回流）

**语义**：合并 v4 `finding_update status=submitted/accepted` 与 bounty/vendor_status 运营列写入（v4 里散落在 updateFinding 的可选 sets 段）。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| finding_id | integer | 是 | — | 行存在 |
| platform | string | 否 | '' | 平台名（美团SRC / 字节SRC） |
| bounty | number | 否 | null | ≥0 |
| vendor_status | string(enum) | 否 | '' | submitted/pending/accepted/rejected/duplicate/not_rewarded |
| submission_url | string | 否 | '' | 平台工单链接 |
| note | string | 否 | '' | — |

**事务行为**（两段合法流转，其余 E_STATE）：

| from | to | 条件 |
|---|---|---|
| confirmed | submitted | 无条件（`submitted_at=COALESCE(submitted_at, now)`） |
| submitted | submitted | 仅更新运营列（bounty/vendor_status/submission_url）——状态机自环，运营回流 |
| submitted | accepted | vendor_status='accepted' 时 |
| 其他（new/false_positive/dup/ignored/accepted） | — | E_STATE |

发 `signal.submitted`。**幂等**：自动指纹（finding_id+bounty+vendor_status+platform）。**actor**：model, dashboard。

**错误码**：E_STATE（hint："提交前必须先 vuln_confirm；vendor 翻案（accepted→重复/驳回）用 dashboard 通道 vuln_submit 附 operator 审计"）；E_SCHEMA。

---

#### C6 · vuln_note（证据链追加）

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| finding_id | integer | 是 | — | 行存在 |
| note | string | 是 | — | trim 非空 |
| evidence_ref | string | 否 | '' | 同 C3 的引用格式校验（不校验存在性——note 允许记录观察线索） |

**行为**：`evidence = evidence + "\\n[北京ISO] note: {note}"`（沿用 v4 时间戳前缀格式）；不改 status/noise/confidence。**任意状态可用**（终态行补证据是合法的——它是登记型动词不是流转动词，不违反铁律 1）。无事件。**幂等**：自动指纹（finding_id+note）——同文本重复追加按重放处理。**actor**：model, dashboard。

---

#### C7 / C8 · vuln_claim / vuln_release（候选认领）

**语义**：候选池成为一等公民工作队列后的协作锁——多 worker（每日 vuln 任务、spawn_worker 派生）并发消化候选时防重复验证。软锁：TTL 过期自动可抢占，无需显式释放。

**vuln_claim 参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| finding_id | integer | 是 | — | 行存在且 `noise=1 AND status='new'`（否则 E_VULN_NOT_CANDIDATE） |

**行为**（单 UPDATE 原子抢占）：`claimed_by = {session_id（model）或 operator（dashboard）}, claimed_at = now`，条件 `claimed_by IS NULL OR claimed_at < now - TTL`。TTL 默认 **3600s**（对齐 worker 预算硬上限；manifest `vuln_claim_ttl_sec` 可调）。发 `candidate.claimed`。

**vuln_release 参数表**：finding_id（必填）。行为：`claimed_by=NULL`（仅当前认领者可释放；未认领/已释放 → 幂等返回 ok replay）。无事件。

**错误码**：

| code | 触发 | hint | retryable |
|---|---|---|---|
| E_VULN_NOT_CANDIDATE | 目标非候选（noise=0 或 status≠new） | "认领只作用于候选池行（noise=1 AND status='new'）。信号面行的验证由任务编排保证，无需认领" | false |
| E_VULN_CLAIMED | 他人活跃认领 | "候选 #{id} 已被 {claimed_by} 认领（X 分钟前，TTL 3600s）。用 vuln_candidates claim_state=available 取下一条" | true |

**actor**：model, dashboard。**幂等**：claim 自动指纹（finding_id+认领者）；release 宽松幂等。

---

#### C9 · vuln_verify_replay（CONFIRMED 机械复核）

**语义**：原 v4 `verify_replay` 工具（sec-pipeline.js L319-363；从 ledger 台账族划归本域——操作对象是 `evidence/{finding_id}/`（本域 owns），判定结论是 finding 置信的机械来源，"记录 vs 判定"不同族，详证见 11-ledger.md §三现状映射 #7）。**防幻觉标准 9：LLM 不给自己当法官**——`vuln_confirm` 的纪律自查要求本复核通过，本命令就是那个"机械复核"的域化形态。CONFIRMED 流程里它由模型/脚本在确认前调用，结果留在 verify-log.md 证据链上。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| finding_id | integer | 是 | — | 行存在。evidence 目录由域内拼接为 `data/evidence/{finding_id}/`——**调用方不传任意路径**（v4 的任意 `evidence_dir` 参数收窄为 finding_id 派生，消除路径穿越面） |
| proxy | string | 否 | egress 默认出口 | `direct`（直连）或 proxy 域引用 |
| expect_hash | string | 否 | '' | 期望响应体 sha256；不传 verdict=REPLAYED，传则 PASS / FAIL(hash 不一致) |

**行为**：读 `data/evidence/{finding_id}/request.txt` → 解析首行 method/path + headers（须含 Host）+ body → 经 proxy（或 direct）重放 → 响应体 sha256 → 与 expect_hash 比对 → **追加** `verify-log.md` 一行（`| 北京ISO时间 | 出口 | status | sha256 前 16 位 | verdict |`）。返回 `{status, sha256, verdict}`。**不改 findings 行**——复核结论经证据引用链被 `vuln_confirm` 的自查引用（机械判定本身不自动改状态，确认仍是一次显式命令）。

**错误码**：E_NOT_FOUND（finding 或 request.txt 不存在，hint："先在任务内产出证据包（request.txt 落 evidence/{id}/）再复核"）；`E_VULN_REPLAY_FAILED`（网络/首行解析失败，retryable=true，hint："网络波动可重试；首行无法解析说明 request.txt 非标准 HTTP 报文，重新产出证据包"）。**幂等**：自动指纹（finding_id+expect_hash+分钟）。**actor**：model, script（run_cli 侧治理脚本）。

---

#### C10 · vuln_attach_fgs（FGS 节点关联回写）

**语义**：v4 中 `finding_add` 工具 execute 段（asset-graph.js L168-196）在调度任务会话内自动创建 FGS finding 节点——这是工具面里的跨域直写。v5 改为：**fgs 域订阅 `vuln.signal.registered` / `vuln.candidate.registered`（弱联动）**，事件含 session_id 时查活动任务，创建 type=finding 节点后**调用本命令回写关联**（跨域副作用 = 发布事件 + 订阅方执行命令，公理 4 合法路径）。也允许模型在任务内显式 fgs_add 后传 fgs_node_id 给 C1。

**参数表**：finding_id（必填，行须 status ∈ {new, confirmed}）、fgs_node_id（必填，正整数）。行为：覆盖式关联（后写胜），不改状态。无事件。**actor**：model, reactor（reactor 供 fgs 域订阅 `vuln.signal.registered` 回写，审计 cause 链指向原始事件及其 actor——宪法 §三）。**幂等**：自动指纹。

### 1.4 查询（读投影）逐个详述

统一分页信封 `{rows, total, limit, offset}`；limit 默认 50、上限 500；sort 白名单 + dir=asc|desc；**行数与 total 同一 where 构造器**（契约测试强制断言，v4.3 病根不复发）。

| # | 查询 | 语义 | 可见域谓词默认值 |
|---|---|---|---|
| Q1 | `vuln_list` | 信号/候选/全量列表 | visibility=signal（noise=0） |
| Q2 | `vuln_get` | 单行全量（含 evidence 大字段） | — |
| Q3 | `vuln_candidates` | 候选工作队列（认领态过滤） | claim_state=available（unclaimed∪stale） |
| Q4 | `vuln_stats` | 信号面与候选面分开计数（KPI 唯一口径） | — |
| Q5 | `vuln_by_asset` | 单资产漏洞视图 | include_candidates=false |
| Q6 | `vuln_dedup_check` | 同目标同类型查重（提交前必查） | noise=0 + 状态不限 |

**Q1 · vuln_list**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| visibility | enum signal/candidate/all | 否 | signal | signal=noise 0；candidate=noise=1 AND status='new'（**候选池口径**）；all=全量（替代 v4 includeNoise/noise 双参数） |
| host / severity / status / program_id | string | 否 | '' | 精确匹配（severity/status 枚举校验） |
| q | string | 否 | '' | title/host/url LIKE |
| limit / offset / sort / dir | — | 否 | 50 / 0 / created_at / desc | sort 白名单：created_at/id/status/severity（severity 语义排序 critical>high>medium>low>info，v4 CASE 表达式保留） |

返回 rows 列：id/title/severity/host/url/source/status/program_id/session_id/vuln_type/bounty/vendor_status/noise/claimed_by/created_at/confidence/fgs_node_id/discovery_step（不带 evidence 大字段——详情走 Q2，v4 纪律保留）。

**Q2 · vuln_get**：参数 id（必填）。返回行全量；不存在 → E_NOT_FOUND。纯读。

**Q3 · vuln_candidates**（候选池一等公民工作队列）：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| claim_state | enum available/unclaimed/claimed/stale/all | 否 | available | available=unclaimed∪claimed_stale（认领超时）；stale 单看超时认领 |
| severity_min | enum | 否 | '' | 阈值过滤（critical>high>medium>low>info） |
| program_id / host | string | 否 | '' | — |
| limit / offset / sort / dir | — | 否 | 50 / 0 / severity / desc | sort 白名单：severity/created_at/claimed_at |

返回 `{rows, total, limit, offset, pool: {pending, claimed, stale, by_severity}}`——pool 是同 where 口径的池摘要（消化进度一眼可见）。

**Q4 · vuln_stats**（替代 v4 stats() 的 findings/findings_noise 两项，**口径修正为宪法 §十一**）：

```json
{
  "signal": { "total": 10, "by_severity": { "high": 6, "medium": 4 }, "by_status": { "confirmed": 5, "dup": 4, "false_positive": 1 } },
  "candidate": { "pending": 2, "claimed": 0, "by_severity": { "high": 1, "medium": 1 }, "oldest_pending_at": 1789000000000 },
  "terminal_in_pool": 25,
  "sync": { "pending": 0, "failed": 0, "last_synced_at": null }
}
```

- `candidate.pending = COUNT(*) WHERE noise=1 AND status='new'`——**任何"候选计数"KPI 一律用此值**（v4 `findings_noise` 只看 noise 列、永远 58 只增不减的病在契约层根除）；
- `terminal_in_pool` = noise=1 AND status≠new（历史候选遗骸，出池归档参考，见开放问题）；
- `sync` 仅 http-remote 模式非空（§2.4）。

**Q5 · vuln_by_asset**：参数 host（必填）、include_candidates（bool，默认 false）。返回 `{host, total, by_severity: [{severity, n}], candidates_total}`——原 v4 assetDetail 的 findings 片段抽出（asset 域保留资产/接口/指纹/同族部分，跨域读经本查询）。

**Q6 · vuln_dedup_check**：参数 host、vuln_type（至少其一必填）、exclude_id（可选）、limit（默认 10）。返回同 host 或同 vuln_type 的信号面历史行（id/title/severity/status/host/created_at）+ total。提交前必查（防平台判重，v4 submissionDraft 内嵌逻辑抽出为独立查询）。

### 1.5 事件（发布 / 订阅）

**发布**（payload 只含 ID 与判据快照，≤2KB，**不含行全量**——订阅方要详情自己查询；redact 清单：evidence、reproduction_steps、impact 不进 payload 与 audit 快照）：

| 事件 | 触发命令 | payload schema |
|---|---|---|
| `vuln.candidate.registered` | C2 | `{finding_id:int, fingerprint:string, title_head:string(≤60字), severity:enum, host:string, source:string, program_id:string\|null}` |
| `vuln.candidate.promoted` | C1（弱指纹命中）/ C3（自候选池确认） | `{finding_id:int, from:{noise:1,status:'new'}, to:{noise:0,status:string}, cause_cmd:'vuln_register_signal'\|'vuln_confirm'}` |
| `vuln.candidate.claimed` | C7 | `{finding_id:int, claimed_by:string, claimed_at:int(epoch ms), ttl_sec:int}` |
| `vuln.signal.registered` | C1 | `{finding_id:int, fingerprint:string, severity:enum, host:string, session_id:string\|null, fgs_node_id:int\|null}` |
| `vuln.signal.confirmed` | C3 | `{finding_id:int, from:{status:'new',noise:int}, evidence_ref:string, confidence:'confirmed', fgs_node_id:int\|null, vuln_type:string\|null}` |
| `vuln.signal.rejected` | C4 | `{finding_id:int, verdict:enum, from:{status:string,noise:int}, reason_head:string(≤60字), dup_of:int\|null, fgs_node_id:int\|null}` |
| `vuln.signal.submitted` | C5 | `{finding_id:int, from:{status:string}, to:{status:string}, bounty:number\|null, vendor_status:string, platform:string}` |

事件信封（含 id/ts/actor/session_id/cause）由总线统一生成；全部事件追加 `data/events/vuln.jsonl` 可回放。

**订阅**（manifest `subscribes`，未声明收不到）：

| 订阅事件 | 模式 | 处理器 | 行为 |
|---|---|---|---|
| `exec.run.completed` | async（弱联动） | `on_parser_proposal` | payload 含 `parse_proposal.findings[]` 时（nuclei/afrog parser 产物，v4 parsers.js L166-170 直写路径的事件化），逐条 `dispatch('vuln','register_candidate', …, ctx={actor:'script', identity:'parser:{tool}:{run_id}'})`，source=`parser:{tool}`。订阅者失败 → audit 记 `subscriber_failed` + 事件保留可重放（不回滚 exec 的 run 收尾）。assets/endpoints 段本域**忽略**（asset/endpoint 域各自订阅同一事件取自己的段） |
| `approval.approved` | — | **不订阅**（勘误） | v4 初稿 manifest 曾把它列入 vuln 订阅——错误：授权批准的联动方是 scope 域（scope_grant）与 task 域（种子任务），与漏洞数据无联动。v5 从本域 manifest 移除 |

**机器直灌调用方关系**（v4 → v5 角色变化，它们从「直调 addFinding」变为「事件/命令调用方」）：

| v4 调用方 | v4 行为 | v5 行为 |
|---|---|---|
| xray webhook（webhook.js → addFinding） | 直调函数，机器与模型共用动词 | HTTP 接收器保留在 exec 域边缘 → `dispatch vuln_register_candidate` actor=webhook |
| authz_diff suspected（sec-suite.js L1582） | 工具 execute 内直调 addFinding（high + 无复现 → 完整性闸门归候选） | exec 域工具判定 suspected 后 `dispatch vuln_register_candidate` actor=script，identity=`authz_diff:{session_id}`，source='authz_diff'（启发式判定是机器语义，不得冒充模型登记） |
| intel_hunt（sec-suite.js L1790） | 不写 findings（产 N-day 候选**任务**） | 不变——产物是 task 域实体，与 vuln 域无直写关系；任务执行后的发现仍走 C1/C2 |
| parser 入库（parsers.js applyParsedResult → addFinding） | run_cli 后处理直写 | `exec.run.completed` 事件 → 本域 on_parser_proposal → C2（见上表） |

### 1.6 模型工具面投影（工具名 + 描述全文）

ToolProjector 从 manifest 自动 `ctx.tools.register`：工具名=动词/查询名（零改名）、schema=命令 schema、description=`agent_note`。挂载矩阵：web/headless 双面全量投影查询；命令按 actor 白名单投影（model 不可用的动词根本不注册）。

| 工具名 | 对模型可见 | 描述全文（agent_note） |
|---|---|---|
| `vuln_register_signal` | 是 | "登记一个**完整验证过**的漏洞发现（唯一能新建信号面行的动词）。五要素强制：规范标题（≥10 字符，『<组件/业务语境> <漏洞类型与后果>（关键特征）』，禁止工具原始输出当标题）、复现步骤、具体化影响、证据引用（run_id/flow_id/burp_item）、host。severity 禁 info（信息类按 severity-rating 规则以 low+具体影响重评）。同 host+title+url 指纹自动去重；命中待验证候选会就地补全升级（upgraded:true）。纪律：登记前必须完成对抗性自检（≥2 反证假设逐一排除）+ 高危双出口复现；CONFIRMED 还须 verify_replay 机械复核。" |
| `vuln_register_candidate` | **否**（机器通道） | （不向模型注册——webhook/script 专用） |
| `vuln_confirm` | 是 | "把待验证候选/信号确认为 confirmed（status+confidence+noise 原子三联动，候选同时出池进信号面）。evidence 必填且必须真实存在（run_id 的 results 目录 / evidence/{id}/ 证据包）。确认前自查：verify.must_pass 全过、falsification 逐项排除、verify_replay 机械复核通过；高危走独立 worker 复验（双路一致才确认）。候选被他人认领时会被告知换下一条。" |
| `vuln_reject` | 是 | "判定 false_positive / dup / ignored。reason ≥10 字可追溯；dup 必须指回被重复的 finding（dup_of，可先用 vuln_dedup_check 查）。被拒候选自动出池；关联 FGS 节点自动 deprecated。误报判定会回流活评测集（eval-live）用于校准同类判定——认真判，它影响后续可信度评估。" |
| `vuln_submit` | 是 | "确认后的运营流转：confirmed → submitted（平台提交后）；vendor 反馈（accepted/bounty/vendor_status）在 submitted 态再次调用回流运营列。提交前先 report_draft_submission（report 域，旧名 submission_draft）出草稿人工审校。" |
| `vuln_note` | 是 | "向 finding 追加证据链条目（不改状态，任意状态可用）。用于补充观察、勘误说明、复验记录。带时间戳前缀追加。" |
| `vuln_claim` | 是 | "认领一条待验证候选（防多 worker 重复验证）。软锁 TTL 3600s，超时自动可抢占。认领后尽快验证并 vuln_confirm / vuln_reject，不再处理时 vuln_release。" |
| `vuln_release` | 是 | "释放自己认领的候选（改做其他事时必须释放，别让锁白占到超时）。" |
| `vuln_verify_replay` | 是 | "机械复核（LLM 不给自己当法官）。重放 evidence/{id}/request.txt，响应体 sha256 与 expect_hash 比对，结果追加 verify-log.md。CONFIRMED 纪律自查要求本复核通过。" |
| `vuln_attach_fgs` | 是（Phase 1 可选） | "把 FGS finding 节点关联到 finding 行（任务内显式建图时用；调度会话内自动关联由 fgs 域事件完成，通常无需手动）。" |
| （草稿工具） | — | `submission_draft` / `vuln_draft_submission` 旧名经总线别名指向 **report 域 `report_draft_submission`**（见 12-report.md §一）——本域不注册草稿工具 |
| `vuln_list` | 是 | "检索漏洞发现。visibility=signal（默认，仅信号面）/ candidate（待验证候选队列）/ all。按 host/severity/status/program_id/q 过滤，分页+排序。" |
| `vuln_get` | 是 | "取单条 finding 全量详情（含 evidence 证据链全文）。" |
| `vuln_candidates` | 是 | "待验证候选工作队列。claim_state=available（默认，未认领+认领超时）/ unclaimed / claimed / stale / all。带池摘要（pending/claimed/by_severity）。消化候选池是 vuln 任务 Slice 的合法硬指标来源。" |
| `vuln_stats` | 是 | "漏洞计数总览：信号面（by severity/status）与候选面（pending/claimed）分开计数。候选口径=待消化（noise=1 且 status=new），不是噪声总数。" |
| `vuln_by_asset` | 是 | "单资产漏洞视图（按 severity 分组计数，可选含候选）。" |
| `vuln_dedup_check` | 是 | "同目标/同类型历史查重（host 或 vuln_type 至少其一）。提交前必查，防平台判重。" |

### 1.7 看板 RPC 投影

RpcProjector 自动投影（RPC 名 `{domain}.{verb}` 点分；写操作自动带 actor=dashboard + operator 身份进审计）：

| RPC 名 | 类型 | 替代的 v4 dashboard-rpc case |
|---|---|---|
| `vuln.list` / `vuln.get` / `vuln.candidates` / `vuln.stats` / `vuln.byAsset` / `vuln.dedupCheck` | 读 | `findings`（L283）/ `findingGet`（L293） |
| `vuln.confirm` / `vuln.reject` / `vuln.submit` / `vuln.note` / `vuln.claim` / `vuln.release` / `vuln.verifyReplay` | 写（operator 必填） | `findingUpdate`（L375-388，**双面同病的第二入口消灭**） |
| `vuln.registerSignal` | 写 | （新增：看板人工登记通道，operator 审计高亮） |

看板 UI 侧：候选 tab 升级为**工作队列视图**（认领/确认/驳回快捷操作全走上述 RPC）；顶部 KPI 的「待验证候选」徽章改用 `vuln.stats → candidate.pending`。stats 大盘中 findings 相关数字全部改由 `vuln.stats` 供给（不再手拼 SQL）。

### 1.8 外部调用示例

**模型调用**（worker 会话内工具调用）：

```json
{"tool": "vuln_confirm", "args": {
  "finding_id": 341,
  "evidence": "run_rc_20260906_041532 + evidence/341/reproduce.sql + verify_replay sha256 一致",
  "note": "三包对照齐全（自己200/他人200/不存在404），重放3次稳定"
}}
```

**代码调用**（域间/插件内，cordis inject + 总线 dispatch）：

```js
// exec 域 authz_diff 判定 suspected 后登记候选（替代 v4 直调 assetDb.addFinding）
const vuln = ctx.inject('secDomain.vuln')
const r = await vuln.dispatch('register_candidate', {
  title: `疑似越权(IDOR): ${method} ${url}`, severity: 'high',
  host: hostOf(url), url, source: 'authz_diff',
  evidence: `low=${low.status}/${low.length}B high=${high.status}/${high.length}B keysOverlap=..%`,
}, { actor: 'script', identity: `authz_diff:${sessionId}` })
// r => { ok: true, data: { id: 345, dup: false, noise: true, status: 'new' }, ... }
```

**脚本调用**（治理脚本经 RPC 通道，或运维应急 human 直调）：

```bash
# 运维应急：人工翻案一条误判（显式 --actor human，审计高亮）
spool exec csai "node /opt/silkspool/dsh/bin.js --profile web --rpc secDomain.vuln confirm \\
  --args '{\"finding_id\":341,\"evidence\":\"evidence/341/verify-log.md\"}' --actor human"
```

---

## 二、内部实现（Internal）

### 2.1 数据模型（逐列）

**表 `findings`**（asset-graph.db，sqlite-local 后端直接接管，**不改名不迁库**；列级演进走域内 ensureCol 幂等添加）。现状列（v4 DDL + 历次 ensureCol，全部保留）：

| 列 | 类型 | 约束/默认 | 语义 | 来源版本 |
|---|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 行标识 | v1 |
| fingerprint | TEXT | NOT NULL UNIQUE | 指纹：信号行=强 `sha1(host\|title\|url)`；候选行=弱 `sha1(host\|title)`（同模板同目标只留一行，URL 变体不增殖——v4 P15 设计保留） | v1 |
| title | TEXT | NOT NULL | 规范标题（「组件语境 漏洞类型与后果（关键特征）」） | v1 |
| severity | TEXT | — | critical/high/medium/low/info | v1 |
| host | TEXT | — | 归一化主机 | v1 |
| url | TEXT | — | 触发 URL | v1 |
| evidence | TEXT | — | 证据链（追加式：时间戳前缀条目） | v1 |
| source | TEXT | — | 登记来源（agent / xray-webhook / authz_diff / parser:nuclei …） | v1 |
| status | TEXT | NOT NULL DEFAULT 'new' | 状态机列：new/confirmed/false_positive/submitted/accepted/dup/ignored | v1 |
| created_at | INTEGER | NOT NULL | UTC epoch ms | v1 |
| program_id | TEXT | — | 项目归属 | v4 ensureCol |
| task_id | INTEGER | — | （遗留列，v4 写入点已无实际消费者；保留不删） | v4 ensureCol |
| session_id | TEXT | — | 来源会话（看板跳链） | v4 ensureCol |
| vuln_type | TEXT | — | 漏洞类型（IDOR/SQLi/…，提交模板） | v4.2 |
| cwe | TEXT | — | CWE 编号 | v4.2 |
| endpoint_ref | TEXT | — | 关联接口 host+method+path | v4.2 |
| preconditions | TEXT | — | 前置条件 | v4.2 |
| reproduction_steps | TEXT | — | 复现步骤（五要素之一） | v4.2 |
| impact | TEXT | — | 具体化影响（五要素之一） | v4.2 |
| recommendation | TEXT | — | 修复建议 | v4.2 |
| submitted_at | INTEGER | — | 首次提交时间 | v4 运营列 |
| vendor_status | TEXT | — | 厂商反馈状态 | v4 运营列 |
| bounty | REAL | — | 赏金 | v4 运营列 |
| noise | INTEGER | NOT NULL DEFAULT 0 | 候选池可见性维度（**不是状态**——候选池= noise=1 AND status='new' 的组合谓词，宪法 §十一） | v4 P15 |
| confidence | TEXT | NOT NULL DEFAULT 'tentative' CHECK(in tentative/confirmed/false_positive/dup) | 证据置信（P17） | v4 P17 |
| fgs_node_id | INTEGER | — | 关联 FGS finding 节点 | v4 P17 |
| discovery_step | TEXT | — | 发现步骤快照 | v4 P17 |

**v5 新增列**（域 ensureCol 幂等添加，全部可空、默认空——存量行为不变）：

| 列 | 类型 | 默认 | 语义 | 阶段 |
|---|---|---|---|---|
| claimed_by | TEXT | NULL | 认领者（model→session_id；dashboard→operator 名） | Phase 1 |
| claimed_at | INTEGER | NULL | 认领时间（TTL 判定基准） | Phase 1 |
| updated_at | INTEGER | NULL | 最后命令触碰时间（迁移时回填=created_at） | Phase 1 |
| remote_id | TEXT | NULL | http-remote 远端系统漏洞 ID（回写映射） | Phase 4 |
| remote_synced_at | INTEGER | NULL | 最后同步成功时间 | Phase 4 |
| sync_state | TEXT | NULL | 同步状态：pending/synced/failed（outbox） | Phase 4 |

**索引**：既有 `idx_findings_host`、fingerprint UNIQUE；v5 新增 `idx_findings_pool (noise, status)`（候选队列与 KPI 主查询路径）、`idx_findings_claim (claimed_at)`（超时抢占扫描）。

**文件 owns**：`data/evidence/{finding_id}/`（证据包目录树；request.txt 由任务产出后经本域挂链校验，verify-log.md 只追加）；`data/events/vuln.jsonl`（总线写，本域声明）。报告/草稿文件归 report 域（方案 A）。

### 2.2 状态机与不变量

**完整状态机**（noise 维度与 status 维度正交，但流转动词保证联动原子）：

```
                        ┌──────────────────────────────────────────────┐
                        │ 候选池（noise=1 ∧ status='new'）＝工作队列        │
                        │  ├ vuln_claim/release ── 认领协作（TTL 3600s）  │
                        │  ├ vuln_confirm ────────────┐ 原子：noise→0    │
                        │  ├ vuln_reject(fp/dup/ig) ──┼─┐ status→verdict │
                        │  └ vuln_register_signal ────┤ │ 弱指纹命中升级   │
                        └────────────────────────────┼─┴────────────────┘
                                                     ▼
  信号面（noise=0）
    new ──vuln_confirm──▶ confirmed ──vuln_submit──▶ submitted ──vuln_submit(vendor_status=accepted)──▶ accepted
     │                       │                            │
     └──vuln_reject──────────┴────────────────────────────┴──▶ false_positive / dup / ignored（终态）

  终态集合：accepted、false_positive、dup、ignored（任何流转动词 → E_STATE）
  状态机私有：调用方永远不传 status/to——想流转必须调与流转语义同名的动词（宪法铁律 1）
```

要点：

1. **noise 与 status 联动是单事务原子动作**——confirm 的三联动（status+confidence+noise）与 reject 的出池保证都在**同一条 UPDATE 语句**里（§1.3 C3/C4 的 SQL），物理上不存在"改了 status 漏了 noise"的写法（v4 缺陷根因：两列两处改）。
2. **候选出池的两条合法路径**：confirm（noise→0 进信号面）与 reject（status→verdict，noise 保持 1 但退出 `status='new'` 口径）。候选计数 KPI 与全部查询共用 `noise=1 AND status='new'` 谓词（单一 where 构造器）。
3. **confirm 双来源**：候选行（noise=1）与信号行（noise=0，模型 register_signal 后再验证确认）都从 `status='new'` 出发，同一 UPDATE 守卫。

**网关前置不变量清单**（manifest `invariants`，CommandGateway 事务前逐条执行，失败返回对应错误码；域实现不重复校验）：

| # | 不变量 | 失败错误码 |
|---|---|---|
| INV-1 | 终态（accepted/false_positive/dup/ignored）不可再流转；confirm/reject 仅自 status='new'（reject 另允许 confirmed/submitted） | E_STATE |
| INV-2 | confirm 的 evidence 必填且引用真实存在（run_id→results 目录 / evidence/{id}/ / flow 文件） | E_EVIDENCE_REQUIRED |
| INV-3 | 候选达终态必出池：confirm 与 reject 的 UPDATE 语句本身包含 noise/status 联动与 status='new' 守卫（changes=0 → E_STATE）——不变量由语句形状保证，网关断言后置（affected 行的 noise/status 组合合法） | E_STATE |
| INV-4 | register_signal 五要素完整：title≥10 字符且非低信息形状、reproduction_steps 非空、impact 非空、severity≠info、evidence 含引用 | E_INVARIANT（E_VULN_INCOMPLETE / E_VULN_INFO_SEVERITY） |
| INV-5 | register_candidate 仅机器 actor（webhook/script）；模型走 register_signal | E_ACTOR_FORBIDDEN |
| INV-6 | fingerprint UNIQUE 即幂等命中：同指纹不另起行（模型通道严格报冲突，机器通道宽容 dup:true） | E_IDEMPOTENT_CONFLICT / dup:true |
| INV-7 | 认领互斥：claim/confirm(model) 对他人未超时认领的候选拒绝；dashboard 豁免（人工终审） | E_VULN_CLAIMED |
| INV-8 | verify_replay 的 evidence 目录由 finding_id 域内派生（不接受调用方任意路径——v4 任意 evidence_dir 参数收窄） | E_SCHEMA |
| INV-9 | verdict=dup 必带存在的 dup_of | E_VULN_DUP_TARGET_REQUIRED |

**契约测试矩阵落点**（宪法 §十三逐项到本域，`test/contract-{verb}.test.js`，sqlite-local 必跑、http-remote Phase 4 同套）：

| 用例类 | vuln 域具体用例 |
|---|---|
| happy path | 每动词一例：信封结构 / data 字段 / 事件已发布且 payload 符合 §1.5 schema / audit 已落（before/after 含 status+noise+confidence，不含 evidence） |
| schema 拒绝 | register_signal 缺任一必填/未知参数/severity 越枚举 → E_SCHEMA；reject verdict 非枚举 |
| 不变量拒绝 | INV-1~INV-9 每条至少一反例（如：confirm 不存在的 run_id → E_EVIDENCE_REQUIRED；register_signal severity=info；model 调 register_candidate） |
| 状态机拒绝 | confirm 已 confirmed 行；reject 已 accepted 行；submit new 行；终态再流转全集 |
| actor 拒绝 | register_candidate×{model,dashboard,human} → E_ACTOR_FORBIDDEN；confirm×{webhook,script} |
| 幂等重放 | 每命令同 key 同参 → replay:true 同结果；register_signal 同指纹异参 → E_IDEMPOTENT_CONFLICT（**别名 finding_add 层转译为 {dup:true}，§3.2**） |
| 并发 | 两进程同时 vuln_claim 同一候选 → 一成一 E_VULN_CLAIMED；两进程同时 confirm → 一成一 E_STATE（sqlite BEGIN IMMEDIATE 串行化） |
| 事件载荷 | signal.confirmed payload 含 from/evidence_ref/fgs_node_id、不含 evidence 全文、≤2KB |
| 查询口径 | **每个列表查询：rows.length ≤ limit 时 rows.length == total**（同 where 构造器断言）；vuln_list 三种 visibility 默认值断言；vuln_candidates claim_state 默认 available；vuln_stats.candidate.pending == vuln_candidates(claim_state=all).total |
| 核心回归（v4 缺陷档案） | confirm 候选后：candidate.pending −1 ∧ signal.total +1 ∧ 该行进 vuln_list(signal) 结果——**"确认漏洞但候选不消减"的 2026-09-06 缺陷作为永久回归用例** |

### 2.3 事务与联动实现

**事务边界**：每命令一个 BEGIN IMMEDIATE（busy_timeout 5s，跨进程 WAL）；跨域效果不进本事务——发事件，最终一致。命令事务内的写集合：

| 命令 | 事务内行变更 | 事务后事件 |
|---|---|---|
| register_signal | INSERT 信号行 / UPDATE 候选行（promote 合并） | signal.registered（+candidate.promoted） |
| register_candidate | INSERT 候选行 | candidate.registered |
| confirm | 单 UPDATE 三联动 + 清认领（+note 追加同事务） | signal.confirmed（+candidate.promoted） |
| reject | 单 UPDATE + 清认领（+note 追加同事务） | signal.rejected |
| submit | 单 UPDATE（status/submitted_at/运营列） | signal.submitted |
| note | 单 UPDATE（evidence 追加） | 无 |
| claim / release | 单 UPDATE（claimed_by/claimed_at） | candidate.claimed / 无 |
| verify_replay | 无行变更（verify-log.md 追加写） | 无 |
| attach_fgs | 单 UPDATE（fgs_node_id） | 无 |

**跨域联动实现**（v4 直调 → v5 事件，全表）：

| v4 直调点 | v4 位置 | v5 联动 |
|---|---|---|
| updateFinding → fgsUpdateNode（状态同步 FGS 节点） | asset-db.js L1544-1546 | fgs 域订阅 `signal.confirmed`（节点→done）/ `signal.rejected`（→deprecated），按 payload.fgs_node_id 更新自己域的节点——**无需回写 vuln**（弱联动，失败 audit 记 subscriber_failed 可回放） |
| finding_add 工具段自动建 FGS finding 节点 | asset-graph.js L168-196 | fgs 域订阅 `signal.registered`/`candidate.registered`（payload 含 session_id）→ 查活动任务（task 域查询）→ fgs_add → **调 vuln_attach_fgs 回写**（actor=reactor，审计 cause 链） |
| updateFinding → appendLiveEval（评测回流） | asset-db.js L1553-1556 | eval 域订阅 `signal.confirmed` / `signal.rejected`（弱联动）→ vuln_get 查详情 → eval_case_append（详见 15-eval.md） |
| addFinding/updateFinding → invalidateOverview（asset 域缓存失效） | asset-db.js L346/364 | asset 域订阅本域全部事件 → 失效自己的 _ovCache；assetOverview 的 finding_count 改经 `vuln_by_asset`/`vuln_stats` 跨域查询（读互调合法） |
| report_build 读 findings | asset-db.js L1594 | report 域经 vuln_list 查询取数（跨域读），本域不管报告 |
| authz_diff / xray webhook / parser 直写 | 见 §1.5 调用方关系表 | 事件/命令调用方 |

**失败语义**：命令事务失败不发事件不落 audit 的 result:ok 行（失败命令也审计，宪法 §九）；同步订阅者异常被网关捕获（本域全部订阅为弱联动，无强联动订阅方）。

### 2.4 后端适配器

**repository 接口**（`backend/repository.js`，JSDoc；方法名=命令/查询所需原语，不含 SQL 语义、不含业务校验）：

```js
/** repository-v1 —— vuln 域后端接口（三后端同契约测试） */
export const repositoryV1 = {
  getFinding(id)                         // → row|null
  getFindingByFingerprint(fp)            // → row|null（含弱/强指纹两种入参）
  insertFinding(fields)                  // → {id}（fields 已含 fingerprint/noise/status 等全量判定结果）
  transitionFinding(id, expectStatus, sets) // → {changed, before} —— 原子 UPDATE ... WHERE id=? AND status=expectStatus；
                                           //    sets 仅含状态机列（status/confidence/noise/claimed_by/claimed_at/updated_at/运营列）
  mergeCandidate(id, fields, newFp)      // → {changed, before} —— promote 专用：补字段+换指纹+noise=0 原子合并
  appendEvidence(id, text)               // → {}（vuln_note）
  setClaim(id, claimer, nowMs)           // → {ok, previous}（含 TTL 抢占条件）
  listFindingsWhere(pred, sort, limit, offset) // → {rows, total} —— pred 为域内谓词对象（visibility/claim_state/...），
                                           //    rows 与 total 必须由同一 where 构造器生成（宪法 §七.3）
  statsFindings()                        // → §1.5 Q4 的聚合结构
  ensureCol(name, ddl)                   // → {}（幂等列演进）
}
```

**sqlite-local（默认，Phase 1）**：node:sqlite，直接接管现 `findings` 表（不迁库）；ensureCol 补 §2.1 v5 新增列；新增两个索引；`transitionFinding` 用 `BEGIN IMMEDIATE ... UPDATE ... WHERE status=?` 实现（与 v4 taskClaimDue 同款原子抢占模式）。busy_timeout 5s，SQLITE_BUSY 超时 → E_CONFLICT（retryable）。

**http-remote（Phase 4 试点：外部漏洞管理系统对接）**：

- **REST 映射示例**（远端以通用漏洞管理 API 为例，具体系统适配在 backend 插件内收口）：

| 域命令/查询 | REST | 说明 |
|---|---|---|
| vuln_register_signal | `POST {base}/api/v1/vulnerabilities` body={title,severity,host,url,...} → 201 {id} | 远端 id 回写 remote_id |
| vuln_confirm | （混布）本地事务 + 异步 `POST` 远端 | 见同步策略 |
| vuln_submit | `PATCH {base}/api/v1/vulnerabilities/{remote_id}` {status,bounty,vendor_status} | |
| vuln_note | `POST {base}/api/v1/vulnerabilities/{remote_id}/notes` {text} | |
| vuln_list / vuln_get | `GET {base}/api/v1/vulnerabilities?status=&severity=&page=` / `GET .../{remote_id}` | 分页映射 limit/offset→page |
| vuln_register_candidate | **unsupported** | 远端无候选池语义 |
| vuln_claim / vuln_release | **unsupported** | 同上，认领是本地工作队列概念 |
| vuln_stats / vuln_by_asset / vuln_dedup_check | partial | 远端聚合口径差异大，能力矩阵声明（如 by_severity 维度缺失时返回 partial 字段） |

- **能力矩阵**（manifest 声明，网关 fail-closed）：

| 命令/查询 | sqlite-local | http-remote（纯模式） | http-remote（混布模式，推荐） |
|---|---|---|---|
| register_signal | full | full | full（本地事务 + outbox 同步） |
| register_candidate | full | **unsupported**（E_CAPABILITY_UNSUPPORTED，hint："远端系统无候选池语义，请配置 sqlite overlay 混布"） | full（**本地 sqlite overlay 承接候选池**） |
| confirm | full | full | full（本地 + 远端双写，异步收敛） |
| reject / submit / note | full | full | full |
| claim / release | full | unsupported | full（本地） |
| verify_replay | full | full（evidence 目录始终本地，owns 不随后端变） | full |
| 全部查询 | full | partial（聚合口径差异） | full（信号面查远端、候选面查本地——查询路由按行来源） |

- **混布模式（用户场景"换外部漏洞管理系统也能跑"的落地机制）**：候选池留在本地 sqlite overlay（远端不支持候选语义）；`vuln_confirm` 主事务落本地后，同步器把该行推送远端并回写 `remote_id`；此后该行的 submit/note 经 remote_id 走远端 + 本地镜像。同步边界在域内 commands 层实现，调用方无感（宪法 §十二.4）。
- **同步策略与失败重试（outbox 模式）**：confirm/submit 事务内置 `sync_state='pending'`；域内同步器（事件驱动 + 30s 兜底轮询）推远端，成功回写 `remote_id/remote_synced_at/sync_state='synced'`；失败指数退避重试（30s/2m/10m/1h/6h/24h ×8 次封顶），超限 `sync_state='failed'` 并在 vuln_stats.sync 暴露 + 看板告警；`sec bus replay` 可重放。远端返回 4xx（数据被拒）→ sync_state='failed' 不再重试 + audit 记远端响应。
- **E_BACKEND_UNAVAILABLE 降级**：纯 http 模式网络失败 → 命令直接失败（retryable:true，网关按 retryPolicy 退避）；混布模式命令主事务落本地成功、同步异步化（业务不因远端抖动中断——与 v4 Bellkeeper 网关熔断链同哲学：可用性优先，最终一致）。

**file 后端：不适用（声明）**。findings 是强事务关系数据：状态机原子性（单 UPDATE 多列守卫）、fingerprint UNIQUE 约束、跨进程并发写（WAL）都无法用 TSV/YAML/JSONL 承载；且 65 行规模远未到需要换存储的量级。`data/evidence/` 与 verify-log.md 虽是 file 形态，但它是 C9 命令的直接产物（commands 层追加写），不经 repository 抽象。

### 2.5 缓存与失效

| 缓存 | 策略 | 失效 |
|---|---|---|
| vuln_stats 聚合 | 进程内 10s TTL（看板 30s 轮询足够新鲜；65 行直查 <1ms 本可不安缓存，防的是未来 http-remote 模式下的远端往返） | 本进程任何命令成功即失效 + 订阅远端事件失效（跨进程靠 TTL 短容忍） |
| 列表/详情查询 | 不缓存 | — |
| asset 域 _ovCache（finding_count） | 归 asset 域 | asset 域订阅本域事件失效（§2.3），取代 v4 addFinding 里的 invalidateOverview 直调 |

### 2.6 性能与容量（当前 68 行规模）

- **现状**（2026-09-06 实测）：68 行 = 信号面（noise=0）10 行 + 候选池 58 行；候选池中真正的待消化候选（status='new'）仅 **2 行**，其余 56 行为 v4 缺陷遗留的终态滞留（31 confirmed + 7 dup + 5 fp + 13 ignored——§3.3 Phase 0 修复对象）。
- **预期增长**：信号 + 候选合计年增 10²~10³ 行（每日 vuln 任务的产出量级），10 年内 <10⁴ 行——sqlite 单表毫无压力。
- **查询成本**：全部查询走索引（fingerprint UNIQUE / idx_findings_host / idx_findings_pool），P95 <5ms；vuln_stats 为 4 个聚合 COUNT，<2ms。
- **写成本**：单行 UPDATE/INSERT，事务持有时间 <1ms，多 worker 并发下 SQLITE_BUSY 概率可忽略（busy_timeout 5s 兜底）。
- **瓶颈前瞻**：唯一需要预留的是 http-remote 模式的同步器吞吐（远端 RTT），已由 outbox 异步化解耦。

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

| v4 代码位置 | 函数/段落 | v5 落点 |
|---|---|---|
| asset-db.js L309-366 | `addFinding`（噪声闸门+完整性闸门+弱/强指纹+补全升级） | 拆两半：完整性闸门/五要素 → C1 网关不变量 INV-4；机器宽容路径（noise=1、弱指纹、dup:true）→ C2 `commands/register-candidate.js`；弱指纹命中升级段（L331-348）→ C1 的 promote 分支（`commands/register-signal.js`）+ `repository.mergeCandidate` |
| asset-db.js L1521-1524 | `findingGet` | Q2 `queries/get.js` + `repository.getFinding` |
| asset-db.js L1526-1558 | `updateFinding`（200 行混合动词） | 按语义拆分：status=confirmed → C3；false_positive/dup/ignored → C4；submitted/accepted + bounty/vendor_status → C5；note 追加（L1547-1550）→ C6；FGS 直调（L1544-1546）→ fgs 域订阅事件（§2.3）；eval 回流（L1553-1556）→ eval 域订阅（15-eval.md §1.5） |
| asset-db.js L538-563 | `queryFindings/countFindings/findingWhere` | Q1 `queries/list.js`——findingWhere 升级为域内谓词构造器（visibility/claim_state 进谓词），rows 与 total 同源（宪法 §七.3 契约测试强制） |
| asset-db.js L565-580 | `stats()` 的 findings/findings_noise/by_severity/by_status | Q4 `queries/stats.js`——**口径修正**：findings_noise（只看 noise 列）→ candidate.pending（noise=1 AND status='new'） |
| asset-db.js L1561-1567 | `appendLiveEval` | 移出本域 → eval 域订阅 signal.confirmed/rejected 后执行 eval_case_append |
| asset-db.js L1594-1664 | `buildReport` | **归 report 域**（report_build，经 vuln_list 跨域取数）——报告与提交草稿均归 report 域（终审方案 A：report owns `reports/` 全树含 submissions/） |
| asset-db.js L1818-1865 | `submissionDraft` | **归 report 域** `report_draft_submission`（查重段抽出为 Q6 供其跨域调用）；旧工具名经总线别名指向 |
| asset-db.js L1808 | `opsHealth` 的 findings_noise | 改调 Q4（opsHealth 其余指标归各自域/总线聚合） |
| asset-graph.js L139-198 | `finding_add` 工具（schema+FGS 自动创建段 L168-196） | schema → manifest 命令 schema（ToolProjector 投影）；FGS 自动创建段 → fgs 域订阅 signal.registered + C10 回写 |
| asset-graph.js L200-216 | `finding_query` 工具 | Q1 投影（include_noise/noise 参数 → visibility） |
| asset-graph.js L218-231 | `submission_draft` 工具 | 别名 → report 域 `report_draft_submission` 投影（本域不注册） |
| asset-graph.js L276-289 | `finding_update` 工具 | **删除**——别名分派（§3.2） |
| dashboard-rpc.js L283-296, L375-388 | `findings`/`findingGet`/`findingUpdate` case | RpcProjector 自动投影（§1.7）；FINDING_TAG_STATUS 枚举随之消亡 |
| webhook.js L54 | xray → addFinding | 接收器留 exec 域边缘 → C2（actor=webhook） |
| sec-suite.js L1579-1587 | authz_diff suspected → addFinding | exec 域 → C2（actor=script, identity=authz_diff:{session_id}） |
| sec-suite.js L1785-1845 | intel_hunt（产 N-day 任务，不写 findings） | 不变（task 域实体），无本域迁移项 |
| parsers.js L158-171 | applyParsedResult findings 段 | `exec.run.completed` 事件 proposal → 本域 on_parser_proposal → C2（actor=script, identity=parser:{tool}:{run_id}） |

### 3.2 兼容别名与观察期

总线维护 `aliases` 映射（别名同样过网关全管线，不绕校验）；观察期一个调度周期（7 天），audit 记 `deprecated_use`，零使用后删除（宪法 §十五）：

| v4 工具/RPC 名 | 分派目标 | 分派规则与兼容期行为差异 |
|---|---|---|
| `finding_add` | **按 actor 分派**：model/human → `vuln_register_signal`；webhook/script → `vuln_register_candidate` | 兼容期宽容：同指纹异参重放时别名层把 E_IDEMPOTENT_CONFLICT 转译为 v4 形状 `{ok:true, dup:true, id}`（存量 prompt/脚本依赖 dup 语义）；severity=info 在别名路径保留 v4 行为（降级候选）而非拒绝——**仅别名期**，新路径严格执行 INV-4 |
| `finding_update` | **按 status 参数分派**：confirmed → `vuln_confirm`；false_positive/dup/ignored → `vuln_reject`（status→verdict；兼容期 dup 缺 dup_of 时域内自动以同 host+同 vuln_type 最高候选行填充，查不到留空——观察期后必填）；submitted → `vuln_submit`；accepted → `vuln_submit(vendor_status=accepted)`；status=当前值且带 note → `vuln_note`；status=new（回退）→ E_STATE | 兼容期差异：v4 不校验流转顺序（任何 status→任何 status），别名层放行 v4 合法子集，其余 E_STATE；**confirm 别名缺 evidence 时报 E_EVIDENCE_REQUIRED 并附 hint**（行为收紧是本次重构目的本身，不做宽容） |
| `finding_query` | `vuln_list` | include_noise=true → visibility=all；noise='1' → visibility=candidate；其余参数直传 |
| `submission_draft` | **`report_draft_submission`（report 域跨域别名）** | 直传（本域别名表登记转发；INV-R6 对未确认行拒绝——v4 允许，收紧） |
| RPC `findings` / `findingGet` / `findingUpdate` | `vuln.list` / `vuln.get` / 按 finding_update 同规则分派 | 看板 client.js 的 RPC 名同步改写（Phase 5 随域视图插件化） |

prompt 引用同步：persona/objective/skills/technique-index 中的 finding_add/finding_update 引用由脚本化改写（复用 p14-1-tool-refs.py 模式），改写后 discipline-audit.py 增加"悬空工具引用"断言。

### 3.3 数据迁移脚本要点

#### 第一节 · Phase 0 热修（立即执行，不等 v5——止血）

1. **updateFinding 联动 noise**（asset-db.js 热修）：status 进入 confirmed/submitted/accepted 时同事务 `noise=0`；进入 false_positive/dup/ignored 时保持 noise 但依赖口径修正出池。单测：确认→候选计数 −1 ∧ 信号计数 +1；重复确认幂等。
2. **KPI 口径**：`stats().findings_noise` 与 `opsHealth().findings_noise` 改为 `COUNT(*) WHERE noise=1 AND status='new'`。
3. **56 行僵尸数据修复脚本**（`p-v5-0-fix-noise.js`，幂等可重跑）：
   - 前置：silksec-backup VACUUM INTO 快照先行（回滚保障）；
   - `UPDATE findings SET noise=0 WHERE noise=1 AND status IN ('confirmed','submitted','accepted')` —— **31 条 confirmed 僵君归位信号面**；
   - 其余 25 条终态滞留（dup 7 + fp 5 + ignored 13）不动 noise，靠口径修正自动出候选计数；
   - dry-run 模式（只打印将改行）+ 修复后断言三口径一致（信号面 41 = 10+31；candidate.pending = 2；terminal_in_pool = 25）；audit 记 `kind:'migration'`。
   - **这是止血不是根治**（actor 仍混杂、updateFinding 仍是自由态动词）——根治在 Phase 1 本域上线。

#### Phase 1 正式版（随域上线）

1. `p-v5-1-migrate-vuln.js`：复跑 Phase 0 修复（幂等，应零变更）+ ensureCol 补 claimed_by/claimed_at/updated_at + `UPDATE findings SET updated_at=created_at WHERE updated_at IS NULL` 回填。
2. 契约测试全绿后切流：工具/RPC 双投影 + 别名层上线（§3.2），观察 1 周（audit 监控 deprecated_use 频次）。
3. 验收（Phase 1 出口条件）：模拟 xray webhook 重放 / 人工确认 / parser 入库**三路写同一候选**，`vuln_candidates.total` 与 `vuln_stats.candidate.pending` 与看板徽章三处一致；audit 三条记录 actor 可区分。
4. 删兼容层 + prompt 改写（Phase 5）。

---

## 四、开放问题

1. **accepted 流转的动词收敛**：目前 vendor 翻案（accepted→重复/驳回等）只能走 dashboard 通道 vuln_submit 附 operator 审计。是否拆独立 `vuln_adjudicate`（vendor 裁决动词）待运营实际发生频次决定。
2. **候选池老化**：terminal_in_pool（25 行历史候选遗骸）与长期未消化 new 候选（>90 天）是否引入 STALE/归档策略（memcore 式 lifecycle）——倾向 Phase 2 后按候选池实际积压情况评估。
3. **http-remote 远端选型与契约版本**：外部漏洞管理系统未定（自建 vs 商用）；REST 映射按 §2.4 通用形状设计，适配层收口在 backend 插件，Phase 4 试点时定稿。
4. **vuln_claim 批量化**：worker 批量消化时逐条 claim 的往返成本——是否提供 `vuln_claim_bulk`（≤50 行单事务行级结果）。
5. **program_id 自动归属注入点**：v4 resolveProgramId 经 session/workspace 推导；v5 该推导属 scope 域查询，注入点应在网关 ctx（命令层不感知）——待 08-scope.md 定稿对齐。
6. **dup_of 自动推荐**：verdict=dup 时 dup_of 目前必填；可否在错误 hint 中内嵌 vuln_dedup_check 的 top-3 候选降低模型重试成本。

