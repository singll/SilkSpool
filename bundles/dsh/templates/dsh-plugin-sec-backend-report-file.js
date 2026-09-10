// ==============================================================================
// @silksec/sec-backend-report-file — report 域 file 后端（repository-v1，产物文件真相源）
//
// 契约：doc/secagent/v5/12-report.md §2.1/§2.4
//
// 职责：持有 data/reports/ 整目录（含 submissions/）——漏洞报告与 SRC 提交草稿的
// markdown 产物。写 = tmp + rename 原子落盘；读 = 受控读（前缀校验防穿越）。
// 文件本体是权威真相源；索引（sqlite）只是加速层。不含业务校验。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export const name = '@silksec/sec-backend-report-file'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

function sha1(str) { return crypto.createHash('sha1').update(String(str)).digest('hex') }

function createRepo(dataDir) {
  const reportsRoot = path.join(dataDir, 'reports')

  // 受控路径解析（12-report §2.4 INV-R5）：解析后必须在 reportsRoot 前缀内 + .md 后缀
  function resolveSafe(relPath) {
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!rel) return null
    if (!rel.toLowerCase().endsWith('.md')) return null
    const abs = path.resolve(reportsRoot, rel)
    const prefix = reportsRoot.endsWith(path.sep) ? reportsRoot : reportsRoot + path.sep
    if (abs !== reportsRoot && !abs.startsWith(prefix)) return null
    return abs
  }

  function listReportFiles() {
    const out = []
    function walk(dir, rel) {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { entries = [] }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name), path.join(rel, e.name))
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(path.join(rel, e.name))
      }
    }
    walk(reportsRoot, '')
    return out.map((p) => p.split(path.sep).join('/'))
  }

  const repo = {
    reportsRoot,
    resolveSafe,
    writeReportFileAtomic(relPath, content) {
      const abs = resolveSafe(relPath)
      if (!abs) return { ok: false, error: 'E_SCHEMA', message: `非法产物路径: ${relPath}` }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      fs.writeFileSync(tmp, content)
      fs.renameSync(tmp, abs)
      return { ok: true, file: relPath, abs }
    },
    readReportFile(relPath) {
      const abs = resolveSafe(relPath)
      if (!abs) return null
      try { return fs.readFileSync(abs, 'utf8') } catch { return null }
    },
    statReportFile(relPath) {
      const abs = resolveSafe(relPath)
      if (!abs) return null
      try {
        const st = fs.statSync(abs)
        return { exists: true, size: st.size, mtimeMs: st.mtimeMs, sha: sha1(fs.readFileSync(abs, 'utf8')) }
      } catch {
        return { exists: false, size: 0, mtimeMs: null, sha: null }
      }
    },
    listReportFiles,
  }
  return repo
}

export function createReportFileBackend(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  return {
    capabilities: {},
    factory() {
      return createRepo(dataDir)
    },
  }
}
