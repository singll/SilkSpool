# 08 · scope 域设计（授权白名单 / 项目镜像 / 排除 / 凭据引用 / 规则）

> 版本：v5.0 ｜ 状态：定稿 ｜ 契约版本：1
> 依赖：订阅 [`approval.approved`](09-approval.md)（授权类 kind 批准 → 本域执行 grant/rules）；被订阅：`scope.rules.changed`（exec 域令牌桶与风险闸缓存）、`scope.granted`（task 域种子任务链 + ledger 域 radar 追加）。
> 最高约定：[00-conventions.md](00-conventions.md)；本文与它冲突时以它为准。

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 域名 | `scope`（authz 统一授权域 = 授权 + 排除 + 规则 + 凭据引用，见宪法 §二脚注） |
| cordis 服务名 | `secDomain.scope` |
| 插件包名 | `@silksec/sec-domain-scope` |
| 后端插件 | `@silksec/sec-backend-scope-sqlite`、`@silksec/sec-backend-scope-file`（混布，见 §2.4） |
| owns（单写者） | `data/scope.yml`（+ `.bak`/`.tmp` 瞬态）、`programs` 表、`credentials` 表 |
| 事件 jsonl | `data/events/scope.jsonl` |

**域职责一句话**：持有全系统唯一的授权白名单（fail-closed 真相源），维护项目运行态镜像与工作区绑定，管理排除清单、扫描规则（QPS/风险上限/侵入工具白名单）与凭据引用，并向 exec 守卫链提供目标授权判定的规范查询。

**凭据并入授权域的设计论证**（为什么 credentials 不是独立域）：凭据的**可用范围必须与授权范围一致**——给一个 scope 之外的目标登记可用凭据，等于为越界扫描预备了弹药；反之，授权范围内的凭据缺失会影响任务派发判断。这条不变量（"凭据 host ∈ scope"）只有在凭据写入与授权白名单处于**同一域、同一事务边界前的同一网关校验链**时才能被强制执行：拆成两个域则校验退化为跨域读依赖，写入方可以绕开（v4.x `credAdd` 对 host 是否授权零校验即是实例）。因此 credentials 表随授权语义并入 scope 域；凭据**值**仍零明文（只存 ref 引用，宪法 §十四.4），明文本体在 `.env`（600）。

**命令命名空间声明**：本域命令使用三个对象前缀——`scope_*`（授权条目/排除/规则）、`program_*`（项目镜像与绑定）、`cred_*`（凭据引用）。三个前缀由本域在总线注册表独占，等价于宪法 §二 `{domain}_{对象?}_{动作}` 中"对象即子命名空间"的域内细化，不与其他任何域冲突。

**AUTHORITY.md（prompt 层授权声明资产）**：`data/AUTHORITY.md` 是与 scope.yml 同级重要的**运行资产**——操作员授权声明（向模型声明：本系统由资产所有者授权运营、scope.yml 是唯一授权权威、合规约束边界），作用是防止模型安全护栏在授权范围内误判拒答（已授权渗透测试场景的模型自我审查问题）。

| 项 | 机制 |
|---|---|
| 注入方 | DSH 平台层（AGENTS.md / 会话系统 prompt 组装时随文件注入）——**非本域注入**：AUTHORITY.md 是"人对模型说的话"，属 prompt 资产不属域数据；本域只声明其存在与语义 |
| 刷新 | 静态声明随 bundle 版本部署（内容是"操作员身份与授权原则"，不随 scope 条目变化——**不含任何具体授权条目**，条目永远只在 scope.yml） |
| 与 scope.yml 的关系 | **声明 vs 真相**：AUTHORITY.md 帮模型理解"为什么这些目标是合法的"；scope.yml 决定"哪些目标实际可打"。两者冲突时**机器判定胜**（G4 守卫照拒）——AUTHORITY.md 无扩权效力，写"全互联网已授权"也不会放行任何目标 |
| 所有权 | 文件本体不进本域 owns（域 owns 是数据单写者律，它是 prompt 资产）；变更走 bundle 模板 + git 评审（18-migration §9.5） |

**挂载矩阵**（profile × actor 白名单 → 实际工具集；模型不可用的动词根本不向模型注册，宪法 §三.2）：

| profile | 注册给模型的工具 | 仅看板/人工/事件驱动的动词 |
|---|---|---|
| web（宿主面） | `scope_check` / `scope_list` / `program_list` / `cred_add` / `cred_query` | `scope_grant` / `scope_revoke` / `scope_exclude` / `scope_rules_apply` / `program_bind_workspace` / `program_archive`（actor: approval/dashboard/human/system） |
| headless（worker） | 同上（worker 需要 scope_check 自查与凭据登记） | 同上（同样不向 worker 注册——模型禁改 scope） |

### 1.2 命令（写动词）总表

| 命令 | 一句话语义 | actor 白名单 | 幂等键 | 发布事件 |
|---|---|---|---|---|
| `scope_grant` | 向项目追加授权条目（新建项目亦可）；通配条目自动配对裸域；吸收冲突排除项 | approval / dashboard / human / system | 自然键 `{program}:{entries 指纹}` | `scope.granted` |
| `scope_revoke` | 从项目移除授权条目；条目清空 → 整项目出 yml + programs 行归档（fail-closed 立即生效） | approval / dashboard / human / system | 自然键 `{program}:{entries 指纹}` | `scope.revoked` |
| `scope_exclude` | 向项目追加排除条目（须与任何授权互斥） | approval / dashboard / human / system | 自然键 `{program}:{entries 指纹}` | `scope.excluded` |
| `scope_rules_apply` | 对全局 defaults 或项目 rules 应用一份通过校验的规则补丁（QPS/风险级/侵入白名单增删） | approval / dashboard / human / system | 自动指纹（target+patch sha1） | `scope.rules.changed` |
| `program_bind_workspace` | 项目 ↔ DSH 工作区 1:1 软绑定 / 解绑 | dashboard / human / system | 自然键 `{program}` | `program.bound` |
| `program_archive` | 归档 programs 镜像行（数据归属保留；前提：已不在 yml） | dashboard / human / system | 自然键 `{program}` | （无） |
| `cred_add` | 登记凭据**引用**（绝不存明文）；host 必须在授权范围内 | model / script / human | 自然键 `(program_id,host,cred_type,ref)` | （无） |

> 命名说明：种子设计（归档 §4.7）中的 `scope_set_rules` 因宪法 §二禁用词（`set`）更名为 `scope_rules_apply`——"应用一份经校验的规则补丁"是一次带前置不变量的规则状态流转，不是自由态写入口。起草期名称 `scope_set_rules` 在总线别名表注册一个观察期别名，避免文档间引用断裂（§3.2）。

### 1.3 命令逐个详述

#### 1.3.1 `scope_grant`

