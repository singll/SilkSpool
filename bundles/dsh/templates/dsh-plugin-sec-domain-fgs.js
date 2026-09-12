// ==============================================================================
// @silksec/sec-domain-fgs — SilkSecAgent fgs 域插件（v5 Phase 2.5：任务内决策图 Fact-Goal-Step Graph）
//
// 契约：doc/secagent/v5/14-fgs.md（域设计，权威）+ 01-bus.md + 00-conventions.md
//
// 对外（cordis）：name='sec-domain-fgs'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - FGS 图生命周期与任务绑定：写命令（除 fgs_deprecate 外）要求目标 task 处于 running（INV-F1）；
//  - 状态机拆为语义动词族（start/complete/fail/block/deprecate）+ content/score 增量独立 annotate；
//  - fgs_clear 仅 actor=scheduler（任务启动序列）；fgs_next 依赖满足只认同任务 step 类 done 节点；
//  - 订阅 task.finished（async）：ok=false 时经网关 dispatch fgs_add+fgs_fail 补记 failed step/finding 节点
//    （弱联动重试/死信；不回滚 task_finish——任务结果已是事实）；
//  - 沉淀（fact 转正）与 handoff 追加不归本域：本域只出 fgs.node.done 事件 + fgs_export 查询。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-fgs'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-fgs] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-fgs-sqlite/index.js', import.meta.url)
const { createFgsSqliteBackend } = await import(backendUrl.href)

const NODE_TYPE = ['fact', 'goal', 'step', 'finding']
const NODE_STATUS = ['open', 'running', 'done', 'failed', 'blocked', 'deprecated']

// ---------------------------------------------------------------------------
// manifest（14-fgs §1.2/§1.4/§1.5/§1.6 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const num = (opts = {}) => ({ type: 'number', ...opts })

const contentSchema = { type: 'object' }

