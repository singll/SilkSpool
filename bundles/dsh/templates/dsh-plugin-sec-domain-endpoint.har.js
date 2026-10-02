// Passive HAR 1.2 conversion. No network, credentials lookup, or business verdicts.
import * as crypto from 'node:crypto'

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
const SECRET = /authorization|cookie|password|passwd|secret|token|api[-_]?key|session[-_]?id|csrf|xsrf/i
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value) + '\n')
const reject = code => { throw Object.assign(new Error(code), { code }) }
const pointer = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1')

export function parseHar(bytes) {
  let har
  try { har = JSON.parse(bytes.toString('utf8')) } catch { reject('E_HAR_JSON') }
  if (har?.log?.version !== '1.2' || !Array.isArray(har.log.entries)) reject('E_HAR_FORMAT')
  return { entries: har.log.entries, sha256: sha256(bytes) }
}

export function harObservation(entry, { sourceSha256, index, programId, runId, binding = {} }) {
  const request = entry?.request
  if (!request || !METHODS.has(request.method)) reject('E_HAR_METHOD')
  let url
  try { url = new URL(request.url) } catch { reject('E_HAR_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) reject('E_HAR_URL')
  // Full URLs enter existing endpoint projections. Keep URL credentials only in
  // the source capture until that surface has a separate protected URL reference.
  if ([...url.searchParams.keys()].some(name => SECRET.test(name))) reject('E_HAR_SENSITIVE_URL')
  const prefix = `evidence/requests/${sourceSha256}/${index}`
  const evidencePath = `${prefix}/entry.json`
  const headersPath = `${prefix}/headers.json`
  const files = new Map([[evidencePath, json({ format: 'har-1.2', source_sha256: sourceSha256, entry_index: index, entry })]])
  const headers = request.headers ?? []
  if (!Array.isArray(headers) || headers.length > 500
      || headers.some(h => typeof h?.name !== 'string' || !h.name || typeof h?.value !== 'string')) reject('E_HAR_HEADERS')
  files.set(headersPath, json(headers))
  const types = headers.filter(h => h.name.toLowerCase() === 'content-type').map(h => h.value)
  if (new Set(types.map(v => v.toLowerCase())).size > 1) reject('E_HAR_CONTENT_TYPE')
  const post = request.postData
  if (post !== undefined && (!post || typeof post !== 'object' || typeof post.mimeType !== 'string')) reject('E_HAR_CONTENT_TYPE')
  const contentType = post?.mimeType || types[0] || ''
  const mime = contentType.split(';')[0].trim().toLowerCase()
  if (post && (typeof post !== 'object' || typeof post.mimeType !== 'string'
      || types[0] && types[0].split(';')[0].trim().toLowerCase() !== mime)) reject('E_HAR_CONTENT_TYPE')
  const parameters = []
  const add = (name, location, value, ref, secret = false) => {
    if (!name || parameters.length >= 500) reject('E_HAR_PARAMETERS')
    const p = { name, in: location }
    if (secret || SECRET.test(name)) p.value_ref = ref
    else p.value = value
    parameters.push(p)
  }
  for (const [name, value] of url.searchParams) add(name, 'query', value)
  // A capture with a conflicting query list must not invent a second request.
  if (request.queryString !== undefined) {
    const pairs = request.queryString
    if (!Array.isArray(pairs) || pairs.some(p => typeof p?.name !== 'string' || typeof p?.value !== 'string')
        || JSON.stringify(pairs.map(p => [p.name, p.value])) !== JSON.stringify([...url.searchParams])) reject('E_HAR_QUERY_MISMATCH')
  }
  headers.forEach((h, i) => {
    if (h.name.toLowerCase() !== 'content-type') parameters.push({ name: h.name, in: 'header', value_ref: `${headersPath}#/${i}/value` })
  })
  if (request.cookies !== undefined) {
    if (!Array.isArray(request.cookies) || request.cookies.length > 500
        || request.cookies.some(c => typeof c?.name !== 'string' || !c.name || typeof c?.value !== 'string')) reject('E_HAR_COOKIES')
    request.cookies.forEach((c, i) => parameters.push({ name: c.name, in: 'cookie', value_ref: `${evidencePath}#/entry/request/cookies/${i}/value` }))
  }
  const observation = { program_id: programId, run_id: runId, url: url.href, method: request.method,
    parameters, evidence_path: evidencePath, headers_ref: headersPath,
    capture: { format: 'har-1.2', source_sha256: sourceSha256, entry_index: index } }
  if (contentType) observation.content_type = contentType
  if (typeof entry.startedDateTime === 'string' && Number.isFinite(Date.parse(entry.startedDateTime))) observation.capture.started_at = entry.startedDateTime
  const status = entry.response?.status
  if (Number.isInteger(status) && status >= 100 && status <= 599) observation.response_status = status
  else if (status !== undefined && status !== 0) reject('E_HAR_RESPONSE_STATUS')
  if (post) {
    const bodyPath = `${prefix}/body.txt`
    // params-only captures retain their structure, but are not a wire body.
    if (post.text !== undefined) {
      if (typeof post.text !== 'string' || post.encoding !== undefined) reject('E_HAR_BODY_ENCODING')
      files.set(bodyPath, Buffer.from(post.text))
      observation.body_ref = bodyPath
    }
    if (mime === 'application/json' || mime.endsWith('+json')) {
      if (post.text === undefined) reject('E_HAR_BODY_MISSING')
      let body
      try { body = JSON.parse(post.text) } catch { reject('E_HAR_BODY_JSON') }
      const walk = (value, segments, depth, secret = false) => {
        if (depth > 32) reject('E_HAR_BODY_DEPTH')
        if (depth === 0 && value && typeof value === 'object' && !Object.keys(value).length) return
        if (value && typeof value === 'object' && Object.keys(value).length) {
          for (const [key, child] of Object.entries(value)) walk(child, [...segments, key], depth + 1, secret || SECRET.test(key))
        } else {
          const name = '/' + segments.map(pointer).join('/')
          add(name, 'json', value, bodyPath + '#' + (segments.length ? name : ''), secret)
        }
      }
      walk(body, [], 0)
    } else if (mime === 'application/x-www-form-urlencoded') {
      const params = post.text !== undefined ? [...new URLSearchParams(post.text)].map(([name, value]) => ({ name, value })) : post.params
      if (!Array.isArray(params) || params.some(p => typeof p?.name !== 'string' || typeof p?.value !== 'string')) reject('E_HAR_FORM')
      const paramsPath = `${prefix}/form.json`
      files.set(paramsPath, json(params))
      params.forEach((p, i) => add(p.name, 'form', p.value, `${paramsPath}#/${i}/value`))
      if (!observation.body_ref) observation.capture.body_state = 'parameters_only'
    } else if (mime === 'multipart/form-data') {
      if (!Array.isArray(post.params)) reject('E_HAR_MULTIPART')
      post.params.forEach((p, i) => {
        if (typeof p?.name !== 'string' || !p.name) reject('E_HAR_MULTIPART')
        const ref = `${evidencePath}#/entry/request/postData/params/${i}`
        if (p.fileName !== undefined) parameters.push({ name: p.name, in: 'multipart', value_ref: ref })
        else if (typeof p.value === 'string') add(p.name, 'multipart', p.value, ref + '/value')
        else reject('E_HAR_MULTIPART')
      })
      observation.capture.body_state = observation.body_ref ? 'captured' : 'parameters_only'
    } else if (!observation.body_ref) reject('E_HAR_BODY_MISSING')
  } else if (request.bodySize > 0) reject('E_HAR_BODY_MISSING')
  if (parameters.length > 500) reject('E_HAR_PARAMETERS')
  for (const key of ['credential_ref', 'subject_ref', 'object_refs', 'action', 'session_id', 'task_id']) {
    if (binding[key] !== undefined) observation[key] = binding[key]
  }
  // Digest every extracted artifact, including form value references.
  observation.capture.artifacts = [...files].map(([ref, bytes]) => ({ path: ref, sha256: sha256(bytes) }))
  if ([...files.values()].some(bytes => bytes.length > 1024 * 1024)) reject('E_HAR_ENTRY_SIZE')
  return { observation, files }
}