向指定项目追加授权条目。项目不存在时创建（新建分支接受项目元数据可选项）；已存在时追加。这是审批批准链（`approval.approved` → scope 域订阅 → `scope_grant`）与看板授权视图共用的唯一授权写入口。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `program_name` | string | 是 | — | `^[a-z0-9][a-z0-9-]{0,62}$`；失败 `E_SCOPE_PROGRAM_NAME_INVALID` |
| `entries` | string[] | 是 | — | 1..200 条，逐条格式校验（不变量 I1，§2.2）；失败 `E_SCOPE_ENTRY_INVALID`（message 指明第几条与原因） |
| `platform` | string | 否 | `''` | ≤64 字符；**仅新建项目时生效**，存量项目传入则忽略并在 data.note 提示 |
| `finding_db` | string | 否 | `''` | 路径形态 `^[^\\s]+$`；仅新建项目时生效（见开放问题 O-2） |
| `max_risk` | string | 否 | `'active'` | enum `passive/active/intrusive`；仅新建项目时生效 |
| `fixed_egress_ip` | boolean | 否 | `false` | 仅新建项目时生效 |

**通配双条目语义**：`entries` 中的 `*.x.com` 条目由域**自动配对**补入裸域 `x.com`（对齐 v4.x qiandai/mobike/keeta 现存双条目形态——裸域本身是 `*.后缀` 匹配的包含项，但显式双条目防止未来匹配语义变更时裸域失覆盖）。配对是单向的：传 `*.x.com` 自动补 `x.com`；只传 `x.com` 不自动加通配（单域授权走 approval `scope-domain`，整域走 `scope-wildcard`，口径在 09 §1.3.1）。`data.granted` 返回**实际新增**的条目（含自动配对项，排除已存在项）。

**排除吸收语义**（互斥不变量 I2 的维持动作）：若新条目命中**本项目** exclude 清单 → 同一命令内从 exclude 移除该冲突项（`data.removed_excludes` 列出），且若移除后该 host 仍不被本项目 scope 覆盖则同时并入 scope 列表。命中**其他项目** exclude 清单 → `E_SCOPE_MUTUAL_EXCLUSION`（fail-closed，须先协调该项目）。

**返回信封**（成功）：

```json
{
  "ok": true, "domain": "scope", "cmd": "grant",
  "data": {
    "program_name": "example-src", "program_created": false,
    "granted": ["*.example.com", "example.com"],
    "skipped_existing": ["10.0.0.0/24"],
    "removed_excludes": [],
    "scope_size": 12
  },
  "event_ids": ["evt_01J..."], "idempotency_key": "scope:grant:example-src:sha1:9c2f...", "replay": false
}
```

**错误码**：

| code | 触发 | retryable | hint（写给模型/调用方的自我纠错指引） |
|---|---|---|---|
| `E_SCHEMA` | 参数类型/必填/未知参数 | false | message 含字段与期望 |
| `E_SCOPE_PROGRAM_NAME_INVALID` | 项目名不合规范 | false | 项目名须匹配 `^[a-z0-9][a-z0-9-]{0,62}$`，先用 scope_list 查现有项目名 |
| `E_SCOPE_ENTRY_INVALID` | 条目格式不合法 | false | 条目只接受：字面域名 / IP 字面量 / `*.domain` 后缀通配 / IPv4 CIDR（`a.b.c.d/0-32`）；IPv6 CIDR 暂不支持 |
| `E_SCOPE_MUTUAL_EXCLUSION` | 条目命中其他项目排除清单 | false | 该目标在项目 X 的排除清单中——先与 X 协调（或经 approval 提请 exclude-exception）再授权 |
| `E_SCOPE_EMPTY_SCOPE` | （内部防御）规范化后条目集为空 | false | entries 至少一条有效条目 |

**幂等**：自然键 `scope:grant:{program_name}:{sha1(entries 排序去重后 join)}`。同键同参重放 → 首次结果 + `replay: true`。数据级幂等另行存在：对已在 scope 的条目再次 grant 不报错，计入 `skipped_existing`（yml 可能被外部改动，宽松合并是安全方向——扩大授权的重复无害，`scope.granted` 只对实际新增发事件）。

**actor**：approval（`approval.approved` 订阅执行，事件携带 request_id）/ dashboard（operator 必填，进审计）/ human（CLI 直调应急，审计高亮）/ system（迁移窗口）。**model 不在白名单**——模型禁改 scope 是本域的第一安全边界（宪法 §三）。

**RoE / agent_note**（投影层描述摘录，全文见 §1.6）：本动词不向模型注册。approval 订阅处理器必须以事件 payload 中的 program/entries 原样派发，不得自行扩充条目（网关侧不变量 I2 兜底）。

**副作用声明**：`rows_touched: programs(镜像 upsert)`、`files: scope.yml + .bak`、`events: scope.granted`、`caches: 域内快照失效`。

#### 1.3.2 `scope_revoke`

从项目移除授权条目。**fail-closed 立即生效**：yml 落盘后，下一次 exec 守卫链的 `scope_check` 即拒绝该目标（守卫每次实时读域快照，无缓存滞留）。条目移除后项目 scope 为空 → 整个项目从 yml 移除 + programs 行归档（数据归属保留：资产/漏洞/任务的 program_id 外键不受影响）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `program_name` | string | 是 | — | 项目须在 yml；不在 → `E_NOT_FOUND` |
| `entries` | string[] | 是 | — | 1..200 条；每条须**逐字**存在于该项目 scope 列表（不做语义展开），任一不存在 → `E_NOT_FOUND`（hint 引导先 `scope_list` 核对现状——yml 可能被外部改动） |

**返回信封**（成功）：

```json
{
  "ok": true, "domain": "scope", "cmd": "revoke",
  "data": {
    "program_name": "example-src", "revoked": ["*.example.com", "example.com"],
    "program_removed": true, "programs_archived": true,
    "note": "已从 scope.yml 移除（fail-closed 立即生效），programs 表归档保留归属"
  },
  "event_ids": ["evt_01J..."], "idempotency_key": "scope:revoke:example-src:sha1:...", "replay": false
}
```

**错误码**：`E_SCHEMA` / `E_NOT_FOUND`（项目或条目不存在，hint：`先用 scope_list 核对项目当前条目——yml 可能已被 spool sync 或人工修改`）。

**幂等**：自然键 `scope:revoke:{program_name}:{sha1(entries)}`。重放语义同上；重复 revoke 不存在的条目走 `E_NOT_FOUND`（收紧方向严格，防止静默漂移）。

**actor**：approval / dashboard / human / system。model 不可用。

**RoE**：revoke 是破坏性动作（下个调度周期起该范围全部任务被守卫拒绝）。看板调用必须二次确认；audit 记录 before/after 全量条目快照。

**副作用声明**：`rows_touched: programs(archive)`、`files: scope.yml + .bak`、`events: scope.revoked`、`caches: 域内快照失效`。

#### 1.3.3 `scope_exclude`

