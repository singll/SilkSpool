// ==============================================================================
// SilkSecAgent asset-graph 插件（模型工具面 · v5 收口后仅保留独立工具）
//
// v5 切流：资产/接口/发现/指纹的读写已全部由领域域接管——
//   asset_upsert/asset_list/asset_overview/asset_fp_record（asset 域）
//   endpoint_upsert/endpoint_list（endpoint 域）
//   vuln_register_signal/register_candidate/confirm/...（vuln 域）
// 旧同名工具（asset_add/asset_query/endpoint_add/endpoint_query/finding_add/
// finding_query/asset_stats/finding_update/fp_add）为 v4 直连 DB 路径，已随
// 「一切写入皆命令、一切读取皆查询」公理删除；兼容走总线 dispatch 别名。
// 本文件仅保留无域归属的独立工具 `asset_graph`（资产子图遍历：指纹 + 事实关系）。
// ==============================================================================

import * as db from './asset-db.js'

export const name = 'asset-graph'
export const inject = ['tools']

function renderJSON(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'asset_graph',
    description: '返回某资产相关的指纹 + 事实关系子图（借 fact_edges 遍历），资产图谱可遍历而非扁平列表。',
    parameters: {
      type: 'object',
      properties: { host: { type: 'string' } },
      required: ['host'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (a) => {
      const fps = db.fpQuery({ host: a.host })
      const facts = db.factSearch({ q: a.host, limit: 50 })
      return { ok: true, host: a.host, fingerprints: fps, related_facts: facts }
    },
  })
}
