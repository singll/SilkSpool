// ==============================================================================
// xray webhook 接收器（流量总线 v1：xray 被动审计发现 → JSONL + findings 入库）
// ==============================================================================

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

// 依赖注入（由 index.js 调用 startXrayWebhook 时传入，避免循环依赖）：
//   dataDir  数据目录（主文件 DATA_DIR，用于推导 flows 目录）
//   assetDb  asset-db.js 模块命名空间（addFinding 入库）
//   hostOf   主文件 hostOf()：URL/target → host 归一化
let deps = null
const flowsDir = () => path.join(deps.dataDir, 'flows')
let webhookServer = null

export function startXrayWebhook(injected) {
  deps = injected
  if (webhookServer) return
  fs.mkdirSync(flowsDir(), { recursive: true })
  webhookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1048576) req.destroy() })
    req.on('end', () => {
      try {
        const finding = JSON.parse(body)
        const file = path.join(flowsDir(), `xray-${new Date().toISOString().slice(0, 10)}.jsonl`)
        fs.appendFileSync(file, body + '\n')
        // xray webhook 结构: {type:"web_vuln", data:{title, target, plugin...}}（v2 字段容忍性解析）
        const d = finding.data || finding
        const target = d.target || d.url || ''
        const title = d.title || d.plugin || finding.type || 'xray finding'
        deps.assetDb.addFinding({
          title: `xray: ${title}`, severity: 'medium', host: deps.hostOf(target), url: target,
          source: 'xray-webhook', evidence: `flow:${file}`,
        })
        res.writeHead(200); res.end('ok')
      } catch { res.writeHead(400); res.end('bad json') }
    })
  })
  webhookServer.on('error', (e) => {
    // 端口已被占用（如测试副本在跑）时降级为不起服务，不影响插件加载
    process.stderr.write(`[sec-suite] xray webhook 启动失败: ${e.message}\n`)
    webhookServer = null
  })
  webhookServer.listen(7788, '127.0.0.1')
  // 进程生命周期级：不绑 fiber dispose（fiber 重配回收不该关掉 webhook）
}