向项目追加排除条目。排除语义：checkTarget **先于 scope 匹配**检查全项目 exclude（§1.4.1 算法第 3 步），命中即 fail-closed 拒绝——用于从通配授权中挖掉敏感子域（如 `*.example.com` 授权、`pay.example.com` 排除）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `program_name` | string | 是 | — | 项目须在 yml → `E_NOT_FOUND` |
| `entries` | string[] | 是 | — | 1..200 条，格式校验同 I1；**互斥校验**：任一条目命中**任何项目**的 scope 覆盖范围（按 §1.4.1 匹配语义，非逐字比对）→ `E_SCOPE_MUTUAL_EXCLUSION`（先 revoke 再排除；本项目的例外：与本项目 scope 条目重叠本身就是排除的典型用法——**排除允许覆盖本项目已有授权**，互斥校验仅针对其他项目） |

> 设计取舍：排除条目与**本项目**授权重叠是合法且常见的（从 wildcard 挖洞）；与**其他项目**授权重叠则产生跨项目语义冲突（A 授权而 B 排除，checkTarget 按 yml 顺序谁先谁赢——v4.x 的隐式顺序依赖），v5 一律拒绝，消除顺序敏感。

**返回信封**：`data: { program_name, excluded: [...], exclude_size }`；事件 `scope.excluded`。

**错误码**：`E_SCHEMA` / `E_NOT_FOUND` / `E_SCOPE_ENTRY_INVALID` / `E_SCOPE_MUTUAL_EXCLUSION`（hint：`该目标已授权给项目 X——先对 X scope_revoke，或走 approval 提请 exclude-exception 重新评估`）。

**幂等**：自然键 `scope:exclude:{program_name}:{sha1(entries)}`；数据级幂等：已在 exclude 的条目计入 skipped。

**actor**：approval / dashboard / human / system。model 不可用。

**RoE**：排除是收紧动作，出错方向安全；但移除排除必须经 `scope_grant` 的吸收语义（授权吸收排除），不存在"纯移除排除"动词（开放问题 O-3）。

#### 1.3.4 `scope_rules_apply`

对**全局 defaults** 或**项目 rules** 应用一份规则补丁。这是 `rate_limit_qps` / `allow_intrusive_tools` / `max_risk` / `fixed_egress_ip` / `allow_risk` 的统一变更动词（v4.x 散落在 `scopeSaveProgram` 的整程序覆写中，任何一次界面保存都会全量重写规则——v5 收敛为显式补丁，每次只动声明的字段）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `target` | string | 是 | — | enum `defaults` / `program` |
| `program_name` | string | target=program 时必填 | — | 项目须在 yml → `E_NOT_FOUND`；target=defaults 时必须缺省（传了 → `E_SCHEMA`） |
| `rate_limit_qps` | integer | 否 | — | 1..1000；仅 defaults 级有效（项目级无此字段，传入 → `E_SCOPE_RULES_INVALID`） |
| `allow_risk` | string[] | 否 | — | `passive/active` 的非空子集（`intrusive`/`manual` 永远不允许进 defaults.allow_risk——那是审批白名单的事）；仅 defaults 级 |
| `max_risk` | string | 否 | — | enum `passive/active/intrusive`；仅 program 级 |
| `fixed_egress_ip` | boolean | 否 | — | 仅 program 级 |
| `allow_intrusive_tools_add` | string[] | 否 | `[]` | 工具名，每条 `^[a-z0-9][a-z0-9_-]{0,63}$`；仅 program 级 |
| `allow_intrusive_tools_remove` | string[] | 否 | `[]` | 同上；与 add 交集 → `E_SCOPE_RULES_INVALID` |

**补丁原子性**：全部字段同一次 yml 原子写生效；patch 至少含一个字段（空补丁 → `E_SCHEMA`）。

**返回信封**：

```json
{
  "ok": true, "domain": "scope", "cmd": "rules_apply",
  "data": {
    "target": "program", "program_name": "example-src",
    "before": { "allow_intrusive_tools": ["ffuf"] },
    "after":  { "allow_intrusive_tools": ["ffuf", "sqlmap"] }
  },
  "event_ids": ["evt_01J..."], "idempotency_key": "scope:rules_apply:sha1:...", "replay": false
}
```

**错误码**：`E_SCHEMA` / `E_NOT_FOUND` / `E_SCOPE_RULES_INVALID`（hint：message 指明字段与合法域；QPS 取值 1..1000；`allow_intrusive_tools_add/remove` 不得交集）。

**幂等**：自动指纹 `sha1(target + program_name? + patch 核心字段)`。数据级幂等：补丁目标值已是现状 → `data` 中 before==after，正常成功（不报错）。

**actor**：approval（`tool-intrusive` 批准链）/ dashboard / human / system。model 不可用。

**RoE / agent_note**：本动词不向模型注册。`approval.approved(kind=tool-intrusive)` 订阅处理器以 payload.tool 派发 `allow_intrusive_tools_add: [tool]`，其余字段一律不碰。

**副作用声明**：`files: scope.yml + .bak`、`events: scope.rules.changed`（**exec 域强联动订阅**：令牌桶容量 / 风险上限缓存 / 侵入白名单即时刷新——替代 v4.x mtime 轮询，见 §1.5.3）、`rows_touched: programs(镜像 max_risk)`。

#### 1.3.5 `program_bind_workspace`

项目 ↔ DSH 工作区 1:1 软绑定（P11 工作区融合的域化）。绑定后 `programByWorkspacePath` 供 task 域按会话 cwd 自动归属项目。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `program_name` | string | 是 | — | 项目须在 programs 表（yml 或 archived 镜像）→ `E_NOT_FOUND` |
| `workspace` | string \| null | 是 | — | 工作区**标题或路径**（与 v4.x 声明口径一致）；`null` = 解绑。解析经 workspaceRegistry 适配器（§2.4），找不到 → `E_NOT_FOUND`（hint：`工作区不存在——先用 workspaces 查询核对标题/路径`） |

**返回信封**：`data: { program_name, workspace_id, workspace_path, unbound: false }`；事件 `program.bound`。

**错误码**：`E_SCHEMA` / `E_NOT_FOUND`（项目或工作区）/ `E_CAPABILITY_UNSUPPORTED`（headless worker 进程无 workspaceRegistry——绑定动词只在 web 宿主面可用，worker 面投影不注册）。

**幂等**：自然键 `scope:bind:{program_name}`；重复绑定同一工作区 → 数据级幂等成功。

**actor**：dashboard / human / system。approval / model 不可用。

**RoE**：绑定失败不阻断任何业务（v4.x pairWorkspaces 的容错语义保留为看板交互语义）。

#### 1.3.6 `program_archive`

归档 programs 镜像行（`status: active → archived`）。**与 `scope_revoke` 的分工**：revoke 是"授权条目移除且条目清空时**自动**归档镜像行"；本动词是显式的镜像治理动作——用于 yml 已被外部（spool sync push / 人工编辑）移除项目后，补齐归档语义（外部写入路径的自动一致性校验通常已代劳，本动词是人工兜底）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `program_name` | string | 是 | — | 须在 programs 表且 `status='active'` → 不在/已归档 → `E_NOT_FOUND`；**仍在 yml 中 → `E_INVARIANT`**（须先 `scope_revoke` 移除授权，禁止"yml 活着、镜像死了"的分裂态） |

**返回信封**：`data: { program_name, status: "archived" }`；无事件（数据归属操作，看板轮询可见）。

