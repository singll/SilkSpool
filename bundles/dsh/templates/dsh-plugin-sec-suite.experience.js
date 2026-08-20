// ==============================================================================
// SilkSecAgent experience-hub（经验卡 + 知识库 + Playbook，FTS5 检索，零依赖）
// 对应方案 §5.3：环1 沉淀 / 环2 增强（检索注入）/ 环3 进化（playbook 排名）
// 生命周期：同 scenario 合并而非新建；source 分级（human-verified > 实战 > external）；
//           evidence 为空拒绝入库（验证铁律）；exp_validate 刷新时效
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getDb } from './asset-db.js'

export const name = 'experience-hub'
export const inject = ['tools']

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge')

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 }
const SOURCE_RANK = { 'human-verified': 3, '实战': 2, 'external': 1 }

let initialized = false
function db() {
  const d = getDb()
  if (!initialized) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS exp_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario TEXT NOT NULL UNIQUE,
        takeaway TEXT NOT NULL,
        chain TEXT,
        attempts TEXT,
        evidence TEXT,
        source TEXT NOT NULL DEFAULT '实战',
        confidence TEXT NOT NULL DEFAULT 'medium',
        created_at INTEGER NOT NULL,
        last_validated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS exp_fts USING fts5(scenario, takeaway, chain, content='exp_cards', content_rowid='id');
      CREATE TABLE IF NOT EXISTS kb_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file TEXT NOT NULL,
        source_url TEXT,
        imported_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(title, body);
      CREATE TABLE IF NOT EXISTS playbooks (
        name TEXT PRIMARY KEY,
        scenario TEXT,
        chain TEXT,
        runs INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        avg_duration_ms INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER
      );
    `)
    initialized = true
  }
  return d
}

// -------------------- 经验卡 --------------------

function expStore(a) {
  if (!a.scenario || !a.takeaway) return { ok: false, error: 'scenario 和 takeaway 必填' }
  const evidence = Array.isArray(a.evidence) ? a.evidence : []
  if (evidence.length === 0) return { ok: false, error: '验证铁律：evidence 不能为空（run_id/flow_id/burp_item 至少一条）' }
  const source = SOURCE_RANK[a.source] ? a.source : '实战'
  // external 来源强制低置信，人工确认后由人工调 confidence
  const confidence = source === 'external' ? 'low' : (CONFIDENCE_RANK[a.confidence] ? a.confidence : 'medium')
  const d = db()
  const now = Date.now()

  const existing = d.prepare('SELECT * FROM exp_cards WHERE scenario = ?').get(String(a.scenario))
  if (existing) {
    // 合并：证据去重追加，takeaway 新的覆盖，置信度取高者
    const mergedEvidence = [...new Set([...JSON.parse(existing.evidence || '[]'), ...evidence])]
    const mergedAttempts = [...JSON.parse(existing.attempts || '[]'), ...(Array.isArray(a.attempts) ? a.attempts : [])].slice(-20)
    const newConf = (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) ? confidence : existing.confidence
    const newSource = (SOURCE_RANK[source] > SOURCE_RANK[existing.source]) ? source : existing.source
    d.prepare(`UPDATE exp_cards SET takeaway=?, chain=?, attempts=?, evidence=?, confidence=?, source=?, last_validated_at=? WHERE id=?`)
      .run(String(a.takeaway), JSON.stringify(a.chain || []), JSON.stringify(mergedAttempts), JSON.stringify(mergedEvidence), newConf, newSource, now, existing.id)
    d.prepare(`UPDATE exp_fts SET takeaway=?, chain=? WHERE rowid=?`)
      .run(String(a.takeaway), JSON.stringify(a.chain || []), existing.id)
    return { ok: true, id: existing.id, merged: true, evidence_count: mergedEvidence.length }
  }

  const r = d.prepare(`INSERT INTO exp_cards (scenario, takeaway, chain, attempts, evidence, source, confidence, created_at, last_validated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(a.scenario), String(a.takeaway), JSON.stringify(a.chain || []), JSON.stringify(Array.isArray(a.attempts) ? a.attempts : []),
      JSON.stringify(evidence), source, confidence, now, now)
  const id = Number(r.lastInsertRowid)
  d.prepare('INSERT INTO exp_fts (rowid, scenario, takeaway, chain) VALUES (?, ?, ?, ?)')
    .run(id, String(a.scenario), String(a.takeaway), JSON.stringify(a.chain || []))
  return { ok: true, id, merged: false }
}

