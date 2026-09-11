// ==============================================================================
// SilkSecAgent 流水线插件（sec-pipeline）——机械复核/参数面消费/敏感信息回扫
// 注册为 DSH 原生工具（替代 scripts/pipeline/ 裸脚本调用）。
//
// 设计：doc/secagent/dsh-0.1.2-upgrade-arch-plan.md §4.2/§五
//
// v5 切流（11-ledger）：attempts_log/card_usage_log/radar_read/pipeline_validate/
// coverage_report 已由 ledger 域 ToolProjector 接管（ledger_* 零改名 + 兼容别名），
// 旧函数体已删旧路径（观察期满）。
//
// 工具清单（保留）：
//   verify_replay     CONFIRMED 机械复核（重放 request.txt + hash 比对 + verify-log）
//   surface_queue     endpoints.tsv/文本 → 参数 URL 队列（dalfox/sqlmap 喂料）
//   surface_scan      敏感信息正则回扫（VC-027，命中打码）
//
// 配置（环境变量）：SEC_DATA_DIR（默认 /opt/silkspool/dsh/data）
//                  SEC_EGRESS_PROXY（verify_replay 默认出口，默认 http://127.0.0.1:8899）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'

export const name = 'sec-pipeline'
export const inject = ['tools']

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const DEFAULT_PROXY = process.env.SEC_EGRESS_PROXY || 'http://127.0.0.1:8899'

// -------------------- sec-common：共享函数 --------------------

function nowIso() {
  // 东八区 ISO（台账统一时区）
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00').slice(0, 19)
}

function pipelineDir(program) {
  const d = path.join(DATA_DIR, 'pipeline', program)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: { type: 'object' }, render: options.render },
    async execute(args) { return options.execute(args || {}) },
  }
}

// render 回调（双参签名：宿主以 (args, value) 调用，序列化的是 value 而非 args）。
// execute 必须返回纯对象（与 output.schema type:'object' 对齐），禁止 return renderJSON(x)。
function renderJSON(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

// -------------------- 工具实现 --------------------

function httpReplay({ method, pathq, host, headers, body, proxy, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers }
    delete hdrs['content-length']; delete hdrs['connection']; delete hdrs['Content-Length']
    hdrs['Accept-Encoding'] = 'identity'
    let req
    const opts = { method, headers: hdrs, timeout: timeoutMs }
    if (proxy) {
      // http 代理转发绝对 URI（mubeng 网关支持 http 转发；https 目标走 CONNECT 较复杂，
      // 这里用 http:// 降级路径：若目标仅 https 可用，请先不带 proxy 直连验证或扩展 CONNECT）
      const u = new URL(proxy)
      req = http.request({ host: u.hostname, port: u.port, path: `https://${host}${pathq}`, ...opts }, resolve)
    } else {
      req = https.request({ host, port: 443, path: pathq, ...opts }, resolve)
    }
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function toolVerifyReplay() {
  return {
    description: 'CONFIRMED 机械复核（防幻觉标准9：LLM 不给自己当法官）。重放 evidence/{id}/request.txt，响应体 sha256 比对并追加 verify-log.md。',
    parameters: {
      type: 'object',
      properties: {
        evidence_dir: { type: 'string' },
        proxy: { type: 'string', description: `默认 ${DEFAULT_PROXY}；传 "direct" 直连` },
        expect_hash: { type: 'string', description: '期望响应体 sha256（可选，不一致则 FAIL）' },
      },
      required: ['evidence_dir'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const reqFile = path.join(a.evidence_dir, 'request.txt')
      if (!fs.existsSync(reqFile)) return { ok: false, error: `${reqFile} 不存在` }
      const raw = fs.readFileSync(reqFile, 'utf8')
      const [head, ...rest] = raw.split(/\r?\n\r?\n/)
      const lines = head.split(/\r?\n/)
      const m = lines[0].match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)/)
      if (!m) return { ok: false, error: 'request.txt 首行无法解析' }
      const headers = {}
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':')
        if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      const host = headers['Host'] || headers['host']
      if (!host) return { ok: false, error: 'request.txt 缺 Host 头' }
      const proxy = a.proxy === 'direct' ? null : (a.proxy || DEFAULT_PROXY)
      try {
        const resp = await httpReplay({ method: m[1], pathq: m[2], host, headers, body: rest.join('\n\n'), proxy })
        const chunks = []
        await new Promise((res, rej) => { resp.on('data', (c) => chunks.push(c)); resp.on('end', res); resp.on('error', rej) })
        const hash = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')
        let verdict = 'REPLAYED'
        if (a.expect_hash) verdict = hash === a.expect_hash ? 'PASS' : 'FAIL(hash 不一致)'
        fs.appendFileSync(path.join(a.evidence_dir, 'verify-log.md'),
          `| ${nowIso()} | ${proxy || 'direct'} | ${resp.statusCode} | sha256:${hash.slice(0, 16)}… | ${verdict} |\n`)
        return { ok: !verdict.startsWith('FAIL'), status: resp.statusCode, sha256: hash, verdict }
      } catch (e) {
        return { ok: false, error: `重放失败: ${e.message}` }
      }
    },
  }
}