export const FGS_MANIFEST = {
  domain: 'fgs',
  version: 1,
  service: 'secDomain.fgs',
  description: '任务内决策图 Fact-Goal-Step Graph：任务执行过程的外化记忆（fact/goal/step/finding 节点 + 状态机），生命周期与任务绑定，跨任务唯一出口是 fact 沉淀',
  owns: {
    tables: ['fgs_nodes'],
    files: ['data/events/fgs.jsonl'],
  },
  // prompt_hint：注入调度任务 prompt 的 FGS 使用说明模板（task 域调度器消费，05-task §2.3）；
  // v4.x 硬编码在 scheduler.js 的文本随 task 域调度器启用后改由本域版本受控。
  prompt_hint: '你拥有 fgs_add/fgs_start/fgs_complete/fgs_fail/fgs_block/fgs_deprecate/fgs_annotate/fgs_list/fgs_next/fgs_export 工具。'
    + '请把任务执行过程中的事实(fact)、目标(goal)、待执行步骤(step)、中间发现(finding)实时写入 FGS 图。'
    + '对每个漏洞卡，先 fgs_add detect step、fgs_start 开工，完成后 fgs_complete 并创建 verify step（depends_on 依赖 detect）；'
    + 'CONFIRMED 的发现用 finding_add 登记（会自动关联 FGS）。'
    + 'Decide 时用 fgs_next 取下一步，Execute 后用 fgs_complete/fgs_annotate 提交结果。',
  commands: {
    fgs_add: {
      actor: ['model', 'scheduler', 'system', 'reactor'],
      schema: schema({
        task_id: int(),
        type: en(NODE_TYPE),
        content: contentSchema,
        run_id: str(),
        score: num(),
        parent_id: int(),
        depends_on: { type: 'array', items: { type: 'integer' } },
      }, ['task_id', 'type', 'content']),
      idempotent: 'auto',
      idempotent_fields: ['task_id', 'run_id', 'type', 'content', 'score', 'parent_id', 'depends_on'],
      events: ['fgs.node.added'],
      event_limit: 1,
      invariants: ['taskExistsRunning', 'nodeRefsValid'],
      timeout_ms: 60000,
      agent_note: '在任务 FGS 图（Fact-Goal-Step Graph）中新增节点。type: fact/goal/step/finding；content 为 JSON 对象（summary 一行索引、detail/evidence 证据、run_id、host）；depends_on 为依赖节点 id 数组（依赖全 done 的 step 才在 fgs_next 出现）。新节点初始 open——开工用 fgs_start、完成用 fgs_complete。',
      deprecated: false,
    },
    fgs_start: {
      actor: ['model'],
      schema: schema({ node_id: int() }, ['node_id']),
      idempotent: 'none',
      events: ['fgs.node.updated'],
      event_limit: 1,
      invariants: ['nodeExistsRunning'],
      timeout_ms: 60000,
      agent_note: '把一个 open 的 step 节点标记为开工（open → running）。从 fgs_next 拿到 ready step 后、开始执行前调用——图上可见当前正在做什么；执行结果出来后用 fgs_complete 收口。',
      deprecated: false,
    },
    fgs_complete: {
      actor: ['model'],
      schema: schema({
        node_id: int(),
        content: contentSchema,
        score: num(),
      }, ['node_id']),
      idempotent: 'none',
      events: ['fgs.node.done'],
      event_limit: 1,
      invariants: ['nodeExistsRunning'],
      timeout_ms: 60000,
      agent_note: '完成一个节点（open/running → done），可同时补结果 content（增量合并不覆盖）与 score。fact 类节点完成时 content 务必带 detail/evidence——带证据的结论性事实会在任务收尾时自动沉淀进跨任务事实库（fact_search 可检索）；空泛的感想不会被沉淀。CONFIRMED 的发现同时用 finding_add 登记（vuln 域），会自动关联 FGS 节点。',
      deprecated: false,
    },
    fgs_fail: {
      actor: ['model', 'reactor'],
      schema: schema({
        node_id: int(),
        reason: str({ minLength: 1, maxLength: 500 }),
        content: contentSchema,
      }, ['node_id', 'reason']),
      idempotent: 'none',
      events: ['fgs.node.updated'],
      event_limit: 1,
      invariants: ['nodeExistsRunning'],
      timeout_ms: 60000,
      agent_note: '把节点标记为失败（→ failed）。reason 必填：工具报错/目标不存在/权限不足/超时…。失败的 step 不再出现在 fgs_next；如属暂时性故障可新建 step 重试（勿复活失败节点）。',
      deprecated: false,
    },
    fgs_block: {
      actor: ['model'],
      schema: schema({
        node_id: int(),
        reason: str({ minLength: 1, maxLength: 500 }),
        content: contentSchema,
      }, ['node_id', 'reason']),
      idempotent: 'none',
      events: ['fgs.node.updated'],
      event_limit: 1,
      invariants: ['nodeExistsRunning'],
      timeout_ms: 60000,
      agent_note: '把节点标记为受阻（→ blocked）。reason 必填：在等什么（授权/审批/凭证/上游产物）。阻塞的 step 不会出现在 fgs_next；条件解除后新建后续 step 或用 fgs_annotate 补说明——blocked 节点不自动复活。',
      deprecated: false,
    },
    fgs_deprecate: {
      actor: ['model', 'dashboard', 'script'],
      schema: schema({
        node_id: int(),
        reason: str({ minLength: 1, maxLength: 500 }),
        content: contentSchema,
      }, ['node_id', 'reason']),
      idempotent: 'none',
      events: ['fgs.node.updated'],
      event_limit: 1,
      invariants: ['nodeExists'],
      timeout_ms: 60000,
      agent_note: '把节点标记为废弃（→ deprecated）。finding 打 false_positive/dup/ignored 时 vuln 域会联动调用本动词；手动废弃过时的 goal/step 也用它。deprecated 节点保留在图中（决策链留痕）但不参与 fgs_next 与沉淀。',
      deprecated: false,
    },
    fgs_annotate: {
      actor: ['model'],
      schema: schema({
        node_id: int(),
        content: contentSchema,
        score: num(),
      }, ['node_id']),
      idempotent: 'auto',
      idempotent_fields: ['node_id', 'content', 'score'],
      events: ['fgs.node.updated'],
      event_limit: 1,
      invariants: ['nodeExistsRunning'],
      timeout_ms: 60000,
      agent_note: '向节点增量合并 content 字段 / 调整 score（不动状态，不覆盖已有字段）。用于执行中途补充证据指针、中间观察、修正优先级。状态流转请用对应语义动词。',
      deprecated: false,
    },
    fgs_clear: {
      actor: ['scheduler'],
      schema: schema({ task_id: int() }, ['task_id']),
      idempotent: 'none',
      events: ['fgs.task.cleared'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '调度器启动序列专用：清空某任务的旧图（图生命周期与任务绑定，新周期硬边界，防上一轮残留节点污染本轮 Decide）。模型勿调用。',
      deprecated: false,
    },
  },
  queries: {
    fgs_list: {
      actor: ['model', 'dashboard', 'human', 'system', 'reactor'],
      params: schema({
        task_id: int(),
        type: str({ default: '' }),
        status: str({ default: '' }),
        run_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, ['task_id']),
      agent_note: '列出某任务的 FGS 图节点，可按 type/status/run_id 过滤，score 降序。复盘决策链、检查图完整性用。',
    },
    fgs_next: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ task_id: int() }, ['task_id']),
      agent_note: '返回任务 FGS 图中当前可执行的 Step 列表（依赖已满足、状态 open），按 score 降序。Decide 循环用此工具决定下一步动作。',
    },
    fgs_export: {
      actor: ['model', 'dashboard', 'human', 'system', 'reactor'],
      params: schema({
        task_id: int(),
        format: en(['markdown', 'json'], { default: 'markdown' }),
      }, ['task_id']),
      agent_note: '导出某任务 FGS 图摘要（按 type/status 聚合，markdown 可直接嵌入 handoff；json 返回全节点）。',
    },
  },
  events: {
    'fgs.node.added': { payload: { type: 'object' }, redact: [] },
    'fgs.node.updated': { payload: { type: 'object' }, redact: [] },
    'fgs.node.done': { payload: { type: 'object' }, redact: [] },
    'fgs.task.cleared': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'task.finished': { handler: 'onTaskFinished', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dispatchRef = opts.dispatch
  const queryRef = opts.query
  const getDb = opts.getDb || (() => null)
  const repoFor = opts.repoFor || (() => ({}))
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  function isEligible(node) {
    if (node.type !== 'fact') return false
    const c = node.content || {}
    return !!String(c.summary || '').trim() && !!(String(c.detail || '').trim() || String(c.evidence || '').trim())
  }

  const invariants = {
    taskExistsRunning: async (args, repo, ctx) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) return { code: 'E_NOT_FOUND', message: `task 不存在: ${args.task_id}`, hint: '核对 task_get；FGS 节点必须挂在真实任务上', retryable: false }
      // INV-F1 豁免：reactor 经 task.finished 事件补记失败节点（任务此刻刚离 running，补记的是历史事实）
      if (t.status !== 'running') {
        const causeName = ctx && ctx.cause && (ctx.cause.name || (ctx.cause.cause && ctx.cause.cause.name))
        if (ctx && ctx.actor === 'reactor' && causeName === 'task.finished') return null
        return { code: 'E_FGS_TASK_NOT_RUNNING', message: `task #${args.task_id} 不在运行中（当前 ${t.status}）`, hint: 'FGS 图与任务生命周期绑定，只写当前运行任务的图；历史图用 fgs_list 只读', retryable: false }
      }
      return null
    },
    nodeExists: async (args, repo) => {
      const n = repo.getNode(Number(args.node_id))
      if (!n) return { code: 'E_NOT_FOUND', message: `节点不存在: ${args.node_id}`, hint: '核对 fgs_list 里的 node id', retryable: false }
      return null
    },
    nodeExistsRunning: async (args, repo, ctx) => {
      const n = repo.getNode(Number(args.node_id))
      if (!n) return { code: 'E_NOT_FOUND', message: `节点不存在: ${args.node_id}`, hint: '核对 fgs_list 里的 node id', retryable: false }
      const t = repo.getTask(Number(n.task_id))
      if (!t || t.status !== 'running') {
        // INV-F1 豁免：reactor 经 task.finished 事件补记失败节点（fgs_add 补记后立即 fgs_fail，任务已收尾）
        const causeName = ctx && ctx.cause && (ctx.cause.name || (ctx.cause.cause && ctx.cause.cause.name))
        if (ctx && ctx.actor === 'reactor' && causeName === 'task.finished') return null
        return { code: 'E_FGS_TASK_NOT_RUNNING', message: `节点所属 task #${n.task_id} 不在运行中`, hint: 'FGS 图与任务生命周期绑定，只写当前运行任务的图', retryable: false }
      }
      return null
    },
    nodeRefsValid: async (args, repo) => {
      const taskId = Number(args.task_id)
      if (Array.isArray(args.depends_on)) {
        for (const dep of args.depends_on) {
          const d = repo.getNode(Number(dep))
          if (!d) return { code: 'E_FGS_DEP_INVALID', message: `depends_on 引用不存在: ${dep}`, hint: 'depends_on 只能引用同任务内已存在的节点 id', retryable: false }
          if (Number(d.task_id) !== taskId) return { code: 'E_FGS_DEP_INVALID', message: `depends_on 跨任务引用: ${dep}`, hint: 'depends_on 只能引用同任务内已存在的节点 id', retryable: false }
        }
      }
      if (Number.isInteger(args.parent_id)) {
        const p = repo.getNode(Number(args.parent_id))
        if (!p) return { code: 'E_FGS_PARENT_INVALID', message: `parent_id 引用不存在: ${args.parent_id}`, hint: 'parent_id 只能引用同任务内已存在的节点 id', retryable: false }
        if (Number(p.task_id) !== taskId) return { code: 'E_FGS_PARENT_INVALID', message: `parent_id 跨任务引用: ${args.parent_id}`, hint: 'parent_id 只能引用同任务内已存在的节点 id', retryable: false }
      }
      return null
    },
  }

  function mergeContent(node, incoming) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return node.content || {}
    return { ...(node.content || {}), ...incoming }
  }

  const commands = {
    fgs_add: async (args, repo, ctx) => {
      const node = {
        task_id: Number(args.task_id),
        run_id: args.run_id || null,
        type: args.type,
        status: 'open',
        content: args.content || {},
        score: args.score ?? 0,
        parent_id: args.parent_id ?? null,
        depends_on: args.depends_on ?? null,
      }
      const id = repo.insertNode(node)
      return {
        data: { node_id: id, task_id: node.task_id, type: node.type, status: 'open' },
        events: [{ name: 'fgs.node.added', payload: { node_id: id, task_id: node.task_id, run_id: node.run_id, type: node.type, score: node.score } }],
        after: { node_id: id },
      }
    },
    fgs_start: async (args, repo) => {
      const node = repo.getNode(Number(args.node_id))
      if (node.status !== 'open') throwErr('E_STATE', `节点已 ${node.status}，不能开工`, 'open 才能开工；已 running 无须重复 start，已完成用 fgs_annotate 补内容')
      const changes = repo.updateNodeFields(Number(args.node_id), { status: 'running' }, ['open'])
      if (changes === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      return {
        data: { node_id: node.id, task_id: node.task_id, status: 'running' },
        events: [{ name: 'fgs.node.updated', payload: { node_id: node.id, task_id: node.task_id, type: node.type, from: { status: 'open', score: node.score }, to: { status: 'running', score: node.score }, cause: 'start' } }],
        after: { node_id: node.id, status: 'running' },
      }
    },
    fgs_complete: async (args, repo) => {
      const node = repo.getNode(Number(args.node_id))
      if (!['open', 'running'].includes(node.status)) throwErr('E_STATE', `节点已 ${node.status}，不能完成`, '节点已终态；补内容用 fgs_annotate')
      const merged = mergeContent(node, args.content)
      const score = args.score !== undefined ? args.score : node.score
      const changes = repo.updateNodeFields(Number(args.node_id), { status: 'done', content: merged, score }, ['open', 'running'])
      if (changes === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      const done = repo.getNode(Number(args.node_id))
      const persistEligible = isEligible(done)
      return {
        data: { node_id: done.id, task_id: done.task_id, type: done.type, status: 'done', persist_eligible: persistEligible },
        events: [{ name: 'fgs.node.done', payload: { node_id: done.id, task_id: done.task_id, run_id: done.run_id, type: done.type, from: { status: node.status }, persist_eligible: persistEligible, content_head: { summary: String((done.content || {}).summary || '').slice(0, 120) } } }],
        after: { node_id: done.id, status: 'done' },
      }
    },
    fgs_fail: async (args, repo) => {
      const node = repo.getNode(Number(args.node_id))
      if (!['open', 'running', 'blocked'].includes(node.status)) throwErr('E_STATE', `节点已 ${node.status}，不能标记失败`, '终态节点不能再失败')
      const merged = mergeContent(node, args.content)
      const changes = repo.updateNodeFields(Number(args.node_id), { status: 'failed', content: merged }, ['open', 'running', 'blocked'])
      if (changes === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      return {
        data: { node_id: node.id, task_id: node.task_id, status: 'failed' },
        events: [{ name: 'fgs.node.updated', payload: { node_id: node.id, task_id: node.task_id, type: node.type, from: { status: node.status, score: node.score }, to: { status: 'failed', score: node.score }, cause: 'fail', reason: args.reason } }],
        after: { node_id: node.id, status: 'failed' },
      }
    },
    fgs_block: async (args, repo) => {
      const node = repo.getNode(Number(args.node_id))
      if (!['open', 'running'].includes(node.status)) throwErr('E_STATE', `节点已 ${node.status}，不能阻塞`, '只有 open/running 可阻塞')
      const merged = mergeContent(node, args.content)
      const changes = repo.updateNodeFields(Number(args.node_id), { status: 'blocked', content: merged }, ['open', 'running'])
      if (changes === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      return {
        data: { node_id: node.id, status: 'blocked' },
        events: [{ name: 'fgs.node.updated', payload: { node_id: node.id, task_id: node.task_id, type: node.type, from: { status: node.status, score: node.score }, to: { status: 'blocked', score: node.score }, cause: 'block', reason: args.reason } }],
        after: { node_id: node.id, status: 'blocked' },
      }
    },
    fgs_deprecate: async (args, repo) => {
      const node = repo.getNode(Number(args.node_id))
      if (node.status === 'deprecated') throwErr('E_STATE', '节点已 deprecated', '已废弃无须再废弃')
      const merged = mergeContent(node, args.content)
      const changes = repo.updateNodeFields(Number(args.node_id), { status: 'deprecated', content: merged }, ['open', 'running', 'done', 'failed', 'blocked'])
      if (changes === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      return {
        data: { node_id: node.id, status: 'deprecated' },
        events: [{ name: 'fgs.node.updated', payload: { node_id: node.id, task_id: node.task_id, type: node.type, from: { status: node.status, score: node.score }, to: { status: 'deprecated', score: node.score }, cause: 'deprecate', reason: args.reason } }],
        after: { node_id: node.id, status: 'deprecated' },
      }
    },
    fgs_annotate: async (args, repo) => {
      if ((args.content === undefined || args.content === null) && args.score === undefined) {
        throwErr('E_SCHEMA', 'annotate 至少传 content 或 score 之一', '改状态请用 fgs_start/complete/fail/block/deprecate')
      }
      const node = repo.getNode(Number(args.node_id))
      const merged = mergeContent(node, args.content)
      const score = args.score !== undefined ? args.score : node.score
      const mergedKeys = args.content && typeof args.content === 'object' ? Object.keys(args.content) : []
      const changes = repo.updateNodeFields(Number(args.node_id), { content: merged, score }, undefined)
      if (changes === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      return {
        data: { node_id: node.id, merged_keys: mergedKeys },
        events: [{ name: 'fgs.node.updated', payload: { node_id: node.id, task_id: node.task_id, type: node.type, from: { status: node.status, score: node.score }, to: { status: node.status, score }, cause: 'annotate' } }],
        after: { node_id: node.id },
      }
    },
    fgs_clear: async (args, repo) => {
      const removed = repo.deleteNodesByTask(Number(args.task_id))
      return {
        data: { task_id: Number(args.task_id), removed },
        events: [{ name: 'fgs.task.cleared', payload: { task_id: Number(args.task_id), removed } }],
        after: { task_id: Number(args.task_id), removed },
      }
    },
  }

  const queries = {
    fgs_list: async (args, repo) => {
      const filters = { task_id: args.task_id, type: args.type || '', status: args.status || '', run_id: args.run_id || '' }
      const total = repo.countNodesWhere(filters)
      const rows = repo.listNodesWhere(filters, args.limit || 200, args.offset || 0)
      return { rows, total }
    },
    fgs_next: async (args, repo) => {
      const candidates = repo.nextStepCandidates(Number(args.task_id), 50)
      const doneIds = repo.doneStepIds(Number(args.task_id))
      const ready = []
      for (const r of candidates) {
        let deps = r.depends_on
        if (!Array.isArray(deps) || deps.length === 0 || deps.every((id) => doneIds.has(id))) {
          ready.push(r)
        }
      }
      return { steps: ready.slice(0, 10) }
    },
    fgs_export: async (args, repo) => {
      const nodes = repo.listNodesWhere({ task_id: args.task_id, type: '', status: '', run_id: '' }, 500, 0)
      if (args.format === 'json') return { task_id: Number(args.task_id), nodes }
      const byType = { fact: [], goal: [], step: [], finding: [] }
      for (const n of nodes) (byType[n.type] || []).push(n)
      const lines = [
        '', '---', '',
        '## FGS 决策链摘要（自动导出）',
        '',
        `- 任务: #${args.task_id}`,
        `- 节点总数: ${nodes.length}（fact ${byType.fact.length} / goal ${byType.goal.length} / step ${byType.step.length} / finding ${byType.finding.length}）`,
        '',
        '### 目标 (Goal)',
        ...byType.goal.map((n) => `- [${n.status}] ${n.content?.summary || n.content?.detail || '-'}`),
        '',
        '### 关键事实 (Fact)',
        ...byType.fact.map((n) => `- [${n.status}] ${n.content?.summary || n.content?.detail || '-'}`),
        '',
        '### 执行步骤 (Step)',
        ...byType.step.map((n) => `- [${n.status}] ${n.content?.summary || n.content?.detail || '-'}`),
        '',
        '### 发现 (Finding)',
        ...byType.finding.map((n) => `- [${n.status}] ${n.content?.summary || '-'} @${n.content?.host || ''}${n.score ? ` (score:${n.score})` : ''}`),
        '',
      ]
      return { task_id: Number(args.task_id), markdown: lines.join('\n') + '\n' }
    },
  }

  const subscribers = {
    // 订阅 task.finished（async，reactor）：ok=false 时经网关 dispatch fgs_add + fgs_fail 补记 failed 节点——
    // INV-F1 对 reactor + task.finished cause 链豁免（任务此刻刚离 running，补记的是历史事实）。
    // best-effort：补记失败只记日志/audit，不回滚 task_finish（任务结果已是事实）。
    onTaskFinished: async (envelope) => {
      const p = envelope?.payload || {}
      if (p.ok !== false) return { ok: true, data: { skipped: true } }
      if (!dispatchRef) return { ok: true, data: { skipped: false, error: 'no dispatch ref' } }
      const taskId = Number(p.task_id)
      const runId = p.run_id || null
      const rejected = !!(p.truth && p.truth.rejected)
      const type = rejected ? 'finding' : 'step'
      const content = rejected
        ? { summary: 'worker 拒执或 API 错误', reason: String(p.truth.reason || ''), run_id: runId }
        : { summary: `任务失败: ${p.note || 'unknown'}`, run_id: runId }
      try {
        const add = await dispatchRef('fgs', 'add', { task_id: taskId, type, content, run_id: runId, score: 0 }, { actor: 'reactor', cause: envelope })
        if (!add || !add.ok) {
          log(`task.finished 补记 fgs_add 失败: ${add && add.error && add.error.code} ${add && add.error && add.error.message}`)
          return { ok: true, data: { skipped: false, error: add && add.error && add.error.code } }
        }
        const nodeId = add.data && add.data.node_id
        const reason = rejected ? `worker 拒执或 API 错误: ${p.truth.reason || ''}`.slice(0, 500) : String(`任务失败: ${p.note || 'unknown'}`).slice(0, 500)
        const fail = await dispatchRef('fgs', 'fail', { node_id: nodeId, reason }, { actor: 'reactor', cause: envelope })
        if (!fail || !fail.ok) log(`task.finished 补记 fgs_fail 失败: ${fail && fail.error && fail.error.code}`)
        return { ok: true, data: { skipped: false, node_id: nodeId } }
      } catch (e) {
        log(`task.finished 补记失败节点异常: ${e?.message}`)
        return { ok: true, data: { skipped: false, error: String(e?.message) } }
      }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export function buildFgsDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createFgsSqliteBackend(opts.backendOptions || {})
  return {
    manifest: FGS_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir, repoFor: (db) => backend.factory(db) }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildFgsDomain({
        dataDir,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
        getDb: () => (bus._internal && typeof bus._internal.db === 'function' ? bus._internal.db() : null),
      })
      const res = bus.registry.register(domain)
      if (res.ok) log(`fgs 域注册成功（registered=${res.registered}）`)
      else log(`fgs 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——fgs 域未注册（总线必须先行挂载）`)
  }
  return null
}