**错误码**：`E_SCHEMA` / `E_NOT_FOUND` / `E_INVARIANT`（hint：`项目仍在 scope.yml 授权中——先 scope_revoke（条目清空自动归档），不要直接归档镜像`）。

**幂等**：自然键 `scope:archive:{program_name}`。

**actor**：dashboard / human / system。

#### 1.3.7 `cred_add`

登记凭据**引用**（绝不存明文，宪法 §十四.4）。ref 指向环境变量名或 credentials key；role 记录角色（越权矩阵用）。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `program_id` | string | 否 | `null` | 须在 programs 表（active）→ `E_NOT_FOUND` |
| `host` | string | 否 | `''` | 非空时经 §1.4.1 算法判定**必须在授权范围内** → `E_SCOPE_CRED_HOST_OUT_OF_SCOPE`（**同域不变量 I5**，本域存在核心理由，见 §1.1 论证） |
| `cred_type` | string | 否 | `''` | ≤32 字符（cookie / token / basic …） |
| `ref` | string | 是 | — | `^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$`（环境变量名 / credentials key 形态）→ 违反 → `E_SCOPE_CRED_REF_FORMAT`；**引用存在性**：`process.env[ref] !== undefined`（宿主面）→ 不存在 → `E_SCOPE_CRED_REF_MISSING` |
| `role` | string | 否 | `''` | ≤64 字符（admin / user / …） |
| `note` | string | 否 | `''` | ≤500 字符，经脱敏规则扫描（出现 `=` 长串 / `Bearer ` 前缀等明文特征 → 拒绝） |

**返回信封**：`data: { id: 41, program_id: "example-src", host: "api.example.com", ref: "EXAMPLE_API_TOKEN" }`；无事件（凭据登记不进事件流——payload 最小化原则 + 事件 jsonl 不落任何凭据相关信息）。

**错误码**：

| code | 触发 | hint |
|---|---|---|
| `E_SCOPE_CRED_REF_FORMAT` | ref 不是引用形态 | ref 必须是环境变量名/credentials key（如 `EXAMPLE_API_TOKEN`），明文密钥禁止入库——先写入 .env 再登记引用 |
| `E_SCOPE_CRED_REF_MISSING` | 引用不存在 | ref 指向的环境变量在宿主环境不存在——确认 .env 已配置且服务已重启加载 |
| `E_SCOPE_CRED_HOST_OUT_OF_SCOPE` | host 不在授权范围 | 该 host 未授权（scope.yml fail-closed）——先经 approval 提请授权，凭据范围必须与授权范围一致 |
| `E_SCOPE_CRED_DUPLICATE` | 同 (program_id, host, cred_type, ref) 已存在 | 该引用已登记（id=N）——勿重复登记 |

**幂等**：自然键 `scope:cred:{program_id|''}:{host}:{cred_type}:{ref}`（域内判重，不加 DB 唯一约束——存量表可能有历史重复行，约束会阻断迁移；判重在网关不变量层完成）。

**actor**：model（worker 登记 harvested 凭据引用）/ script / human。dashboard / approval 不需要。

**RoE / agent_note**（全文见 §1.6）：登记是被动观察行为；ref 绝不是明文；host 必须先过 `scope_check` 自查。

**副作用声明**：`rows_touched: credentials(+1)`。

### 1.4 查询（读投影）逐个详述

#### 1.4.1 `scope_check` —— checkTarget 的只读预检版（规范定义）

**这是 checkTarget 完整算法的规范定义**，查询面与 exec 守卫链共用同一实现（§3.2 兼容性：exec 域守卫链经查询网关同进程直调本查询，物理上只有一份算法代码）。

**参数**：`target: string`（必填，接受 URL / host:port / 裸域 / IP 任意形态）、`program: string`（可选，限定只判指定项目的范围——用于审批 validate）。

**算法**（顺序强制，任何实现不得重排）：

1. **hostOf 归一化**：`trim` → 去 scheme（`^[a-z][a-z0-9+.-]*:\/\/` 前缀）→ 去路径/查询/锚（`split('/')[0].split('?')[0].split('#')[0]`）→ IPv6 字面量取 `[...]` 括号内 → 去尾部端口（`/:\d+$/` 才剥，防误伤 IPv6 冒号）→ **小写**。
2. 归一化结果为空 → `{ allow: false, reason: '无法解析目标' }`。
3. **exclude 先查**：遍历 programs（yml 声明序），任一项目的 exclude 条目命中 → `{ allow: false, reason: '目标在项目 X 的排除清单中', program: X, excluded_by: <entry> }`。
4. **scope 匹配**：遍历 programs（yml 声明序），任一项目的 scope 条目命中 → `{ allow: true, program: X, matched_entry, matched_kind, program_cfg }`。
5. **fail-closed**：全不命中 → `{ allow: false, reason: '目标不在任何授权项目范围内（scope.yml fail-closed）' }`。

**条目匹配规则**（`entryMatches`，大小写不敏感）：

| 条目形态 | 匹配语义 | 示例 |
|---|---|---|
| 含 `/`（CIDR） | host 可解析为 **IPv4** 且落网段内（`a.b.c.d/0-32`；IPv6 不支持——开放问题 O-4） | `203.0.113.0/24` 命中 `203.0.113.7` |
| `*.domain` | host **等于裸域本身** 或以 `.domain` 结尾 | `*.example.com` 命中 `example.com` 与 `a.b.example.com` |
| 字面值 | 精确相等（域名 / IPv4 / IPv6 字面量） | `api.example.com` |

**返回信封**：

```json
{ "rows": [{ "host": "www.example.com", "allow": true, "program": "example-src",
  "matched_entry": "*.example.com", "matched_kind": "wildcard",
  "reason": "命中项目 example-src 授权范围" }], "total": 1, "limit": 1, "offset": 0 }
```

**用途**：模型自查（打点前预检）、看板授权视图试一把、approval 域 validate（"已在 scope 无须审批"判定）、**exec 域守卫链 S-target 步的读依赖**（10-exec.md 的守卫链以本查询为 S1 前置；纯读、无副作用、不审计）。

#### 1.4.2 `scope_list`

**参数**：`include_archived: boolean = true`。

**返回**：`{ defaults: { egress_proxy, rate_limit_qps, allow_risk[] }, programs: [{ name, platform, scope[], exclude[], max_risk, fixed_egress_ip, workspace, finding_db, allow_intrusive_tools[], db: { status, workspace_id, workspace_path } | null }], archived: [programs 表中 status=archived 且不在 yml 的行] }`。yml 与 DB 镜像**同框返回**（v4.x scopeList 语义保留）——看板授权视图据此渲染"yml 有而镜像无"的分裂告警。

#### 1.4.3 `program_list`

**参数**：`status: '' | active | archived`（默认全部）、`limit=50（上限500）`、`offset=0`、`sort: id | status | updated_at`（默认 id asc）。

**返回**：programs 表行 `{ id, platform, status, max_risk, workspace_id, workspace_path, created_at, updated_at }`。行数=total 同口径（契约测试断言）。