const SENSITIVE = {
  phone: /(?<!\d)1[3-9]\d{9}(?!\d)/,
  idcard: /(?<!\d)\d{17}[\dXx](?!\d)/,
  bankcard: /(?<!\d)\d{16,19}(?!\d)/,
  aksk: /(?<![A-Za-z0-9])(AK[A-Z0-9]{15,}|LTAI[A-Za-z0-9]{12,}|SK[.A-Za-z0-9_-]{20,})(?![A-Za-z0-9])/,
  token: /(api[_-]?key|secret|token)["'\s:=]+[A-Za-z0-9_\-]{16,}/i,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  private_ip: /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![\d.])/,
}

function toolSurfaceScan() {
  return {
    description: '敏感信息正则回扫（VC-027 脱敏检查）：手机号/身份证/银行卡/AK-SK/token/JWT/内网IP，命中打码+sha256 指纹。',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: '待扫描文件绝对路径（JS/响应 dump/endpoints 等）' } },
      required: ['file'],
      additionalProperties: false,
    },
    execute: async (a) => {
      if (!fs.existsSync(a.file)) return { ok: false, error: '文件不存在' }
      const hits = []
      const lines = fs.readFileSync(a.file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const [name, pat] of Object.entries(SENSITIVE)) {
          const m = line.match(pat)
          if (m) {
            const s = m[0]
            const masked = s.length > 6 ? s.slice(0, 4) + '***' + s.slice(-2) : '***'
            hits.push({ line: i + 1, type: name, masked, sha256: crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) })
            break
          }
        }
      })
      return { ok: true, file: a.file, hits: hits.length, detail: hits.slice(0, 50), truncated: hits.length > 50 }
    },
  }
}

function toolSurfaceQueue() {
  return {
    description: '参数面消费：从 endpoints.tsv（或任意文本）提取带参数 URL，全局去重后入 param-queue.txt（dalfox/sqlmap 喂料队列）。',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string' },
        source: { type: 'string', description: 'endpoints.tsv 或文本文件路径' },
      },
      required: ['program', 'source'],
      additionalProperties: false,
    },
    execute: async (a) => {
      if (!fs.existsSync(a.source)) return { ok: false, error: 'source 不存在' }
      const dir = pipelineDir(a.program)
      const seenFile = path.join(dir, 'param-seen.txt')
      const queueFile = path.join(dir, 'param-queue.txt')
      const seen = new Set(fs.existsSync(seenFile) ? fs.readFileSync(seenFile, 'utf8').split('\n').filter(Boolean) : [])
      const urls = new Set()
      const content = fs.readFileSync(a.source, 'utf8')
      if (a.source.endsWith('.tsv')) {
        for (const line of content.split('\n').slice(1)) {
          const cols = line.split('\t')
          if (cols[0] && cols[0].startsWith('http') && cols[2]) urls.add(cols[0])
        }
      } else {
        for (const m of content.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
          try { if (new URL(m[0]).search) urls.add(m[0]) } catch { /* skip */ }
        }
      }
      const fresh = [...urls].filter((u) => !seen.has(u)).sort()
      if (fresh.length) {
        fs.appendFileSync(queueFile, fresh.join('\n') + '\n')
        fs.appendFileSync(seenFile, fresh.join('\n') + '\n')
      }
      return { ok: true, new_urls: fresh.length, pool: seen.size + fresh.length, queue: queueFile,
        hint: `dalfox file ${queueFile} / sqlmap -m ${queueFile} --batch --level 1 --risk 1` }
    },
  }
}

// -------------------- 注册 --------------------

export function apply(ctx) {
  const defs = [
    ['verify_replay', toolVerifyReplay()],
    ['surface_scan', toolSurfaceScan()],
    ['surface_queue', toolSurfaceQueue()],
  ]
  for (const [n, def] of defs) {
    ctx.tools.register(tool({
      name: n,
      description: def.description,
      parameters: def.parameters,
      render: renderJSON,
      execute: def.execute,
    }))
  }
}
