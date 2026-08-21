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
    description: '检索资产图谱。host_like 模糊匹配，type 过滤，按最近活跃排序。',
    parameters: {
      type: 'object',
      properties: {
        host_like: { type: 'string' },
        type: { type: 'string' },
        limit: { type: 'integer', description: '默认 50，上限 200' },
      },
      additionalProperties: false,
    },
    execute: async (a) => {
      const items = db.queryAssets({ hostLike: a.host_like || '', type: a.type || '', limit: a.limit || 50 })
      return { ok: true, total: items.length, items }
    },
  })

  reg(ctx, {
    name: 'endpoint_add',
    description: '登记一个接口端点（host + method + path）。越权/逻辑漏洞挖掘依赖接口图谱。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        method: { type: 'string', description: '默认 GET' },
        path: { type: 'string' },
        status: { type: 'string' },
        source: { type: 'string' },
      },
      required: ['host', 'path'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: db.upsertEndpoint({ host: a.host, method: a.method || 'GET', path: a.path, status: a.status || '', source: a.source || 'manual' }) }),
  })

  reg(ctx, {
    name: 'endpoint_query',
    description: '检索接口端点。可按 host 精确 + path_like 模糊。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        path_like: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.queryEndpoints({ host: a.host || '', pathLike: a.path_like || '', limit: a.limit || 50 }) }),
  })

  reg(ctx, {
    name: 'finding_add',
    description: '登记一个疑似漏洞发现。自动按 host+title+url 指纹去重（dup:true 表示已存在）。'
      + '纪律：必须附 evidence（run_id/flow_id/请求响应摘要），否则视为幻觉。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        host: { type: 'string' },
        url: { type: 'string' },
        evidence: { type: 'string', description: '证据引用：run_id/flow_id/burp_item + 摘要' },
        source: { type: 'string' },
      },
      required: ['title', 'host', 'evidence'],
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, ...db.addFinding(a) }),
  })

  reg(ctx, {
    name: 'finding_query',
    description: '检索发现。按 host/severity/status（new/confirmed/false_positive/submitted/dup）过滤。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        severity: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    execute: async (a) => ({ ok: true, items: db.queryFindings({ host: a.host || '', severity: a.severity || '', status: a.status || '', limit: a.limit || 50 }) }),
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
}