#### 1.4.4 `cred_query`

**参数**：`program_id: string = ''`（精确）、`host: string = ''`（精确）、`limit=50（上限500）`。

**返回**：credentials 行 `{ id, program_id, host, cred_type, ref, role, note, created_at }` 按 created_at desc。**只返回引用，永不返回明文**（明文不存在于本域任何存储）。

### 1.5 事件

#### 1.5.1 `scope.granted`

```json
{
  "id": "evt_01J...", "domain": "scope", "name": "granted", "ts": 1789000000000,
  "actor": "approval", "session_id": null, "operator": null,
  "cause": { "cmd": "scope_grant", "idempotency_key": "...", "request_id": 57 },
  "payload": {
    "program_name": "example-src", "program_created": false,
    "entries": ["*.example.com", "example.com"],
    "removed_excludes": []
  }
}
```

payload 只含判据快照（program、条目、是否吸收了排除），不含 yml 全量。`request_id` 非空时标识本次授权源自审批 #57（approval 域决定是否透传——种子任务 objective 引用它）。

**订阅方**：

| 订阅域 | 模式 | 处理 |
|---|---|---|
| task 域（05） | async（弱） | **审批种子任务链**：`task_create`（objective 带 `[审批入队]` 前缀，once +5min，只做资产收集禁漏洞探测；同 program 同域幂等去重）。弱联动 + 事件日志可重放（v4.x enqueueScopeSeed 的 best-effort 语义保留：种子入队失败不影响授权生效） |
| ledger 域（11） | async（弱） | `ledger_radar_push`（radar-queue.jsonl 追加 `scope-approved` 事件，供每日 recon 链 radar_read 兜底——双通道的第二通道） |
| 看板通知 | async | 授权变更横幅 |

> 种子任务链的订阅方是 **task 域与 ledger 域**，不是 approval 域：approval 是联动源头、不订阅任何域（09 §1.5 有完整论证）；v4.x `enqueueScopeSeed` 内嵌在 onApprove 的跨域直写由此拆解为纯事件订阅。

#### 1.5.2 `scope.revoked`

payload：`{ program_name, entries[], program_removed: bool, programs_archived: bool }`。订阅方：看板通知（弱）。**无需 exec 订阅**——fail-closed 立即生效由"守卫每次实时查询"结构性保证（§2.5），不依赖事件传播。

#### 1.5.3 `scope.rules.changed`

```json
{
  "payload": {
    "level": "defaults", "program_name": null,
    "patch": { "rate_limit_qps": 120 },
    "before": { "rate_limit_qps": 50 }, "after": { "rate_limit_qps": 120 }
  }
}
```

**订阅方：exec 域（mode: sync，强联动）**——QPS 令牌桶容量、风险上限缓存、侵入工具白名单缓存即时刷新。**这是 v4.x mtime 轮询的替代**：v4.x `loadScope` 按 mtime 缓存重读、`acquireQpsToken` 每次取令牌时对账容量；v5 改为"域内命令写 → 强联动事件 → exec 缓存确定性刷新"，消除轮询窗口（轮询窗口内桶容量可能滞后一个令牌周期）。外部写入路径（spool sync / 人工）经 §2.5 的接管流程后由域**补发本事件快照**，同样走事件通道。

#### 1.5.4 `scope.excluded`

payload：`{ program_name, entries[] }`。订阅方：看板通知（弱）。

#### 1.5.5 `program.bound`

payload：`{ program_name, workspace_id, workspace_path, unbound: bool }`。订阅方：看板工作区视图刷新（弱）。

### 1.6 模型工具面投影（模型实际看到的工具名 + 描述全文）

以下 5 个工具向模型注册（web 与 headless 双 profile）；**1.2 节全部写动词不向模型注册**（actor 白名单无 model → 投影层物理不注册，负向保障第一层）。

| 工具名 | 描述全文（manifest agent_note 单一来源） |
|---|---|
| `scope_check` | 授权预检（只读）：检查目标是否在授权范围内。传入 URL/host 均可（自动归一化去 scheme/端口/路径）。返回 allow 与命中的项目。对目标执行任何主动操作前先用本工具自查；未授权目标必须走 approval_request 提请，禁止绕过。 |
| `scope_list` | 列出授权全景：全局默认策略（限速/风险级）+ 各项目的授权条目、排除清单、规则与工作区绑定。确认项目归属、排查"为什么目标被拒"时使用。 |
| `program_list` | 列出 programs 表（scope.yml 的运行态镜像）。项目是资产/漏洞/任务的顶层作用域。 |
| `cred_add` | 登记凭据引用（绝不存明文）。ref 指向环境变量名/credentials key，须已存在于宿主环境；host 必须先通过 scope_check（凭据可用范围与授权范围一致）。role 记录角色（越权矩阵用）。 |
| `cred_query` | 检索凭据引用（只返回引用，不返回明文）。按项目/host 过滤。 |

### 1.7 看板 RPC 投影

RPC 名 `{domain}.{verb}` 点分；写操作 actor=dashboard 且 operator 必填（auth-gate 用户身份，进审计）。

| RPC 名 | 对应命令/查询 | 说明 |
|---|---|---|
| `scope.grant` | scope_grant | 授权视图"新增授权"（替代 v4.x scopeSaveProgram） |
| `scope.revoke` | scope_revoke | 授权视图"移除授权"（替代 v4.x scopeDeleteProgram），二次确认 |
| `scope.exclude` | scope_exclude | 授权视图"加入排除" |
| `scope.rules.apply` | scope_rules_apply | 规则编辑（QPS/风险级/侵入白名单） |
| `program.bind_workspace` | program_bind_workspace | 工作区区块绑定（替代 v4.x programBindWorkspace） |
| `program.archive` | program_archive | 镜像归档兜底 |
| `scope.list` | scope_list | 授权视图主数据源 |
| `scope.check` | scope_check | 授权视图"试一把"预检框 |
| `program.list` | program_list | 项目下拉 |
| `cred.query` | cred_query | 凭据引用列表（授权视图子页） |

### 1.8 外部调用示例

**模型调用**（worker 会话内，tools.register 投影）：

```json
{ "tool": "scope_check", "args": { "target": "https://api.example.com:8443/v1" } }
→ { "ok": true, "data": { "host": "api.example.com", "allow": true, "program": "example-src", "matched_entry": "*.example.com", "matched_kind": "wildcard", "reason": "命中项目 example-src 授权范围" } }
```

**代码调用**（approval 域订阅 `approval.approved` 的处理器，经总线 dispatch）：

```js
// @silksec/sec-domain-scope 订阅处理器（manifest subscribes 声明，mode: sync）
bus.dispatch('scope', 'grant', {
  program_name: evt.payload.program_name,
  entries: evt.payload.kind === 'scope-wildcard'
    ? [`*.${evt.payload.subject}`, evt.payload.subject]   // 双条目语义
    : [evt.payload.subject],
}, { actor: 'approval', request_id: evt.payload.request_id })
```

**人工 / 脚本调用**（CLI 直调，actor=human，审计高亮）：