function ftsSearch(table, query, limit) {
  const d = db()
  const out = new Map()
  const terms = String(query).split(/\s+/).filter(Boolean)
  // FTS5 MATCH（ASCII/空格分词友好）
  try {
    const rows = d.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT ?`).all(terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), limit * 2)
    for (const r of rows) out.set(r.rowid, 2)
  } catch { /* MATCH 语法问题走 LIKE */ }
  // LIKE 逐词兜底（中文子串；FTS5 unicode61 对无空格中英文混排整串成词，MATCH 打不中）
  const cols = table === 'exp_fts' ? ['scenario', 'takeaway', 'chain'] : ['title', 'body']
  const where = terms.map(() => `(${cols.map((c) => `${c} LIKE ?`).join(' OR ')})`).join(' OR ')
  const likeRows = d.prepare(`SELECT rowid FROM ${table} WHERE ${where} LIMIT ?`).all(...terms.flatMap((t) => cols.map(() => `%${t}%`)), limit * 3)
  for (const r of likeRows) out.set(r.rowid, (out.get(r.rowid) || 0) + 1)
  return out
}

function expSearch(a) {
  if (!a.query) return { ok: false, error: 'query 必填' }
  const limit = Math.min(a.limit || 5, 20)
  const hits = ftsSearch('exp_fts', String(a.query), limit * 2)
  if (hits.size === 0) return { ok: true, total: 0, items: [] }
  const d = db()
  const items = [...hits.entries()]
    .map(([id, score]) => ({ ...d.prepare('SELECT * FROM exp_cards WHERE id = ?').get(id), _score: score }))
    .map((c) => ({
      id: c.id, scenario: c.scenario, takeaway: c.takeaway,
      chain: JSON.parse(c.chain || '[]'), evidence: JSON.parse(c.evidence || '[]'),
      source: c.source, confidence: c.confidence,
      last_validated_at: new Date(c.last_validated_at).toISOString().slice(0, 10),
      _rank: c._score * 10 + (SOURCE_RANK[c.source] || 0) * 3 + (CONFIDENCE_RANK[c.confidence] || 0),
    }))
    .sort((x, y) => y._rank - x._rank)
    .slice(0, limit)
    .map(({ _rank, ...rest }) => rest)
  return { ok: true, total: items.length, items }
}

function expList(a) {
  const limit = Math.min(a.limit || 20, 100)
  const rows = db().prepare('SELECT id, scenario, takeaway, source, confidence, last_validated_at FROM exp_cards ORDER BY last_validated_at DESC LIMIT ?').all(limit)
  return { ok: true, total: rows.length, items: rows.map((c) => ({ ...c, last_validated_at: new Date(c.last_validated_at).toISOString().slice(0, 10) })) }
}

function expValidate(a) {
  const r = db().prepare('UPDATE exp_cards SET last_validated_at = ? WHERE id = ?').run(Date.now(), Number(a.id))
  return { ok: r.changes > 0 }
}

// -------------------- 知识库 --------------------

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function kbImport(a) {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true })
  let title; let body; let sourceUrl = null
  if (a.url) {
    const res = await fetch(String(a.url), { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'SilkSecAgent-kb' } })
    body = stripHtml(await res.text())
    title = a.title || String(a.url).split('/').filter(Boolean).pop() || 'untitled'
    sourceUrl = String(a.url)
  } else if (a.file) {
    if (!fs.existsSync(String(a.file))) return { ok: false, error: `文件不存在: ${a.file}` }
    body = fs.readFileSync(String(a.file), 'utf8')
    title = a.title || path.basename(String(a.file)).replace(/\.[^.]+$/, '')
  } else {
    return { ok: false, error: 'file 或 url 必给其一' }
  }
  if (body.length < 100) return { ok: false, error: `内容过短（${body.length} 字符），不入库` }
  const id = Date.now().toString(36)
  const file = path.join(KNOWLEDGE_DIR, `${id}.md`)
  fs.writeFileSync(file, `# ${title}\n\n${body}\n`)
  const d = db()
  const r = d.prepare('INSERT INTO kb_docs (title, file, source_url, imported_at) VALUES (?, ?, ?, ?)')
    .run(title, file, sourceUrl, Date.now())
  d.prepare('INSERT INTO kb_fts (rowid, title, body) VALUES (?, ?, ?)').run(Number(r.lastInsertRowid), title, body.slice(0, 100000))
  return { ok: true, id: Number(r.lastInsertRowid), title, chars: body.length, note: 'external 知识，检索时标注来源，可信度低于实战经验卡' }
}

function kbSearch(a) {
  if (!a.query) return { ok: false, error: 'query 必填' }
  const limit = Math.min(a.limit || 5, 20)
  const d = db()
  const hits = new Map()
  try {
    const rows = d.prepare('SELECT rowid FROM kb_fts WHERE kb_fts MATCH ? LIMIT ?')
      .all(String(a.query).split(/\s+/).map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), limit * 2)
    for (const r of rows) hits.set(r.rowid, 2)
  } catch { /* fallback */ }
  const like = d.prepare('SELECT rowid FROM kb_fts WHERE title LIKE ? OR body LIKE ? LIMIT ?').all(`%${a.query}%`, `%${a.query}%`, limit * 2)
  for (const r of like) hits.set(r.rowid, (hits.get(r.rowid) || 0) + 1)
  const items = [...hits.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([id]) => {
    const doc = d.prepare('SELECT * FROM kb_docs WHERE id = ?').get(id)
    const body = fs.existsSync(doc.file) ? fs.readFileSync(doc.file, 'utf8') : ''
    const idx = body.indexOf(String(a.query))
    const excerpt = idx >= 0 ? body.slice(Math.max(0, idx - 80), idx + 200) : body.slice(0, 200)
    return { id: doc.id, title: doc.title, source_url: doc.source_url, excerpt: excerpt.replace(/\s+/g, ' ').trim() }
  })
  return { ok: true, total: items.length, source: 'external', items }
}

