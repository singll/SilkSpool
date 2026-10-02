// Controlled, offline governance channel. All writes use the task domain bus.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) {
    if (!value.startsWith('--') || all[index + 1] == null) throw new Error('Expected --name value')
    pairs.push([value.slice(2), all[index + 1]])
  }
  return pairs
}, []))
const required = ['base', 'plan', 'plan-sha256', 'mode', 'report']
if (required.some(k => !args[k]) || !['rehearsal', 'frozen'].includes(args.mode)) throw new Error('Invalid arguments')
const base = fs.realpathSync(args.base), planPath = fs.realpathSync(args.plan)
const dataDir = path.join(base, 'data'), database = path.join(dataDir, 'asset-graph.db')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
const hashObject = value => sha(JSON.stringify(canonical(value)))
const content = fs.readFileSync(planPath)
if (sha(content) !== args['plan-sha256']) throw new Error('Plan digest mismatch')
const plan = JSON.parse(content)
if (plan.schema_version !== 2 || plan.final_cost_proven !== false || plan.read_only !== true
    || plan.reconciliation?.applied !== false) throw new Error('Unrecognized audit plan')

function assertOffline() {
  if (args.mode === 'rehearsal') {
    // Rehearsal may only use a disposable base explicitly prepared by the caller.
    const marker = JSON.parse(fs.readFileSync(path.join(base, 'cost-rehearsal.json'), 'utf8'))
    if (marker.base !== base || marker.production !== false
        || base === '/opt/silkspool/dsh' || !base.includes('cost-rehearsal-')) throw new Error('Not a rehearsal base')
  } else {
    if (process.getuid?.() !== 0 || !args['freeze-state']) throw new Error('Frozen governance requires root and freeze state')
    const state = JSON.parse(fs.readFileSync(path.join(args['freeze-state'], 'state.json'), 'utf8'))
    if (!state.frozen_at || !state.captured_at || state.resumed_at || state.error
        || !state.snapshot || !state.manifest_sha256) throw new Error('No active verified frozen recovery point')
    if (sha(fs.readFileSync(path.join(state.snapshot, 'manifest.json'))) !== state.manifest_sha256) throw new Error('Frozen manifest mismatch')
    const manifest = JSON.parse(fs.readFileSync(path.join(state.snapshot, 'manifest.json'), 'utf8'))
    if (manifest.roots?.dsh?.source !== base || state.hold !== true) throw new Error('Freeze does not cover this base')
    if (!state.units?.['silksecagent.service']) throw new Error('Writer inventory missing')
    for (const unit of Object.keys(state.units)) {
      const active = execFileSync('systemctl', ['show', unit, '-p', 'ActiveState', '--value'], { encoding: 'utf8' }).trim()
      if (!['inactive', 'failed'].includes(active)) throw new Error(`Writer is active: ${unit}`)
    }
  }
}
assertOffline()
const evidence = new Map(plan.rows.map(row => [`${row.task_id}/${row.run_id}`, row]))
const decisions = plan.reconciliation.decisions.filter(row => row.reason === 'eligible_lower_bound')
const sessionFiles = new Map()
function indexSessions(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name)
    if (entry.isDirectory()) indexSessions(filename)
    else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') {
      const sid = path.basename(folder), files = sessionFiles.get(sid) || []
      files.push(filename); sessionFiles.set(sid, files)
    }
  }
}
// All evidence is checked before the first domain write.
indexSessions(path.join(dataDir, 'sessions'))
for (const decision of decisions) {
  const command = decision.command, row = evidence.get(`${decision.task_id}/${decision.run_id}`)
  if (!command || !row || row.session_status !== 'attributable_lower_bound' || row.bill_status !== 'missing') {
    throw new Error('Plan decision has no attributable evidence')
  }
  const selected = Object.fromEntries(['task_id', 'run_id', 'session_id', 'session_sha256', 'session'].map(k => [k, row[k]]))
  if (hashObject(selected) !== command.evidence_sha256 || command.session_id !== row.session_id
      || command.session_sha256 !== row.session_sha256
      || command.task_id !== row.task_id || command.run_id !== row.run_id
      || command.lower_bound_tokens !== row.session.recorded_tokens_lower_bound) throw new Error('Evidence projection mismatch')
  const files = sessionFiles.get(command.session_id)
  if (files?.length !== 1 || sha(fs.readFileSync(files[0])) !== command.session_sha256) throw new Error('Session evidence changed')
}
const db = new DatabaseSync(database, { readOnly: true })
const read = sql => db.prepare(sql).all().map(row => ({ ...row }))
try {
  if (read("SELECT id FROM tasks WHERE status='running'").length
      || read("SELECT run_id FROM workers WHERE status='running'").length) throw new Error('Running task/worker blocks reconciliation')
} finally { db.close() }
const plugins = args.plugins ? fs.realpathSync(args.plugins) : path.join(base, 'plugins')
const { createBus } = await import(pathToFileURL(path.join(plugins, 'sec-domain-bus/index.js')))
const { buildTaskDomain } = await import(pathToFileURL(path.join(plugins, 'sec-domain-task/index.js')))
assertOffline()
const bus = createBus({ dataDir, dbFile: database, aliasesFile: path.join(base, 'bus.aliases.yaml'),
  auditFile: path.join(dataDir, 'audit.jsonl'), eventsDir: path.join(dataDir, 'events'),
  sidecars: false, startDispatcherTimer: false })
const report = { plan_sha256: args['plan-sha256'], mode: args.mode, final_cost_proven: false,
  completed: false, decisions: decisions.length, applied: [], errors: [] }
try {
  const registration = bus.registry.register(buildTaskDomain({ dataDir,
    dispatch: (...a) => bus.dispatch(...a), query: (...a) => bus.query(...a) }))
  if (!registration.ok) throw new Error(registration.error?.code || 'Domain registration failed')
  for (const decision of decisions) {
    const result = await bus.dispatch('task', 'record_cost_evidence', decision.command,
      { actor: 'system', operator: 'wp03-cost-reconcile' })
    if (!result.ok) {
      report.errors.push({ task_id: decision.task_id, run_id: decision.run_id, code: result.error?.code })
      throw new Error(result.error?.code || 'Reconciliation failed')
    }
    report.applied.push(result.data)
  }
  report.delta_tokens = report.applied.reduce((n, row) => n + row.delta_tokens, 0)
  assertOffline()
  report.completed = true
} finally {
  const bytes = JSON.stringify(report, null, 2) + '\n'
  fs.writeFileSync(args.report, bytes, { mode: 0o600 })
  console.log(JSON.stringify({ completed: report.completed, decisions: report.decisions,
    applied: report.applied.length, delta_tokens: report.delta_tokens, errors: report.errors }))
}
