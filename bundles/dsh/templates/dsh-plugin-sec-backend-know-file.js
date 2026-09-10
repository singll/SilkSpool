// ==============================================================================
// @silksec/sec-backend-know-file — know 域 file 子仓后端（rules/vulncards/harvest，repository-v1）
//
// 契约：doc/secagent/v5/07-know.md §2.1/§2.4
//
// 职责：data/rules/（79 篇先验规程，只读 + rule_seed 物化）、data/vulncards/（VC-xxx YAML + registry.md）、
// data/harvest/drafts/ + candidates.json（收割草稿）。写入原子（tmp+rename）。
// 真相源是文件本体；curated 索引行由域命令同步到 sqlite 子仓（跨后端弱一致）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = '@silksec/sec-backend-know-file'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const RULES_DIR = 'rules'
const VULNCARDS_DIR = 'vulncards'
const HARVEST_DIR = 'harvest'
const KNOWLEDGE_DIR = 'knowledge'

function createRepo(dataDir) {
  const rulesRoot = path.join(dataDir, RULES_DIR)
  const vcRoot = path.join(dataDir, VULNCARDS_DIR)
  const harvestRoot = path.join(dataDir, HARVEST_DIR)
  const knowledgeRoot = path.join(dataDir, KNOWLEDGE_DIR)

  const ensureDirs = () => {
    fs.mkdirSync(rulesRoot, { recursive: true })
    fs.mkdirSync(vcRoot, { recursive: true })
    fs.mkdirSync(path.join(harvestRoot, 'drafts'), { recursive: true })
    fs.mkdirSync(knowledgeRoot, { recursive: true })
  }
  ensureDirs()

  function writeFileAtomic(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, target)
  }

  // 路径穿越防护：rel 必须是无 .. 的相对路径，且 resolve 后落在 root 内
  function safeResolve(root, rel) {
    const clean = String(rel || '').replace(/^\/+/, '')
    if (clean.includes('..')) return null
    const full = path.resolve(root, clean)
    if (full !== root && !full.startsWith(root + path.sep)) return null
    return full
  }

  const repo = {
    // ---- 通用 file 原语 ----
    writeFileAtomic, readFile: (p) => fs.readFileSync(p, 'utf8'), listDir: (p) => { try { return fs.readdirSync(p) } catch { return [] } },

    // ---- rules ----
    rulesList(q) {
      const out = []
      const walk = (dir, rel) => {
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const rp = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(path.join(dir, e.name), rp)
          else if (e.name.endsWith('.md')) {
            const st = fs.statSync(path.join(dir, e.name))
            out.push({ file: rp, mtime: st.mtimeMs, size: st.size, dir: rel || '' })
          }
        }
      }
      walk(rulesRoot, '')
      for (const r of out) {
        try { r.title = (fs.readFileSync(path.join(rulesRoot, r.file), 'utf8').slice(0, 2048).match(/^#\s+(.+)$/m) || [])[1] || '' } catch { r.title = '' }
      }
      const qf = String(q || '').toLowerCase()
      const filtered = qf ? out.filter((r) => r.file.toLowerCase().includes(qf) || (r.title || '').toLowerCase().includes(qf)) : out
      filtered.sort((a, b) => a.file.localeCompare(b.file))
      return { rows: filtered, dirs: [...new Set(out.map((r) => r.dir))].sort() }
    },
    ruleRead(rel) {
      const full = safeResolve(rulesRoot, rel)
      if (!full || !fs.existsSync(full)) return null
      const st = fs.statSync(full)
      return { file: String(rel).replace(/^\/+/, ''), content: fs.readFileSync(full, 'utf8'), mtime: st.mtimeMs, size: st.size }
    },
    ruleSeed(rel, content) {
      const full = safeResolve(rulesRoot, rel)
      if (!full) return { ok: false, error: 'E_SCHEMA 路径穿越' }
      const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null
      if (before === content) return { ok: true, changed: false, path: String(rel) }
      writeFileAtomic(full, content)
      return { ok: true, changed: true, path: String(rel) }
    },

    // ---- vulncards ----
    vcFileForId(id) {
      const files = repo.listDir(vcRoot).filter((f) => f.startsWith(`${id}-`) && (f.endsWith('.yaml') || f.endsWith('.yml')))
      return files.length ? files[0] : null
    },
    vcRead(id) {
      const f = repo.vcFileForId(String(id).toUpperCase())
      if (!f) return null
      const content = fs.readFileSync(path.join(vcRoot, f), 'utf8')
      const version = (content.match(/^version:\s*(\d+)/m) || [])[1] || '1'
      return { id: String(id).toUpperCase(), file: f, version: Number(version), content }
    },
    vcSave(id, content, slug) {
      const vid = String(id).toUpperCase()
      const existing = repo.vcFileForId(vid)
      const fname = existing || `${vid}-${slug || 'card'}.yaml`
      writeFileAtomic(path.join(vcRoot, fname), content)
      return { id: vid, file: fname }
    },
    vcList() {
      const rows = []
      for (const f of repo.listDir(vcRoot)) {
        if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue
        try {
          const content = fs.readFileSync(path.join(vcRoot, f), 'utf8')
          const id = (content.match(/^id:\s*(\S+)/m) || [])[1] || f
          const name = (content.match(/^name:\s*(.+)$/m) || [])[1] || ''
          const status = (content.match(/^status:\s*(\S+)/m) || [])[1] || 'draft'
          const version = (content.match(/^version:\s*(\d+)/m) || [])[1] || '1'
          const severity = (content.match(/^severity_potential:\s*(.+)$/m) || [])[1] || ''
          const attackSurface = (content.match(/^attack_surface:\s*(.+)$/m) || [])[1] || ''
          rows.push({ id, name, status, version: Number(version), severity, attack_surface: attackSurface, file: f })
        } catch { /* skip */ }
      }
      return rows
    },
    vcSetStatus(id, status) {
      const f = repo.vcFileForId(String(id).toUpperCase())
      if (!f) return { changed: false }
      const full = path.join(vcRoot, f)
      let content = fs.readFileSync(full, 'utf8')
      content = content.replace(/^status:\s*.*$/m, `status: ${status}`)
      writeFileAtomic(full, content)
      return { changed: true, id: String(id).toUpperCase() }
    },

    // ---- harvest ----
    harvestStatus() {
      const drafts = repo.listDir(path.join(harvestRoot, 'drafts')).filter((f) => f.endsWith('.md')).length
      const candidatesPath = path.join(harvestRoot, 'candidates.json')
      let candidates = 0
      let lastIngest = null
      try {
        const c = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'))
        candidates = Array.isArray(c) ? c.length : (c.items || []).length
        lastIngest = fs.statSync(candidatesPath).mtimeMs
      } catch { /* noop */ }
      return { drafts, candidates, last_ingest: lastIngest }
    },
    harvestWrite(drafts, candidates) {
      for (const d of drafts) {
        const fn = `${d.hash || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)}.md`
        writeFileAtomic(path.join(harvestRoot, 'drafts', fn), `# ${d.title || 'draft'}\n\n${d.body || ''}\n`)
      }
      const cpath = path.join(harvestRoot, 'candidates.json')
      let existing = []
      try { existing = JSON.parse(fs.readFileSync(cpath, 'utf8')) } catch { existing = [] }
      const merged = [...existing, ...candidates]
      writeFileAtomic(cpath, JSON.stringify(merged, null, 2))
      return { ingested: candidates.length, drafts: drafts.length }
    },

    // ---- knowledge 正文 ----
    knowledgeWrite(docId, content) {
      writeFileAtomic(path.join(knowledgeRoot, `${docId}.md`), content)
      return path.join(knowledgeRoot, `${docId}.md`)
    },
    knowledgeRead(docId) {
      const m = String(docId).match(/^([a-z0-9]+)$/)
      if (!m) return null
      const full = path.join(knowledgeRoot, `${docId}.md`)
      if (!fs.existsSync(full)) return null
      return fs.readFileSync(full, 'utf8')
    },

    // ---- coverage 缓存 ----
    coverageRead() {
      const out = path.join(dataDir, 'knowledge-coverage.json')
      try { return JSON.parse(fs.readFileSync(out, 'utf8')) } catch { return null }
    },
  }
  return repo
}

export function createKnowFileBackend(opts = {}) {
  const dataDir = opts.dataDir || (process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data')
  return {
    capabilities: {},
    factory() {
      return createRepo(dataDir)
    },
  }
}
