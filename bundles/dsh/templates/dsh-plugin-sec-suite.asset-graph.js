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

// 工具执行上下文（rc.7 ToolRunContext）：exec.agent.id === SessionId
function execSessionId(exec) {
  try {
    const id = exec && exec.agent && exec.agent.id
    return id ? String(id) : null
  } catch { return null }
}

export function apply(ctx) {
  // memcore 治理服务绑定（可选注入，缺席透传 fail-open）+ 缺席告警
  let lcBound = false
  try {
    ctx.inject(['secMemoryLifecycle'], (child) => {
      db._bindLifecycle(child.secMemoryLifecycle)
      lcBound = true
      child.effect(() => () => { db._bindLifecycle(null); lcBound = false }, 'memcore unbind')
    })
  } catch { /* 无 cordis inject 时透传 */ }
  setTimeout(() => {
    if (!lcBound) {
      process.stderr.write('[asset-graph] memcore 未加载：记忆治理 fail-open 透传（写入不校验/读取全量可见）\n')
      try { db.bbSet('note:dsh:memcore-offline', `[${new Date().toISOString()}] memcore 插件未加载，记忆治理透传。检查 profile 是否含 @silksec/sec-memcore。`) } catch { /* noop */ }
    }
  }, 15000).unref?.()

  reg(ctx, {
    name: 'asset_add',
    description: '登记/更新一个资产（域名/IP/存活 web 站点）到资产图谱。type: domain/ip/web/service。评级字段（score 0-100/level S|A|B|C/accept full|intrusion-only|none/biz 核心|一般|未知/state new|changed|stable|dead）按 rules/src/asset-scoring.md 打分体系，null 不覆盖既有值。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        type: { type: 'string', enum: ['domain', 'ip', 'web', 'service'] },
        source: { type: 'string', description: '来源（工具名/run_id/手工）' },
        score: { type: 'integer', description: '可挖掘性评分 0-100（SABC 打分表）' },
        level: { type: 'string', enum: ['S', 'A', 'B', 'C'], description: 'S≥75 A60-74 B40-59 C<40' },
        accept: { type: 'string', enum: ['full', 'intrusion-only', 'none'], description: 'SRC 收录政策（查 facts category=policy）' },
        biz: { type: 'string', enum: ['核心', '一般', '未知'] },
        state: { type: 'string', enum: ['new', 'changed', 'stable', 'dead'] },
      },
      required: ['host'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: db.upsertAsset({ host: a.host, type: a.type || 'host', source: a.source || 'manual', score: a.score ?? null, level: a.level ?? null, accept: a.accept ?? null, biz: a.biz ?? null, state: a.state ?? null }) }),
  })

  reg(ctx, {
    name: 'asset_query',
    description: '检索资产图谱。host_like 模糊匹配，type/level/accept 过滤，program_id 按项目过滤；深挖队列用法：level_in=S,A,B + accept!=none + sort=score desc。'
      + '资产准入：主动扫描只打已分级资产——未分级（level NULL）先用 grade-assets 分级或 vision_triage 分诊，禁直接全量扫描。',
    parameters: {
      type: 'object',
      properties: {
        host_like: { type: 'string' },
        type: { type: 'string' },
        program_id: { type: 'string' },
        level: { type: 'string', description: 'S/A/B/C 过滤（深挖队列取 S/A/B）' },
        level_in: { type: 'string', description: '多级过滤，如 "S,A,B"（主动扫描队列准入）' },
        accept: { type: 'string', description: 'full/intrusion-only/none 过滤' },
        sort: { type: 'string', enum: ['last_seen', 'score', 'host'], description: 'score=按可挖掘性降序' },
        limit: { type: 'integer', description: '默认 50，上限 200' },
      },
      additionalProperties: false,
    },
    execute: async (a) => {
      const items = db.queryAssets({ hostLike: a.host_like || '', type: a.type || '', programId: a.program_id || '', level: a.level || '', levelIn: a.level_in || '', accept: a.accept || '', sort: a.sort || '', limit: a.limit || 50 })
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
      + '标题规范：「<组件/业务语境> <漏洞类型与后果>（关键特征）」，如 "Oceanus 404 调试页泄露内网节点 IP+appkey"——'
      + '禁止把工具原始输出（如 "web_statistic"、"<scanner>: <plugin>"）当标题，标题必须让人一眼看懂是什么漏洞。'
      + '复现步骤与影响为必填（完整性闸门：缺失的登记自动归入待验证候选，不进漏洞信号面）；'
      + 'vuln_type/cwe/recommendation 等字段补全报告模板（提交 SRC 用）。'
      + 'P17：调度任务会话内调用会自动创建 FGS finding 节点；调用方可显式传 confidence=tentative|confirmed|false_positive|dup。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '规范标题：<组件/业务语境> <漏洞类型与后果>（关键特征）' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        host: { type: 'string' },
        url: { type: 'string' },
        evidence: { type: 'string', description: '证据引用：run_id/flow_id/burp_item + 摘要' },
        source: { type: 'string' },
        vuln_type: { type: 'string', description: 'IDOR/SQLi/XSS/RCE/未授权...' },
        cwe: { type: 'string' },
        endpoint_ref: { type: 'string', description: '关联接口 host+method+path' },
        preconditions: { type: 'string' },
        reproduction_steps: { type: 'string', description: '可复核的复现步骤（命令/请求序列 + 观察点），必填' },
        impact: { type: 'string', description: '具体化的影响（泄露了什么/可做什么，不是套话），必填' },
        recommendation: { type: 'string', description: '修复建议' },
        confidence: { type: 'string', enum: ['tentative', 'confirmed', 'false_positive', 'dup'], description: 'P17：证据置信度；未指定时由 FGS/状态机推断。' },
      },
      required: ['title', 'host', 'evidence', 'reproduction_steps', 'impact'],
      additionalProperties: false,
    },
    execute: async (a, exec) => {
      const sessionId = execSessionId(exec)
      let fgsNodeId = null
      let discoveryStep = null
      const confidence = a.confidence || null
      // P17：若调用发生在调度任务会话内，自动创建 FGS finding 节点并关联
      if (sessionId) {
        try {
          const active = db.activeTaskBySession(sessionId)
          if (active?.task_id) {
            const step = db.fgsListNodes({ task_id: active.task_id, type: 'step', status: 'running', limit: 1 })[0]
              || db.fgsListNodes({ task_id: active.task_id, type: 'step', status: '', limit: 1 })[0]
            const node = db.fgsAddNode({
              task_id: active.task_id,
              run_id: active.run_id,
              type: 'finding',
              status: 'open',
              content: { summary: a.title, host: a.host, url: a.url, severity: a.severity, evidence: a.evidence },
              score: ({ critical: 90, high: 70, medium: 50, low: 30, info: 10 }[a.severity] || 10),
              parent_id: step?.id || null
            })
            if (node.ok) fgsNodeId = node.id
            discoveryStep = step?.content?.summary || step?.content?.detail || null
          }
        } catch (e) {
          process.stderr.write(`[asset-graph] finding_add FGS 关联失败: ${e?.message ?? String(e)}\n`)
        }
      }
      return { ok: true, ...db.addFinding({ ...a, session_id: sessionId, fgs_node_id: fgsNodeId, discovery_step: discoveryStep, confidence }) }
    },
  })

  reg(ctx, {
    name: 'finding_query',
    description: '检索发现。按 host/severity/status/program_id（new/confirmed/false_positive/submitted/dup）过滤。默认排除 info 噪声（include_noise=true 查看）。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        severity: { type: 'string' },
        status: { type: 'string' },
        program_id: { type: 'string' },
        include_noise: { type: 'boolean', description: 'true=含 info 噪声行（默认排除）' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.queryFindings({ host: a.host || '', severity: a.severity || '', status: a.status || '', programId: a.program_id || '', includeNoise: a.include_noise === true, limit: a.limit || 50 }) }),
  })

  // v5：blackboard_set/blackboard_get 由 fact 域接管（fact_bb_publish/fact_bb_read 别名直通）；
  // fact_* 工具由 fact 域 ToolProjector 投影（零改名），此处 v4 注册移除避免同名冲突。

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

  // -------------------- P8：事实图谱 / 指纹 / 凭据 工具 --------------------
  // v5：fact_upsert/fact_get/fact_search/fact_link/fact_graph/fact_reindex/neg_check
  // 由 fact 域接管（零改名，ToolProjector 投影），此处 v4 注册移除避免同名冲突。

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