// -------------------- Playbook --------------------

function pbSave(a) {
  if (!a.name || !Array.isArray(a.chain) || a.chain.length === 0) return { ok: false, error: 'name 和非空 chain 必填' }
  db().prepare(`INSERT INTO playbooks (name, scenario, chain) VALUES (?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET scenario = excluded.scenario, chain = excluded.chain`)
    .run(String(a.name), String(a.scenario || ''), JSON.stringify(a.chain))
  return { ok: true, name: a.name, steps: a.chain.length }
}

function pbOutcome(a) {
  const d = db()
  const pb = d.prepare('SELECT * FROM playbooks WHERE name = ?').get(String(a.name || ''))
  if (!pb) return { ok: false, error: `playbook 不存在: ${a.name}（先 pb_save）` }
  const dur = Math.max(0, Number(a.duration_ms) || 0)
  const runs = pb.runs + 1
  const successes = pb.successes + (a.success ? 1 : 0)
  const avg = pb.runs === 0 ? dur : Math.round(pb.avg_duration_ms * 0.7 + dur * 0.3) // EWMA
  d.prepare('UPDATE playbooks SET runs=?, successes=?, avg_duration_ms=?, last_run_at=? WHERE name=?')
    .run(runs, successes, avg, Date.now(), pb.name)
  return { ok: true, name: pb.name, runs, success_rate: Math.round((successes / runs) * 100) / 100 }
}

