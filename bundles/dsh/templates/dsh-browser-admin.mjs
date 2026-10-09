// 共享浏览器 profile 管理 API（同域统一界面 / 的“新增 profile”按钮后端）。
// 仅监听回环端口，经 Caddy basicauth 反代到 /_pool/*；以 silkspool 运行，
// 只通过 `sudo -n sec-browser-profiles.sh` 执行固定的增删（名字白名单校验，无 shell 注入面）。
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh'
const REG = process.env.SEC_BROWSER_PROFILES || path.join(BASE, 'data/browser-profiles.json')
const OPS = process.env.SEC_BROWSER_OPS || path.join(BASE, 'sec-browser-profiles.sh')
const PORT = Number(process.env.BROWSER_ADMIN_PORT || 9230)
const PRIMARY_PORT = Number(process.env.BROWSER_PRIMARY_PORT || 9222)
const validName = (n) => typeof n === 'string' && /^[a-z0-9_-]{1,32}$/.test(n) && n !== 'primary'

function readReg() {
  try { return JSON.parse(fs.readFileSync(REG, 'utf8')) } catch { return { version: 1, profiles: [] } }
}
function listProfiles() {
  const extras = (readReg().profiles || []).map((p) => ({ name: p.name, port: p.port, path: `/p/${p.name}/`, primary: false }))
  return [{ name: 'primary', port: PRIMARY_PORT, path: '/p/primary/', primary: true }, ...extras]
}
function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}
function runOps(args) {
  const r = spawnSync('sudo', ['-n', OPS, ...args], { encoding: 'utf8', timeout: 60000 })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  return { code: r.status, out }
}
function readBody(req, cb) {
  let b = ''
  req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy() })
  req.on('end', () => cb(b))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  if (req.method === 'GET' && p === '/profiles') return send(res, 200, { ok: true, profiles: listProfiles() })
  if (req.method === 'POST' && p === '/profiles') {
    return readBody(req, (b) => {
      let name
      try { name = JSON.parse(b).name } catch { /* noop */ }
      if (!validName(name)) return send(res, 400, { ok: false, error: 'profile 名仅允许小写字母/数字/_/-（≤32，非 primary）' })
      const r = runOps(['add', name])
      if (r.code !== 0) return send(res, 500, { ok: false, error: r.out.slice(-400) || 'add failed' })
      return send(res, 200, { ok: true, name, path: `/p/${name}/` })
    })
  }
  const m = p.match(/^\/profiles\/([a-z0-9_-]{1,32})$/)
  if (m && req.method === 'DELETE') {
    const r = runOps(['remove', m[1]])
    if (r.code !== 0) return send(res, 500, { ok: false, error: r.out.slice(-400) || 'remove failed' })
    return send(res, 200, { ok: true, name: m[1] })
  }
  return send(res, 404, { ok: false, error: 'not found' })
})
server.listen(PORT, '127.0.0.1', () => console.log(`BROWSER_ADMIN_READY 127.0.0.1:${PORT}`))
