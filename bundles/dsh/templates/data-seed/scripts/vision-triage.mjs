#!/usr/bin/env node
// ==============================================================================
// P16 视觉分诊（vision-triage.mjs）—— P12 提案落地
// 截图 → deepseek-v4-flash-vision-exp（OpenCode Go）→ 结构化分诊 JSON（stdout JSONL）
// 用途：7.9 万资产无法全量人扫，视觉模型先粗筛"看着值得打"的靶标（登录页/后台/技术栈）。
//
// 用法：node vision-triage.mjs <image1.png> [image2.png ...]
// 输出：每图一行 JSON {image, ok, page_type, tech_stack[], has_login, has_admin, interesting, reason}
// 依赖：环境变量 OPENCODE_GO_API_KEY（systemd EnvironmentFile 已注入）；失败回退 DEEPSEEK_API_KEY。
// 退出码：全成功 0 / 部分失败 2 / 全失败 1
// ==============================================================================
import * as fs from 'node:fs'

// 兜底：非 systemd 环境（手工 CLI）从 BASE_DIR/.env 自加载 key（不覆盖已有环境变量）
if (!process.env.OPENCODE_GO_API_KEY && !process.env.DEEPSEEK_API_KEY) {
  try {
    for (const line of fs.readFileSync('/opt/silkspool/dsh/.env', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim()
    }
  } catch { /* 无 .env 则后续报缺 key */ }
}

const BASE = process.env.SEC_VISION_BASE_URL || 'https://opencode.ai/zen/go/v1'
const MODEL = process.env.SEC_VISION_MODEL || 'deepseek-v4-flash-vision-exp'
const KEY = process.env.OPENCODE_GO_API_KEY || process.env.DEEPSEEK_API_KEY || ''

const PROMPT = `你是 Web 攻击面分诊助手。对截图做结构化分诊，只输出 JSON（无 markdown 围栏）：
{"page_type":"login|admin|dashboard|api_error|docs|portal|static|error|other",
 "tech_stack":["从页面可见线索推断的技术栈/框架/CMS，最多5个"],
 "has_login":true|false,
 "has_admin":true|false,
 "interesting":0.0-1.0,
 "reason":"一句话依据"}
interesting 评分口径：管理后台/登录入口/报错堆栈/非常见中间件页 ≥0.7；普通门户 0.3-0.6；纯静态/CDN 错误页 ≤0.2。`

const b64 = (p) => fs.readFileSync(p).toString('base64')
const mime = (p) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[p.slice(p.lastIndexOf('.')).toLowerCase()] || 'image/png'

async function triage(img) {
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime(img)};base64,${b64(img)}` } },
      ] }],
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(90000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const data = await resp.json()
  const text = (data.choices?.[0]?.message?.content || '').trim()
  const m = text.match(/\{[\s\S]*\}/)
  const parsed = m ? JSON.parse(m[0]) : { page_type: 'other', tech_stack: [], has_login: false, has_admin: false, interesting: 0.3, reason: `解析失败: ${text.slice(0, 80)}` }
  return { image: img, ok: true, model: MODEL, ...parsed }
}

const images = process.argv.slice(2)
if (!images.length) { console.error('用法: vision-triage.mjs <image.png> [more.png ...]'); process.exit(1) }
if (!KEY) { console.error('缺少 OPENCODE_GO_API_KEY / DEEPSEEK_API_KEY 环境变量'); process.exit(1) }

let fail = 0
for (const img of images) {
  try {
    if (!fs.existsSync(img)) throw new Error('文件不存在')
    console.log(JSON.stringify(await triage(img)))
  } catch (e) {
    fail++
    console.log(JSON.stringify({ image: img, ok: false, error: String(e.message).slice(0, 300) }))
  }
}
process.exit(fail === images.length ? 1 : fail ? 2 : 0)