function pbRank() {
  const rows = db().prepare('SELECT * FROM playbooks').all().map((p) => {
    const rate = p.runs ? p.successes / p.runs : 0
    const ageDays = p.last_run_at ? (Date.now() - p.last_run_at) / 86400000 : 999
    const decay = Math.max(0.3, 1 - ageDays * 0.02) // 时间衰减：每天 -2%，下限 0.3
    return {
      name: p.name, scenario: p.scenario, chain: JSON.parse(p.chain || '[]'),
      runs: p.runs, success_rate: Math.round(rate * 100) / 100, avg_duration_ms: p.avg_duration_ms,
      last_run: p.last_run_at ? new Date(p.last_run_at).toISOString().slice(0, 10) : null,
      score: Math.round(rate * decay * 100) / 100,
    }
  }).sort((x, y) => y.score - x.score)
  return { ok: true, total: rows.length, items: rows }
}

// -------------------- 注册 --------------------

function renderJSON(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

const reg = (ctx, def) => ctx.tools.register({
  name: def.name, description: def.description, parameters: def.parameters,
  output: { schema: { type: 'object' }, render: renderJSON }, execute: def.execute,
})

export function apply(ctx) {
  reg(ctx, {
    name: 'exp_store',
    description: '沉淀经验卡（任务复盘产出）。同 scenario 自动合并（证据追加）；evidence 为空拒绝（验证铁律）；'
      + 'source: 实战(默认)/human-verified/external(强制低置信)。',
    parameters: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: '目标画像，如 "若依CMS/Spring/有WAF"' },
        takeaway: { type: 'string', description: '可操作的一句话结论' },
        chain: { type: 'array', items: { type: 'string' }, description: '打通的调用链' },
        attempts: { type: 'array', items: { type: 'object' }, description: '[{tool,result,why,run_id}]' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'run_id/flow_id 列表（必填）' },
        source: { type: 'string', enum: ['实战', 'human-verified', 'external'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['scenario', 'takeaway', 'evidence'],
      additionalProperties: false,
    },
    execute: async (a) => expStore(a || {}),
  })

  reg(ctx, {
    name: 'exp_search',
    description: '新任务开局检索经验卡：按 scenario/takeaway 全文+子串检索，置信度与来源加权排序。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', description: '默认 5，上限 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (a) => expSearch(a || {}),
  })

  reg(ctx, {
    name: 'exp_list',
    description: '列出最近经验卡（复盘巡检用）。',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
    execute: async (a) => expList(a || {}),
  })

  reg(ctx, {
    name: 'exp_validate',
    description: '标记经验卡仍然有效（刷新时效，环4 存量重扫验证后调用）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (a) => expValidate(a || {}),
  })

  reg(ctx, {
    name: 'kb_import',
    description: '导入外部知识（file 本机路径 或 url 抓取），落盘 data/knowledge/ 并建全文索引。标 external 来源。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
      },
      additionalProperties: false,
    },
    execute: async (a) => kbImport(a || {}),
  })

  reg(ctx, {
    name: 'kb_search',
    description: '检索外部知识库（文章/writeup），返回标题+摘录。结果均为 external 来源，可信度低于经验卡。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (a) => kbSearch(a || {}),
  })

  reg(ctx, {
    name: 'pb_save',
    description: '沉淀成功调用链为 Playbook（name + chain 步骤数组 + scenario）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        scenario: { type: 'string' },
        chain: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'chain'],
      additionalProperties: false,
    },
    execute: async (a) => pbSave(a || {}),
  })

  reg(ctx, {
    name: 'pb_outcome',
    description: '记录一次 Playbook 执行结果（success + duration_ms），驱动排名。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        success: { type: 'boolean' },
        duration_ms: { type: 'integer' },
      },
      required: ['name', 'success'],
      additionalProperties: false,
    },
    execute: async (a) => pbOutcome(a || {}),
  })

  reg(ctx, {
    name: 'pb_rank',
    description: 'Playbook 排名：成功率 × 时间衰减，含执行数/平均耗时。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => pbRank(),
  })
}
