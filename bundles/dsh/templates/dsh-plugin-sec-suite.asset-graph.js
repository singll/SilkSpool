// ==============================================================================
// SilkSecAgent asset-graph 插件（模型工具面）
// 资产/接口/发现/事实黑板的查询与写入，数据层在 ./asset-db.js
// ==============================================================================

import * as db from './asset-db.js'

export const name = 'asset-graph'
export const inject = ['tools']

function renderJSON(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

const reg = (ctx, def) => ctx.tools.register({
  name: def.name,
  description: def.description,
  parameters: def.parameters,
  output: { schema: { type: 'object' }, render: renderJSON },
  ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
  execute: def.execute,
})

// 工具执行上下文（rc.7 ToolRunContext）：exec.agent.id === SessionId；session.header.cwd = 会话工作目录
function execSessionId(exec) {
  try {
    const id = exec && exec.agent && exec.agent.id
    return id ? String(id) : null
  } catch { return null }
}

function execCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
    return cwd ? String(cwd) : null
  } catch { return null }
}

export function apply(ctx) {
  reg(ctx, {
    name: 'asset_add',
    description: '登记一个资产（域名/IP/存活 web 站点）到资产图谱。type: domain/ip/web/service。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        type: { type: 'string', enum: ['domain', 'ip', 'web', 'service'] },
        source: { type: 'string', description: '来源（工具名/run_id/手工）' },
      },
      required: ['host'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: db.upsertAsset({ host: a.host, type: a.type || 'host', source: a.source || 'manual' }) }),
  })

  reg(ctx, {
    name: 'asset_query',
    description: '检索资产图谱。host_like 模糊匹配，type 过滤，program_id 按项目过滤，按最近活跃排序。',
    parameters: {
      type: 'object',
      properties: {
        host_like: { type: 'string' },
        type: { type: 'string' },
        program_id: { type: 'string' },
        limit: { type: 'integer', description: '默认 50，上限 200' },
      },
      additionalProperties: false,
    },
    execute: async (a) => {
      const items = db.queryAssets({ hostLike: a.host_like || '', type: a.type || '', programId: a.program_id || '', limit: a.limit || 50 })
      return { ok: true, total: items.length, items }
    },
  })

  reg(ctx, {
    name: 'endpoint_add',
    description: '登记一个接口端点（host + method + path）。越权/逻辑漏洞挖掘依赖接口图谱；auth_required（yes/no/unknown）与 roles_seen（访问过的角色 JSON 数组）支撑越权矩阵。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        method: { type: 'string', description: '默认 GET' },
        path: { type: 'string' },
        status: { type: 'string' },
        source: { type: 'string' },
        params: { type: 'object', description: '参数清单 JSON' },
        auth_required: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        roles_seen: { type: 'array', items: { type: 'string' }, description: '访问过该接口的角色' },
      },
      required: ['host', 'path'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: db.upsertEndpoint({ host: a.host, method: a.method || 'GET', path: a.path, status: a.status || '', source: a.source || 'manual', params: a.params || null, auth_required: a.auth_required || null, roles_seen: a.roles_seen || null }) }),
  })

  reg(ctx, {
    name: 'endpoint_query',
    description: '检索接口端点。可按 host 精确 + path_like 模糊，program_id 按项目过滤。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        path_like: { type: 'string' },
        program_id: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.queryEndpoints({ host: a.host || '', pathLike: a.path_like || '', programId: a.program_id || '', limit: a.limit || 50 }) }),
  })

  reg(ctx, {
    name: 'finding_add',
    description: '登记一个疑似漏洞发现。自动按 host+title+url 指纹去重（dup:true 表示已存在）。'
      + '纪律：必须附 evidence（run_id/flow_id/请求响应摘要），否则视为幻觉。'
      + 'vuln_type/cwe/impact/recommendation 等字段补全报告模板（提交 SRC 用）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        host: { type: 'string' },
        url: { type: 'string' },
        evidence: { type: 'string', description: '证据引用：run_id/flow_id/burp_item + 摘要' },
        source: { type: 'string' },
        vuln_type: { type: 'string', description: 'IDOR/SQLi/XSS/RCE/未授权...' },
        cwe: { type: 'string' },
        endpoint_ref: { type: 'string', description: '关联接口 host+method+path' },
        preconditions: { type: 'string' },
        reproduction_steps: { type: 'string' },
        impact: { type: 'string' },
        recommendation: { type: 'string' },
      },
      required: ['title', 'host', 'evidence'],
      additionalProperties: false,
    },
    execute: async (a, exec) => ({ ok: true, ...db.addFinding({ ...a, session_id: execSessionId(exec) }) }),
  })

  reg(ctx, {
    name: 'finding_query',
    description: '检索发现。按 host/severity/status/program_id（new/confirmed/false_positive/submitted/dup）过滤。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        severity: { type: 'string' },
        status: { type: 'string' },
        program_id: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.queryFindings({ host: a.host || '', severity: a.severity || '', status: a.status || '', programId: a.program_id || '', limit: a.limit || 50 }) }),
  })

  reg(ctx, {
    name: 'blackboard_set',
    description: '写事实黑板（跨会话共享）：凭据引用/存活主机/已试路径/中间结论。key 如 cred:example.com:admin。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: db.bbSet(a.key, a.value) }),
  })

  reg(ctx, {
    name: 'blackboard_get',
    description: '读事实黑板。带 key 读单条，不带列出最近 100 条。',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, result: db.bbGet(a.key) }),
  })

  reg(ctx, {
    name: 'asset_stats',
    description: '资产图谱总览：资产/端点/发现/黑板条数及分布。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ ok: true, ...db.stats() }),
  })

  reg(ctx, {
    name: 'finding_update',
    description: '更新 finding 状态（P5 运营流转）：new → confirmed/false_positive → submitted → accepted/dup/ignored。note 追加到证据链。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['new', 'confirmed', 'false_positive', 'submitted', 'accepted', 'dup', 'ignored'] },
        note: { type: 'string', description: '状态说明（追加进证据链）' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    execute: async (a) => db.updateFinding(a),
  })

  reg(ctx, {
    name: 'report_build',
    description: '生成漏洞报告（markdown）：按严重级汇总 + 明细表（标题/目标/证据），落盘 data/reports/。提交 SRC 前必须人工审核。',
    parameters: {
      type: 'object',
      properties: {
        host_like: { type: 'string', description: '按目标过滤（如 meituan）' },
        program_id: { type: 'string', description: '按项目过滤（项目级报告）' },
        since_days: { type: 'integer', description: '只看近 N 天，0=全部' },
        status: { type: 'string', description: '按状态过滤（如 confirmed）' },
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    execute: async (a) => {
      const r = db.buildReport({ hostLike: a.host_like || '', programId: a.program_id || '', sinceDays: a.since_days || 0, status: a.status || '' })
      return { ok: true, ...r, hint: '报告已落盘，提交 SRC 前必须人工逐条核实' }
    },
  })

  // -------------------- P6：program / task 工具（脊柱） --------------------

  reg(ctx, {
    name: 'program_list',
    description: '列出 programs 表（scope.yml 的运行态镜像）。项目是资产/漏洞/任务的顶层作用域。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ ok: true, items: db.listPrograms() }),
  })

  reg(ctx, {
    name: 'task_create',
    description: '创建一个任务（可管理的工作单元，编排器的派单对象；看板任务视图立即可见）。'
      + 'program_id 见 program_list（不传则按当前会话所在工作区自动带出）；phase: recon/vuln/biz-logic/code-audit/intranet/review；priority 0 最高。'
      + '依赖：传 parent_id 声明前置任务，前置未 done 时调度器/派单不放行（多级链用 task_chain 一次展开）。'
      + '定时任务：用户说「定时/每隔/每天/每小时/定期跑」时必须传 schedule（{kind:"once",at:<未来毫秒时间戳>} 或 {kind:"interval",every_seconds:>=300}），'
      + '不得只在会话里口头答应——带 schedule 的任务由调度循环自动执行，intrusive 级目标禁止 interval。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string', description: '不传则按当前会话工作区自动绑定' },
        phase: { type: 'string' },
        objective: { type: 'string' },
        priority: { type: 'integer', description: '默认 5，0 最高' },
        budget_tokens: { type: 'integer' },
        parent_id: { type: 'integer' },
        schedule: {
          type: 'object',
          description: '定时调度（可选）：{kind:"once",at} 或 {kind:"interval",every_seconds}',
          properties: {
            kind: { type: 'string', enum: ['once', 'interval'] },
            at: { type: 'integer', description: 'once：未来毫秒时间戳' },
            every_seconds: { type: 'integer', description: 'interval：间隔秒数，≥300' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    execute: async (a, exec) => {
      let programId = a.program_id || ''
      if (!programId) {
        const cwd = execCwd(exec)
        programId = (cwd && db.programByWorkspacePath(cwd)) || ''
        if (!programId) return { ok: false, error: 'program_id 缺失且当前会话未在已绑定工作区（传 program_id，见 program_list）' }
      }
      return db.taskCreate({ ...a, program_id: programId, session_id: execSessionId(exec) })
    },
  })

  reg(ctx, {
    name: 'task_schedule',
    description: '设置/修改/清除任务的定时调度。schedule 同 task_create；schedule 传 null 清除调度变普通任务。终态任务不可改。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        schedule: {
          type: ['object', 'null'],
          properties: {
            kind: { type: 'string', enum: ['once', 'interval'] },
            at: { type: 'integer' },
            every_seconds: { type: 'integer', description: '≥300' },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'schedule'],
      additionalProperties: false,
    },
    execute: async (a) => db.taskSchedule({ id: a.id, schedule: a.schedule ?? null }),
  })

  reg(ctx, {
    name: 'task_run_now',
    description: '立即触发一次任务执行（不动调度节律）：排入调度队列，下一 tick（≤60s）由 worker 认领执行。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (a) => db.taskRunNow(a.id),
  })

  reg(ctx, {
    name: 'task_update',
    description: '更新任务状态：queued/running/blocked/done/failed/cancelled。note 追加进 result 证据链；blocked_reason 记录 HITL 阻塞原因。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled'] },
        note: { type: 'string' },
        blocked_reason: { type: 'string' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    execute: async (a) => db.taskUpdate(a),
  })

  reg(ctx, {
    name: 'task_list',
    description: '列出任务（看板数据源）。按 program/status/phase 过滤，priority 升序 + created_at 升序。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string' },
        status: { type: 'string' },
        phase: { type: 'string' },
        limit: { type: 'integer', description: '默认 50' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.taskList({ programId: a.program_id || '', status: a.status || '', phase: a.phase || '', limit: a.limit || 50 }) }),
  })

  reg(ctx, {
    name: 'task_next',
    description: '编排器认领：返回指定 program 下最高优先级、无未完成父任务的 queued 任务。无则返回 null。',
    parameters: {
      type: 'object',
      properties: { program_id: { type: 'string' } },
      required: ['program_id'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, task: db.taskNext(a.program_id) }),
  })

  reg(ctx, {
    name: 'task_stats',
    description: '任务进度总览：按 phase×status 计数 + 总数。',
    parameters: {
      type: 'object',
      properties: { program_id: { type: 'string' } },
      required: ['program_id'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, ...db.taskStats(a.program_id) }),
  })

  // -------------------- P8：事实图谱 / 指纹 / 凭据 工具 --------------------

  reg(ctx, {
    name: 'fact_upsert',
    description: '写入/覆盖一条事实（跨会话共享，边渗透边记录）。fact_key 格式 category/slug（如 auth/cred-admin、note/failed-xxx）。'
      + 'summary 一行索引会注入 prompt，body 按需 fact_get 拉取。confidence: confirmed/tentative/deprecated。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string' },
        fact_key: { type: 'string' },
        category: { type: 'string', description: 'auth/target/note/finding/chain/exploit/asset' },
        summary: { type: 'string' },
        body: { type: 'string', description: '完整可复现上下文' },
        confidence: { type: 'string', enum: ['confirmed', 'tentative', 'deprecated'] },
        pinned: { type: 'integer', description: '1=置顶' },
        related_finding_id: { type: 'integer' },
        source: { type: 'string' },
      },
      required: ['program_id', 'fact_key'],
      additionalProperties: false,
    },
    execute: async (a) => db.factUpsert(a),
  })

  reg(ctx, {
    name: 'fact_get',
    description: '读单条事实全文（含 body）。摘要不够时按需拉取，禁止臆造。',
    parameters: {
      type: 'object',
      properties: { program_id: { type: 'string' }, fact_key: { type: 'string' } },
      required: ['program_id', 'fact_key'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, fact: db.factGet(a.program_id, a.fact_key) }),
  })

  reg(ctx, {
    name: 'fact_search',
    description: '检索事实（按 program/category/关键词，summary+key+body LIKE）。返回索引（不含 body）。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string' },
        category: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.factSearch({ program_id: a.program_id || '', category: a.category || '', q: a.q || '', limit: a.limit || 50 }) }),
  })

  reg(ctx, {
    name: 'fact_link',
    description: '建立两条事实的关系边。edge_type: resolves_to/hosts/exposes/depends_on/leads_to/enables/exploits。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string' },
        src_key: { type: 'string' },
        dst_key: { type: 'string' },
        edge_type: { type: 'string' },
        confidence: { type: 'string' },
      },
      required: ['program_id', 'src_key', 'dst_key', 'edge_type'],
      additionalProperties: false,
    },
    execute: async (a) => db.factLink(a),
  })

  reg(ctx, {
    name: 'fact_graph',
    description: '返回某条事实的关系子图（节点 + 出边 + 入边）。资产关系/攻击链可遍历。',
    parameters: {
      type: 'object',
      properties: { program_id: { type: 'string' }, fact_key: { type: 'string' } },
      required: ['program_id', 'fact_key'],
      additionalProperties: false,
    },
    execute: async (a) => db.factGraph(a.program_id, a.fact_key),
  })

  reg(ctx, {
    name: 'fact_reindex',
    description: '事实图谱自动建边（P2-1）：扫描项目全部事实，按共享域名根 / C 段建关系边，让孤立事实成图。返回建边数。周期或新增事实后调用。',
    parameters: {
      type: 'object',
      properties: { program_id: { type: 'string' } },
      required: ['program_id'],
      additionalProperties: false,
    },
    execute: async (a) => db.factReindexEdges(a.program_id),
  })

  reg(ctx, {
    name: 'neg_check',
    description: '负知识账本（P9 negative-ledger 内建）：查 note/* 已证伪路径（验证失败/前提不满足），派单前拦截重复尝试。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string' },
        q: { type: 'string', description: '目标/路径关键词' },
        limit: { type: 'integer' },
      },
      required: ['program_id'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const items = db.factSearch({ program_id: a.program_id, category: 'note', q: a.q || '', limit: a.limit || 20 })
      return { ok: true, total: items.length, failed_paths: items, warning: items.length ? '以下路径已证伪，避免重复尝试' : '无已知证伪路径' }
    },
  })

  reg(ctx, {
    name: 'eval_stats',
    description: '活评测回流（P9 环3）：读打标历史（confirmed/false_positive），返回各漏洞类型的确认数/误报数/误报率。用于判断新发现可信度、校准复核优先级——高误报率类型需更谨慎验证。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ ok: true, ...db.evalStats() }),
  })

  reg(ctx, {
    name: 'fp_add',
    description: '登记指纹（技术栈/组件 + 版本）。component-vuln-intel 触发器据此搜洞。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        tech: { type: 'string', description: '如 ruoyi / spring / weblogic' },
        version: { type: 'string' },
        source: { type: 'string' },
        program_id: { type: 'string' },
      },
      required: ['host', 'tech'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: db.fpAdd({ program_id: a.program_id || null, host: a.host, tech: a.tech, version: a.version || '', source: a.source || '' }) }),
  })

  reg(ctx, {
    name: 'fp_query',
    description: '检索指纹（按 host/tech/program）。命中技术栈后查 N-day。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        tech: { type: 'string' },
        program_id: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.fpQuery({ host: a.host || '', tech: a.tech || '', program_id: a.program_id || '', limit: a.limit || 50 }) }),
  })

  reg(ctx, {
    name: 'cred_add',
    description: '登记凭据引用（绝不存明文）。ref 指向 ctx.credentials / env 变量名；role 记录角色（越权矩阵用）。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string' },
        host: { type: 'string' },
        cred_type: { type: 'string' },
        ref: { type: 'string', description: '凭证引用（环境变量名/credentials key），非明文' },
        role: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    execute: async (a) => db.credAdd({ program_id: a.program_id || null, host: a.host || '', cred_type: a.cred_type || '', ref: a.ref, role: a.role || '', note: a.note || '' }),
  })

  reg(ctx, {
    name: 'cred_query',
    description: '检索凭据引用（只返回引用，不返回明文）。',
    parameters: {
      type: 'object',
      properties: { program_id: { type: 'string' }, host: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.credQuery({ program_id: a.program_id || '', host: a.host || '', limit: a.limit || 50 }) }),
  })

  reg(ctx, {
    name: 'asset_graph',
    description: '返回某资产相关的指纹 + 事实关系子图（借 fact_edges 遍历），资产图谱可遍历而非扁平列表。',
    parameters: {
      type: 'object',
      properties: { host: { type: 'string' } },
      required: ['host'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const fps = db.fpQuery({ host: a.host })
      const facts = db.factSearch({ q: a.host, limit: 50 })
      return { ok: true, host: a.host, fingerprints: fps, related_facts: facts }
    },
  })
}
