#!/usr/bin/env node
/**
 * Claude Code 三模型路由代理
 *
 * 启动（Windows PowerShell）：
 *   $env:CCR_MAIN_KEY="讯飞Key"
 *   $env:CCR_SONNET_KEY="DeepSeekKey"
 *   $env:CCR_BG_KEY="MiniMaxKey"
 *   node proxy.js
 */

const http  = require('http')
const https = require('https')
const { URL } = require('url')

/* ── 模型配置 ─────────────────────────────────────────────── */
const MODELS = [
  {
    name:       'astron-code-latest',
    tag:        'opus',
    url:        'https://maas-coding-api.cn-huabei-1.xf-yun.com/anthropic/v1/messages',
    key:        (process.env.CCR_MAIN_KEY    || 'api-key1').trim(),
    match:      m => /claude-opus|astron-code/i.test(m),
    stripBetas: ['interleaved-thinking', 'redact-thinking'],
    maxTokens:  32768,
    sanitize:   false,
  },
  {
    name:       'deepseek-v4-pro',
    tag:        'sonnet',
    url:        'https://api.deepseek.com/anthropic/v1/messages',
    key:        (process.env.CCR_SONNET_KEY  || 'api-key2').trim(),
    match:      m => /claude-sonnet|deepseek/i.test(m),
    stripBetas: [
      'interleaved-thinking', 'redact-thinking', 'thinking',
      'claude-code-20250219', 'context-management', 'prompt-caching',
      'effort-2025-11-24',
    ],
    maxTokens:  16384,
    sanitize:   true,
  },
  {
    name:       'MiniMax-M2.7',
    tag:        'haiku',
    url:        'https://api.minimaxi.com/anthropic/v1/messages',
    key:        (process.env.CCR_BG_KEY      || 'api-key3').trim(),
    match:      m => /claude-haiku|minimax/i.test(m),
    stripBetas: [
      'interleaved-thinking', 'redact-thinking', 'thinking',
      'claude-code-20250219', 'context-management', 'prompt-caching',
      'effort-2025-11-24',
    ],
    maxTokens:  16384,
    sanitize:   true,
  },
]

/* ────────────────────────────────────────────────────────── */
const PORT        = 3456
const MAX_BODY    = 10 * 1024 * 1024
const RETRY_CODES = [500, 502, 503]
const RETRY_DELAY = 2000

const ALLOWED_FIELDS = new Set([
  'model', 'messages', 'max_tokens', 'system', 'stream',
  'temperature', 'top_p', 'top_k', 'stop_sequences',
  'tools', 'tool_choice',
])

let reqId = 0
const stats = { requests: 0, retries: 0, errors: 0, startTime: Date.now() }
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

/* ── 模型匹配 ─────────────────────────────────────────────── */
function getConfig(model) {
  if (!model) return MODELS[0]
  const stripped = model.replace(/\[.*?\]$/g, '').trim()
  return MODELS.find(m => m.match(stripped))
      || MODELS.find(m => m.match(model))
      || MODELS[0]
}

/* ── 消息清理 ─────────────────────────────────────────────── */
function sanitizeMessages(messages) {
  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg

    const filtered = msg.content.filter(b =>
      b.type === 'text'        ||
      b.type === 'tool_use'    ||
      b.type === 'tool_result' ||
      b.type === 'thinking'    // ← 历史 thinking 块必须保留，否则 API 报错
    )

    return {
      ...msg,
      content: filtered.length > 0
        ? filtered
        : [{ type: 'text', text: '(continue)' }],
    }
  })
}

/* ── 请求体构建 ───────────────────────────────────────────── */
function buildBody(json, config) {
  let body

  if (config.sanitize) {
    body = {}
    for (const key of ALLOWED_FIELDS) {
      if (json[key] !== undefined) body[key] = json[key]
    }

    // 去掉不让模型新开 thinking，但历史里的 thinking 块由 sanitizeMessages 保留
    delete body.thinking
    delete body.metadata
    delete body.output_config

    // 扁平化 system 数组
    if (Array.isArray(body.system)) {
      body.system = body.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n')
    }

    // 清理 messages（保留 thinking 历史块）
    if (Array.isArray(body.messages)) {
      body.messages = sanitizeMessages(body.messages)
    }
  } else {
    body = { ...json }
  }

  body.model = config.name

  if (!body.max_tokens || body.max_tokens <= 0) body.max_tokens = 4096
  body.max_tokens = Math.min(body.max_tokens, config.maxTokens)

  return JSON.stringify(body)
}

/* ── 请求头构建 ───────────────────────────────────────────── */
function buildHeaders(req, config, bodyLength) {
  const headers = {
    'content-type':      'application/json',
    'content-length':    bodyLength,
    'x-api-key':         config.key,
    'accept':            req.headers['accept'] || 'application/json',
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  }

  for (const [k, v] of Object.entries(req.headers)) {
    if (!k.startsWith('anthropic-') || headers[k]) continue
    if (k === 'anthropic-beta') {
      const filtered = v.split(',')
        .map(b => b.trim())
        .filter(b => !config.stripBetas.some(bad => b.includes(bad)))
        .join(',')
      if (filtered) headers[k] = filtered
    } else {
      headers[k] = v
    }
  }

  return headers
}

/* ── 错误处理 ─────────────────────────────────────────────── */
function extractError(status, body) {
  try {
    const p = JSON.parse(body)
    const msg = p?.error?.message || ''
    const m = msg.match(/msg:\s*([^,]+?)(?:,\s*timeStamp|$)/)
    if (m) return m[1].trim()
    if (msg) return msg
  } catch {}
  return `上游错误 HTTP ${status}`
}