```bash
sec domain scope call scope_revoke --actor human \
  --program-name example-src --entries '["*.example.com","example.com"]'
# spool sync 协同（回收纪律，见 §2.5）：
spool sync pull csai        # 界面/审批写入后回收管理机副本，防下次 push 覆盖
```

---

## 二、内部实现（Internal）

### 2.1 数据模型（owner 声明：全部为本域单写者）

#### 2.1.1 `data/scope.yml`（file 后端，授权白名单真相源）

YAML 结构（格式与 v4.x 完全一致，**不迁移不改写**，仅由域原子写维护）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | int | 恒为 1 |
| `defaults.egress_proxy` | string | 出口代理（mubeng 网关地址）；exec 域代理注入读 |
| `defaults.rate_limit_qps` | int | 主动扫描全局限速（1..1000，默认 50）；**值归本域，令牌桶归 exec 域** |
| `defaults.allow_risk` | string[] | 默认可自动执行的风险级（子集于 passive/active）；intrusive 永远走审批白名单 |
| `programs[].name` | string | 项目名（主键，`^[a-z0-9][a-z0-9-]{0,62}$`） |
| `programs[].platform` | string? | 平台标识（src 平台名） |
| `programs[].scope[]` | string[] | 授权条目（I1 格式） |
| `programs[].exclude[]` | string[]? | 排除条目（I1 格式） |
| `programs[].rules.max_risk` | string | 项目风险上限（默认 active） |
| `programs[].rules.fixed_egress_ip` | bool | 固定出口报备（不走轮换代理） |
| `programs[].rules.workspace` | string? | 绑定的工作区标题或路径（声明式绑定，pairWorkspaces 解析） |
| `programs[].rules.allow_intrusive_tools[]` | string[]? | 侵入工具白名单（tool-intrusive 批准落点） |
| `programs[].finding_db` | string? | 历史 finding 指纹库路径 |
| `runtime.credentials_ref` | string | 恒为 `env`（凭据明文走 .env 引用；保留 v4.x 尾注） |

瞬态文件：`scope.yml.tmp`（原子写中转，写后即 rename）、`scope.yml.bak`（每次域写前备份，保留一代）。

#### 2.1.2 `programs` 表（sqlite 后端；沿用户库 `asset-graph.db`，**不改名不迁库**）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 项目名（= yml programs[].name） |
| `platform` | TEXT | 镜像自 yml |
| `status` | TEXT NOT NULL DEFAULT 'active' | `active` / `archived`（归档=数据归属保留） |
| `max_risk` | TEXT | 镜像自 yml rules.max_risk |
| `fixed_egress_ip` | INTEGER DEFAULT 0 | 镜像 |
| `workspace_id` | TEXT | 工作区绑定（program_bind_workspace / pairWorkspaces 写） |
| `workspace_path` | TEXT | 同上 |
| `created_at` / `updated_at` | INTEGER | UTC epoch ms |

无额外索引（主键 + 全表 <100 行）。

#### 2.1.3 `credentials` 表（sqlite 后端）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `program_id` | TEXT | 归属项目（可空） |
| `host` | TEXT | 凭据适用目标（须在授权范围，I5） |
| `cred_type` | TEXT | cookie / token / basic … |
| `ref` | TEXT | **引用**（环境变量名 / credentials key，非明文） |
| `role` | TEXT | 角色（越权矩阵用） |
| `note` | TEXT | 备注（经明文特征扫描） |
| `created_at` | INTEGER | UTC epoch ms |

无唯一约束（存量重复行风险，判重在网关层——见 1.3.7）。

### 2.2 状态机与不变量

**项目状态机**（yml 与镜像的联合状态）：

```
            scope_grant(首条目)
  (不存在) ──────────────────────> (yml 在档, programs.active)
                                       │      ▲
                     scope_revoke(条目) │      │ scope_grant/revoke/exclude/rules_apply
                                       ▼      │
                                  (条目增减, 仍 active)
                                       │
                     scope_revoke(清空最后条目) ──自动──> (yml 出档, programs.archived)
                                       │                        │
                                       │            program_archive（人工兜底，须 yml 已出档）
                                       ▼                        ▼
                                 scope.granted/revoked    （终态；scope_grant 可复活项目）
```

**网关前置不变量清单**（manifest invariants，CommandGateway 事务前逐条执行）：

| # | 不变量 | 失败错误码 |
|---|---|---|
| I1 | 条目格式：字面域名（LDH）/ IPv4·IPv6 字面量 / `*.domain` 后缀通配 / IPv4 CIDR（`/0-32`）；trim 后非空、小写规范化 | `E_SCOPE_ENTRY_INVALID` |
| I2 | **授权与排除互斥（跨全部项目）**：grant 的新条目不得命中其他项目 exclude（本项目命中→吸收）；exclude 的新条目不得命中其他项目 scope 覆盖 | `E_SCOPE_MUTUAL_EXCLUSION` |
| I3 | 项目 scope 至少一条授权条目：revoke 至空 ⇒ 整项目出 yml + programs 归档（同命令原子完成） | `E_SCOPE_EMPTY_SCOPE`（内部防御） |
| I4 | **credentials.ref 引用存在性**：ref 在宿主环境可解析（env 存在） | `E_SCOPE_CRED_REF_MISSING` |
| I5 | **凭据可用范围与授权一致**：cred_add 的 host（非空时）经 §1.4.1 算法 allow | `E_SCOPE_CRED_HOST_OUT_OF_SCOPE` |
| I6 | **scope.yml 三个写入方收敛为一个**：本域命令是唯一"经校验"写入口；外部物理写入（spool sync push / 人工 vim）被 §2.5 接管流程检测并代校验（actor=human 留痕）——不存在第三个未经检测的写入路径 | （结构保证 + 接管流程告警） |
| I7 | program_archive 前提：项目不在 yml（防"yml 活着、镜像死了"分裂态） | `E_INVARIANT` |
| I8 | rules 补丁约束：qps ∈ 1..1000；allow_risk ⊆ {passive,active}；add/remove 无交集；defaults 与 program 级字段不串用 | `E_SCOPE_RULES_INVALID` |

### 2.3 事务与联动实现

#### 2.3.1 serializeScope 原子写——**内化为域实现细节**

v4.x 的 `serializeScope`（sec-suite.js L320-367）从"外部可直调的函数"降级为域私有 `_persistScope`，**外部不再可见**。域内写路径固定七步（每个写动词共用）：