function sendError(res, status, message) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }))
}

/* ── 转发 ─────────────────────────────────────────────────── */
function forward(opts, body, json, config, res, id, retried = false) {
  const req = https.request(opts, upstream => {
    const status = upstream.statusCode

    if (status !== 200) {
      let errText = ''
      upstream.on('data', c => { errText += c })
      upstream.on('end', () => {
        console.warn(`[${ts()}] #${id} ⚠ ${status}: ${errText.slice(0, 300)}`)

        if (status === 400) {
          try {
            const parsed = JSON.parse(body)
            console.warn(`[${ts()}] #${id} 请求字段: ${Object.keys(parsed).join(', ')}`)
            console.warn(`[${ts()}] #${id} beta 头: ${opts.headers['anthropic-beta'] || '(无)'}`)
            console.warn(`[${ts()}] #${id} max_tokens: ${parsed.max_tokens}, model: ${parsed.model}`)
            if (parsed.tools) console.warn(`[${ts()}] #${id} tools 数量: ${parsed.tools.length}`)
          } catch {}
        }

        if (!retried && RETRY_CODES.includes(status)) {
          stats.retries++
          console.log(`[${ts()}] #${id} 🔄 重试中...`)
          return setTimeout(() => forward(opts, body, json, config, res, id, true), RETRY_DELAY)
        }

        sendError(res, status, extractError(status, errText))
      })
      return
    }

    const isStream = json.stream === true ||
      (upstream.headers['content-type'] || '').includes('event-stream')

    if (isStream) {
      res.writeHead(200, {
        'content-type':                upstream.headers['content-type'] || 'text/event-stream',
        'cache-control':               'no-cache',
        'access-control-allow-origin': '*',
      })
      upstream.pipe(res)
    } else {
      let data = ''
      upstream.on('data', c => { data += c })
      upstream.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(data)
      })
    }
  })

  req.on('error', e => {
    stats.errors++
    console.error(`[${ts()}] #${id} ❌ ${e.message}`)
    sendError(res, 502, `网络错误: ${e.message}`)
  })

  req.setTimeout(300000, () => {
    req.destroy()
    sendError(res, 504, '请求超时，请重试')
  })

  req.write(body)
  req.end()
}

/* ── HTTP 服务 ────────────────────────────────────────────── */
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' })
    return res.end()
  }

  const path = (req.url || '/').split('?')[0]

  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    const s = Math.floor((Date.now() - stats.startTime) / 1000)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', uptime: `${Math.floor(s/60)}m${s%60}s`, stats }))
  }

  if (path === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map(m => ({
        id: m.name, display_name: m.name, type: 'model', created_at: '2025-05-14T00:00:00Z',
      })),
    }))
  }

  if (!path.startsWith('/v1/messages')) {
    res.writeHead(404)
    return res.end(JSON.stringify({ error: { message: `Not found: ${path}` } }))
  }

  let raw = '', size = 0, dead = false

  req.on('data', chunk => {
    if (dead) return
    size += chunk.length
    if (size > MAX_BODY) {
      dead = true
      res.writeHead(413)
      res.end('{"error":{"message":"Payload too large"}}')
      req.destroy()
      return
    }
    raw += chunk
  })

  req.on('end', () => {
    if (dead) return

    let json
    try { json = JSON.parse(raw) } catch (e) {
      res.writeHead(400)
      return res.end(JSON.stringify({ error: { message: 'Invalid JSON: ' + e.message } }))
    }

    const config = getConfig(json.model || '')
    const body   = buildBody(json, config)
    const id     = ++reqId
    stats.requests++

    const arrow = json.model !== config.name ? ` → ${config.name}` : ''
    const think = json.thinking?.budget_tokens ? ` [thinking=${json.thinking.budget_tokens}]` : ''
    console.log(`[${ts()}] #${id} [${config.tag}] ${json.model || '?'}${arrow}${think}`)

    const target = new URL(config.url)
    forward(
      {
        hostname: target.hostname,
        port:     target.port || 443,
        path:     target.pathname,
        method:   'POST',
        headers:  buildHeaders(req, config, Buffer.byteLength(body)),
      },
      body, json, config, res, id
    )
  })

  req.on('error', e => console.error(`[${ts()}] 请求错误: ${e.message}`))

}).listen(PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║         Claude Code 三模型路由代理           ║')
  console.log('╠══════════════════════════════════════════════╣')
  console.log(`║  地址: http://127.0.0.1:${PORT}                 ║`)
  console.log('╠══════════════════════════════════════════════╣')
  MODELS.forEach(m => {
    const ok = m.key ? '✅' : '❌ 缺少Key'
    console.log(`║  [${m.tag.padEnd(6)}] ${m.name.padEnd(24)} ${ok}        ║`)
  })
  /*console.log('╠══════════════════════════════════════════════╣')
  console.log('║  ✅ 历史 thinking 块保留（防跨模型 400）      ║')
  console.log('║  ✅ output_config/metadata/effort 过滤        ║')
  console.log('║  ✅ 全模型工具支持  ✅ 自动重试               ║')*/
  console.log('╚══════════════════════════════════════════════╝\n')
})

setInterval(() => {
  const s = Math.floor((Date.now() - stats.startTime) / 1000)
  console.log(`── [${Math.floor(s/60)}分${s%60}秒] 请求:${stats.requests} 重试:${stats.retries} 错误:${stats.errors} ──`)
}, 60000)

process.on('SIGINT', () => { console.log('\n代理已停止'); process.exit(0) })