| 步 | 动作 | 失败语义 |
|---|---|---|
| ① | 构造规范化 yml 快照（内存）——条目排序去重、双条目配对、exclude 吸收结果 | 内存操作，无失败 |
| ② | `copyFileSync(scope.yml → scope.yml.bak)`（文件存在时） | 失败 → `E_BACKEND_UNAVAILABLE`，命令中止 |
| ③ | `writeFileSync(scope.yml.tmp, serialized)` | 同上 |
| ④ | `renameSync(tmp → scope.yml)`（原子） | 同上 |
| ⑤ | audit（网关统一记录，before/after 条目快照） | — |
| ⑥ | **syncPrograms 镜像**：yml 在档项目 upsert（active）；yml 出档项目 archive；BEGIN IMMEDIATE 单事务 | 失败 → 命令报 `E_BACKEND_UNAVAILABLE`，**yml 已写不回滚**（yml 是真相源，授权已生效方向安全）；镜像由下次任意命令的 ⑥ 或启动首跑自愈（幂等 upsert）；audit 记 `partial: mirror_pending` |
| ⑦ | pairWorkspaces 重配对（声明式 rules.workspace 解析 → workspace_id/path 回写）+ 域内快照缓存失效 + 发布事件 | 失败 → audit `subscriber_failed`，不影响命令结果（v4.x 绑定失败不阻断语义保留） |

**双仓（file+sqlite）无分布式事务**：采用"yml 真相源 + 镜像自愈"模式——授权语义只由 yml 决定（fail-closed 读路径只读 yml），镜像落后最多影响看板展示与 task 归属推断，且可由幂等 ⑥ 收敛。这是显式取舍，不追求伪原子。

#### 2.3.2 联动分级汇总

| 事件 | 订阅方 | 模式 | 失败语义 |
|---|---|---|---|
| `scope.rules.changed` | exec 域（缓存刷新） | **sync 强** | 失败 → rules_apply 整体回滚报错（风险上限/白名单变更须确定性生效） |
| `scope.granted` | task 域（种子任务）/ ledger 域（radar） | async 弱 | audit `subscriber_failed` + 事件日志可重放（`sec bus replay`） |
| `scope.granted/revoked/excluded/program.bound` | 看板通知 | async 弱 | 同上 |

#### 2.3.3 与 approval 域的协作（effect 执行方视角）

scope 域**不再订阅** `approval.approved` 事件——授权批准效果由 approval 域写 `approval_effects` 行（domain=scope, verb=grant/rules_apply），总线 dispatcher 经 CommandGateway 幂等执行 `scope_grant` / `scope_rules_apply`（actor=approval，cause 链带 request_id）。effect 失败 → approval 状态机停在 `approved_effect_failed`，`approval_reconcile` 对账后重试（09 §2.3）——v4.x "批准副作用失败 → 请求保持 pending，可修复后重试或驳回"语义由 effect outbox 承接。

scope 域 manifest `subscribes` 仅保留对下游自身事件的声明（`scope.rules.changed` 由本域发布、exec 域订阅；本域不订阅 approval 域）。

### 2.4 后端适配器

**repository 接口**（JSDoc，方法=原语，无 SQL 语义无业务校验）：

```js
// file 仓（scope.yml）
ScopeFileStore.readSnapshot() -> { version, defaults, programs[] } | null
ScopeFileStore.writeSnapshotAtomic(serializedYaml) -> void       // tmp+rename+.bak，§2.3.1 ②-④
ScopeFileStore.watch(onChange) -> dispose                         // mtime 检测，§2.5
// sqlite 仓（programs/credentials）
ProgramRepo.upsert({id, platform, max_risk}) / archive(id) / list() / get(id)
ProgramRepo.bindWorkspace(id, workspace_id|null, workspace_path|null)
CredRepo.insert({program_id, host, cred_type, ref, role, note}) / listWhere({program_id, host, limit})
```

**三后端能力矩阵**（`sec_domain_scope_backend` 混布配置：`file+sqlite-local`，默认且当前唯一组合）：

| 命令/查询 | file（scope.yml） | sqlite-local（programs/credentials） | http-remote |
|---|---|---|---|
| scope_grant / revoke / exclude / rules_apply | full | full（镜像列） | **unsupported**（授权数据不出本机——安全基线；多主机场景待开放问题 O-5） |
| program_bind_workspace / program_archive | n/a | full | unsupported |
| cred_add / cred_query | n/a | full | unsupported |
| scope_list / scope_check / program_list | full | full | unsupported（同上） |

http-remote 全列 unsupported 的理由：**授权白名单与凭据引用是安全边界数据**，外发到远端即引入"远端失陷 ⇒ 授权失陷"的放大面；`E_CAPABILITY_UNSUPPORTED` fail-closed（宪法 §十二.3），不静默降级。programs/credentials 表沿用 `asset-graph.db`（不迁库，README §六）。

### 2.5 缓存与失效

| 缓存 | 位置 | 失效 |
|---|---|---|
| 域内 scope 快照 `{ mtime, data }` | 域进程内存 | ① 域命令写后主动失效；② **外部写入检测**：`fs.watch` mtime 变化（1s 去抖）且非本域写 → 触发接管流程（下） |
| exec 令牌桶容量 / 风险上限 / 侵入白名单 | exec 域内存 | 订阅 `scope.rules.changed`（强联动）刷新——**替代 v4.x mtime 轮询** |
| programs/credentials | 无缓存 | 直查（量小） |

**外部写入接管流程**（不变量 I6 的执行机制——"三个写入方收敛为一个"的完整语义）：

v4.x scope.yml 有三个写入方：serializeScope（域内）、spool sync push（运维通道）、人工 vim（例外路径）。v5 收敛原则：**域命令是唯一"经校验"写入口；外部物理写入不被禁止（运维现实），但必须被检测、代校验、留痕**：

1. mtime 检测到非本域写入 → 以 actor=human 重载快照；
2. parse 校验：失败 → 告警事件 + 看板红条 + audit（`external_write_broken`），**不自动回滚**（.bak 在，人工决策恢复）；
3. 一致性校验：yml ↔ programs 镜像 diff → 自动补镜像（upsert/archive，幂等）；
4. 补发 `scope.rules.changed` 快照（defaults 级，before=null 标记 external）→ exec 缓存对齐；
5. audit 记 `external_write_adopted`（actor=human，含 diff 摘要）。

**spool sync 协同纪律**（v4.x 既定，v5 原样保留并写入域文档）：scope.yml 受 spool sync 管理——界面/审批写入后**必须** `spool sync pull csai` 回收管理机副本，否则下次 push 覆盖（接管流程会把覆盖后的状态当作又一次外部写入对齐，但授权条目丢失需要靠 .bak 恢复，故回收是纪律不是可选项）；`_persistScope` 序列化规范化会**丢弃注释**，回收后需人工补回关键注释（开放问题 O-6）。

### 2.6 性能与容量

| 项 | 现状 / 预期 |
|---|---|
| scope.yml | <100 项目 × 平均 <50 条目 ≈ <5,000 行条目；序列化 <200KB |
| `scope_check` 延迟 | O(programs × entries) 内存匹配，P99 <1ms（exec 守卫链每次 run_cli 调 1..N 次，不构成瓶颈） |
| 写命令 | ~5ms（文件 copy+write+rename + sqlite 事务），无高频调用方 |
| credentials | <5,000 行；cred_query 走 program_id/host 精确过滤 |
| 事件量 | 低频（审批批准/人工操作驱动，<10/天） |

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级，v4.7 时点源文件在 `bundles/dsh/templates/`）

| v4.x 位置 | 函数/段 | v5 落点 |
|---|---|---|
| `dsh-plugin-sec-suite.js` L320-367 | `serializeScope` | 域私有 `_persistScope`（§2.3.1 七步），**外部可见性归零** |
| `dsh-plugin-sec-suite.js` L374-413 | `scopeSaveProgram(spec, isNew)` | 拆解：`scope_grant`（条目追加+新建分支）+ `scope_rules_apply`（规则字段）+ `scope_exclude` |
| `dsh-plugin-sec-suite.js` L415-432 | `scopeDeleteProgram` | `scope_revoke`（清空条目 → 自动整项目移除+归档） |
| `dsh-plugin-sec-suite.js` L434-453 | `scopeList` | 查询 `scope_list`（yml+镜像同框语义保留） |
| `dsh-plugin-sec-suite.js` L262-275 | `syncPrograms` | 域内镜像步骤 ⑥ + 启动首跑 + 外部写入接管 3 |
| `dsh-plugin-sec-suite.js` L297-312 | `pairWorkspaces` | `program_bind_workspace` + 写路径步骤 ⑦ 自动重配对 |
| `dsh-plugin-sec-suite.js` L186-214 | `hostOf` / `entryMatches` / `cidrContains` / `ipToInt` | **唯一实现放本域**，`scope_check` 与 exec 守卫共用（§1.4.1 规范定义） |
| `dsh-plugin-sec-suite.js` L218-225 | `loadScope`（mtime 缓存） | 域内快照缓存 + 事件失效（§2.5） |
| `dsh-plugin-sec-suite.js` L931-947 | `checkTarget` | 查询 `scope_check`（算法逐字保留） |
| `dsh-plugin-sec-suite.js` L949-969 | `checkRisk` | **主体留 exec 域守卫链**（10-exec.md）；本域只供数据（rules 经 `scope_list`/rules.changed 事件） |
| `dsh-plugin-sec-suite.js` L236-259 | `acquireQpsToken` / `throttleQps` | exec 域令牌桶（不变）；容量刷新改订阅 `scope.rules.changed` |
| `dsh-plugin-sec-suite.js` L468-492 | `enqueueScopeSeed` | **拆除**：`scope.granted` 事件 → task 域/ledger 域各自订阅（§1.5.1） |
| `dsh-plugin-sec-suite.asset-db.js` L71-80 | programs DDL | sqlite 后端 ProgramRepo 接管（表不动） |
| `dsh-plugin-sec-suite.asset-db.js` L165-170 | credentials DDL | sqlite 后端 CredRepo 接管 |
| `dsh-plugin-sec-suite.asset-db.js` L1452-1458 | `credAdd` | `cred_add`（新增 I4/I5/判重校验） |
| `dsh-plugin-sec-suite.asset-db.js` L1460-1468 | `credQuery` | `cred_query` |
| `dsh-plugin-sec-suite.asset-db.js` L585-630 | `upsertProgram`/`bindProgramWorkspace`/`archiveProgram`/`listPrograms` | ProgramRepo 原语 |
| `dsh-plugin-sec-suite.asset-graph.js` L617-647 | `cred_add`/`cred_query` 工具注册 | ToolProjector 自动投影（描述全文 §1.6） |
| `dsh-plugin-sec-suite.dashboard-rpc.js` L214-225、L200-211 | scopeList/scopeSaveProgram/scopeDeleteProgram/approvalList 旁路、programBindWorkspace case | RpcProjector 自动投影（§1.7） |
| approval onApprove 内的 `scopeSaveProgram` 直调（sec-suite.js L537-721） | 四处跨域直写 | `approval.approved` 事件 → 本域订阅 → `scope_grant`/`scope_rules_apply`（09 §1.5 时序图） |

### 3.2 兼容别名与观察期

| 旧名（v4.x） | 新名 | 通道 | 观察期 |
|---|---|---|---|
| RPC `scopeSaveProgram` | `scope.grant` | 看板 | 1 个调度周期（7 天），audit 零使用后删 |
| RPC `scopeDeleteProgram` | `scope.revoke` | 看板 | 同上 |
| RPC `scopeList` | `scope.list` | 看板 | 同上 |
| RPC `programBindWorkspace` | `program.bind_workspace` | 看板 | 同上 |
| 工具 `cred_add` / `cred_query` | 同名 | 模型 | 无需别名（本就域前缀风格） |
| （起草期）`scope_set_rules` | `scope_rules_apply` | 总线别名表 | 文档间引用收敛后删 |

**exec 域守卫链对 `scope_check` 的调用方式**（兼容性硬约束）：v4.x 守卫链进程内直调 `checkTarget`；v5 守卫链经 QueryGateway **同进程直调** `dispatch('scope', 'check', ...)`——函数调用语义、无 RPC/网络开销、无额外审计（查询不审计，宪法 §九）；headless worker 与 web 宿主同库 WAL，两进程各自持有域实例，读一致性由 mtime 快照 + 事件失效保证。守卫链算法**不得**在 exec 域重实现（单一算法源，防两份漂移——v4.x checkTarget 只有 一份的原因）。

### 3.3 数据迁移脚本要点

1. **表零迁移**：programs/credentials 沿用现库现表（README §六"不改名不迁库"）。
2. **scope.yml 零迁移**：格式不变；域接管后首次启动跑一次"外部写入接管流程"（§2.5）完成镜像对齐 + rules.changed 快照补发——幂等可重跑。
3. 存量重复 credentials 行：不清洗（历史数据），新写入由 I4/I5/判重拦截增量。
4. 回滚：v4.x 插件回滚即恢复旧路径（scope.yml 与表数据双向兼容——这是"不迁库不改格式"的直接收益）。

---

## 四、开放问题

| # | 问题 | 现状倾向 |
|---|---|---|
| O-1 | `approval.approved` 强联动订阅中，scope_grant 因"项目已被移出 yml"失败 → decide 回滚保持 pending——是否需要"重定向到其他项目"的修复流？ | 保持简单（驳回重提）；出现频率低 |
| O-2 | `finding_db` 字段只在 scope_grant 新建分支可设，无独立动词 | 等 report/ledger 域定稿后评估归属（疑似应归 vuln 域历史指纹） |
| O-3 | "纯移除排除（不授权）"无动词——语义上移除排除=授权（吸收语义），但清理误加的排除项需要绕道 | 若出现真实需求，加 `scope_unexclude` |
| O-4 | IPv6 CIDR 不支持（v4.x `ipToInt` 仅 IPv4） | 内网靶场出现 IPv6 授权需求时补 |
| O-5 | http-remote 全 unsupported——多主机/中心化授权管理的未来形态 | Phase 4 评审时与 vuln http-remote 一并议 |
| O-6 | `_persistScope` 序列化丢注释（v4.x 已知协同痛点） | 评估 YAML AST 保注释写（js-yaml 保持注释能力有限，可能引入轻量自研） |
| O-7 | scan-burst（T-16）：临时调高 defaults.rate_limit_qps 的审批 kind——需要"TTL 到期自动回落"的规则状态（临时补丁 + 恢复事件），与 `scope_rules_apply` 的永久补丁模型不同 | 与 09 §四 O-1 联动设计 |
