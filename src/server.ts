import express from 'express'
import path from 'node:path'
import type { BotManager } from './bot-manager'
import type { AgentRegistry } from './agent-registry'
import type { CommandHandler } from './command-handler'
import type { NotificationService } from './notification'
import type { AppConfig } from './config'
import { saveAgents } from './config'
import type { Storage } from './types'
import { API_KEY_STORAGE_KEY, DEFAULT_RECIPIENT_KEY } from './types'
import type { Logger } from 'pino'
import { authMiddleware } from './middleware/auth'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { loggingMiddleware } from './middleware/logging'
import { getMetrics, botStatus } from './metrics'
import cors from 'cors'
import helmet from 'helmet'
import csrf from 'csurf'

export function createServer(
  config: AppConfig,
  botManager: BotManager,
  agentRegistry: AgentRegistry,
  commandHandler: CommandHandler,
  notificationService: NotificationService,
  storage: Storage,
  logger: Logger,
) {
  const app = express()

  // 自定义 CSP 配置，允许管理界面必要的内联脚本
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://api.qrserver.com"],
        connectSrc: ["'self'", "http://localhost:*", "https://*.replit.dev", "https://*.replit.app"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  }))
  
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || true,
    credentials: true
  }))
  
  app.use(express.json())
  app.use(loggingMiddleware(logger))
  app.use(rateLimitMiddleware())
  
  // CSRF 保护 - 排除 API 认证路由
  const csrfProtection = csrf({ cookie: false })
  const apiRoutes = ['/api/bot/login', '/api/bot/status', '/api/health', '/api/metrics', '/api/webhook']
  

  app.use(express.static(path.resolve(__dirname, '../public')))

  app.get('/admin', (_req, res) => {
    res.redirect('/admin.html')
  })

  // 动态认证：同时检查环境变量和存储中设置的密码
  let cachedStoredKey: string | null | undefined = undefined // undefined = 未加载, null = 无
  async function getEffectiveKey(): Promise<string> {
    if (config.apiKey) return config.apiKey
    if (cachedStoredKey === undefined) {
      const stored = await storage.get<string>(API_KEY_STORAGE_KEY)
      cachedStoredKey = stored || null
    }
    return cachedStoredKey || ''
  }
  function refreshStoredKey() {
    cachedStoredKey = undefined
  }

  // 覆盖 auth 中间件为动态版本
  const dynamicAuth = async (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> => {
    const effectiveKey = await getEffectiveKey()
    if (!effectiveKey) {
      next()
      return
    }
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (authHeader.slice(7) !== effectiveKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }

  app.get('/', (_req, res) => {
    const status = botManager.getStatus()
    const agents = agentRegistry.listAll()
    res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeClawBot Bridge</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #333; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .sub { color: #888; font-size: 14px; margin-bottom: 24px; }
  .card { background: #f8f8f8; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card h3 { margin: 0 0 8px 0; font-size: 16px; }
  .card p { margin: 4px 0; font-size: 14px; color: #555; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
  .online { background: #d4edda; color: #155724; }
  .offline { background: #f8d7da; color: #721c24; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; }
  th { color: #888; font-weight: 500; }
</style>
</head>
<body>
<h1>WeClawBot Bridge</h1>
<p class="sub">微信 ↔ OpenClaw AI Agent 桥接网关</p>
<p style="margin-bottom:16px"><a href="/admin" style="color:#4f46e5;font-size:14px">打开管理面板</a></p>
<div class="card">
  <h3>Bot 状态</h3>
  <p>在线状态：<span class="badge ${status.loggedIn ? 'online' : 'offline'}">${status.loggedIn ? '在线' : '离线'}</span></p>
  ${status.accountId ? `<p>账号：${status.accountId}</p>` : status.qrUrl ? `
    <p style="margin-top:12px">请使用微信扫描二维码登录：</p>
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(status.qrUrl)}" alt="微信登录二维码" style="border:1px solid #ddd;border-radius:8px;margin-top:8px">
    <p style="font-size:12px;color:#999;margin-top:8px">二维码过期后可通过 <code>POST /api/bot/login</code> 刷新</p>
  ` : '<p>正在获取二维码...</p>'}
</div>
<div class="card">
  <h3>已注册 Agent（${agents.length} 个）</h3>
  <table>
    <tr><th>命令</th><th>名称</th><th>类型</th><th>描述</th></tr>
    ${agents.map(a => `<tr><td><code>/${a.command}</code></td><td>${a.name}</td><td style="font-size:12px">${a.type === 'cli' ? 'CLI' : 'HTTP'}</td><td style="color:#888">${a.description}</td></tr>`).join('')}
  </table>
</div>
<div class="card">
  <h3>API 端点</h3>
  <table>
    <tr><td>健康检查</td><td><code>GET /api/health</code></td></tr>
    <tr><td>Prometheus 指标</td><td><code>GET /api/metrics</code></td></tr>
    <tr><td>Bot 登录</td><td><code>POST /api/bot/login</code></td></tr>
    <tr><td>Agent 管理</td><td><code>GET/POST/DELETE /api/agents</code></td></tr>
    <tr><td>发送通知</td><td><code>POST /api/notify</code></td></tr>
    <tr><td>通知规则</td><td><code>POST/DELETE /api/notify/rules</code></td></tr>
  </table>
</div>
</body>
</html>`)
  })

  // ===== 认证 API =====
  app.post('/api/auth/login', async (req, res) => {
    const { password } = req.body
    const storedKey = await storage.get<string>(API_KEY_STORAGE_KEY)
    const effectiveKey = config.apiKey || storedKey || ''

    if (!effectiveKey) {
      // 未设置密码，直接放行
      res.json({ authenticated: true, token: '' })
      return
    }

    if (password !== effectiveKey) {
      res.status(401).json({ error: '密码错误' })
      return
    }

    res.json({ authenticated: true, token: effectiveKey })
  })

  app.get('/api/auth/status', async (req, res) => {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''

    const storedKey = await storage.get<string>(API_KEY_STORAGE_KEY)
    const effectiveKey = config.apiKey || storedKey || ''

    if (!effectiveKey) {
      res.json({ authenticated: true, passwordSet: false })
      return
    }

    res.json({ authenticated: token === effectiveKey, passwordSet: true })
  })

  app.post('/api/auth/setup', async (req, res) => {
    // 首次设置密码（仅在未设置时允许）
    const storedKey = await storage.get<string>(API_KEY_STORAGE_KEY)
    const effectiveKey = config.apiKey || storedKey || ''

    if (effectiveKey) {
      res.status(403).json({ error: '密码已设置，请使用修改密码接口' })
      return
    }

    const { password } = req.body
    if (!password || password.length < 4) {
      res.status(400).json({ error: '密码至少4位' })
      return
    }

    await storage.set(API_KEY_STORAGE_KEY, password)
    refreshStoredKey()
    res.json({ ok: true, token: password })
  })

  app.post('/api/auth/change-password', dynamicAuth, async (req, res) => {
    const { oldPassword, newPassword } = req.body
    const storedKey = await storage.get<string>(API_KEY_STORAGE_KEY)
    const effectiveKey = config.apiKey || storedKey || ''

    if (oldPassword !== effectiveKey) {
      res.status(401).json({ error: '旧密码错误' })
      return
    }

    if (!newPassword || newPassword.length < 4) {
      res.status(400).json({ error: '新密码至少4位' })
      return
    }

    await storage.set(API_KEY_STORAGE_KEY, newPassword)
    refreshStoredKey()
    res.json({ ok: true, token: newPassword })
  })

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      bot: botManager.getStatus(),
    })
  })

  app.get('/api/metrics', async (_req, res) => {
    res.set('Content-Type', 'text/plain')
    res.send(await getMetrics())
  })

  app.post('/api/bot/login', dynamicAuth, async (_req, res) => {
    try {
      let qrUrl: string | undefined
      await botManager.login((url) => {
        qrUrl = url
      })
      if (!botManager.isRunning) {
        await botManager.start()
        botStatus.set(1)
        logger.info('Bot started after manual login')
      }
      res.json({ qrUrl, status: 'waiting_for_scan' })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/api/bot/status', (_req, res) => {
    res.json(botManager.getStatus())
  })

  app.get('/api/config', async (_req, res) => {
    const apiKey = await storage.get<string>(API_KEY_STORAGE_KEY)
    res.json({ apiKey: apiKey || '' })
  })

  app.post('/api/config', dynamicAuth, async (req, res) => {
    try {
      const { apiKey } = req.body
      if (apiKey !== undefined) {
        await storage.set(API_KEY_STORAGE_KEY, apiKey)
      }
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/api/agents', (_req, res) => {
    res.json(agentRegistry.listAll())
  })

  app.post('/api/agents', dynamicAuth, (req, res) => {
    try {
      agentRegistry.register(req.body)
      commandHandler.updateAgents(agentRegistry.listAll())
      saveAgents(agentRegistry.listAll(), config.defaultAgentId)
      res.status(201).json(req.body)
    } catch (err) {
      const error = err as Error
      res.status(400).json({ error: error.message })
    }
  })

  app.put('/api/agents/:id', dynamicAuth, (req, res) => {
    try {
      const existing = agentRegistry.get(req.params.id as string)
      if (!existing) {
        res.status(404).json({ error: 'Agent not found' })
        return
      }
      const updated = { ...existing, ...req.body, id: existing.id }
      agentRegistry.unregister(existing.id)
      agentRegistry.register(updated)
      commandHandler.updateAgents(agentRegistry.listAll())
      saveAgents(agentRegistry.listAll(), config.defaultAgentId)
      res.json(updated)
    } catch (err) {
      const error = err as Error
      res.status(400).json({ error: error.message })
    }
  })

  app.delete('/api/agents/:id', dynamicAuth, (req, res) => {
    agentRegistry.unregister(req.params.id as string)
    commandHandler.updateAgents(agentRegistry.listAll())
    saveAgents(agentRegistry.listAll(), config.defaultAgentId)
    res.json({ ok: true })
  })

  app.post('/api/agents/:id/test', dynamicAuth, async (req, res) => {
    const agentId = req.params.id as string
    const agent = agentRegistry.get(agentId)
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    const { text } = req.body
    if (!text) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    try {
      const start = Date.now()
      const response = await agentRegistry.invoke(agentId, {
        message: { text, type: 'text' },
        session: { userId: 'admin-test', agentId, history: [] },
      })
      res.json({
        text: response.reply.text,
        elapsed: Date.now() - start,
      })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/api/notify', dynamicAuth, async (req, res) => {
    try {
      const { content } = req.body
      if (!content) {
        res.status(400).json({ error: 'content is required' })
        return
      }
      
      // 自动使用当前登录的Bot用户作为收件人
      const botStatus = botManager.getStatus()
      if (!botStatus.loggedIn || !botStatus.currentUser) {
        res.status(400).json({ error: 'Bot not logged in' })
        return
      }
      
      await notificationService.send(botStatus.currentUser, content)
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/api/notify/rules', dynamicAuth, (req, res) => {
    try {
      notificationService.addRule(req.body)
      res.status(201).json(req.body)
    } catch (err) {
      const error = err as Error
      res.status(400).json({ error: error.message })
    }
  })

  app.delete('/api/notify/rules/:id', dynamicAuth, (req, res) => {
    notificationService.removeRule(req.params.id as string)
    res.json({ ok: true })
  })

  app.get('/api/notify/log', dynamicAuth, async (_req, res) => {
    const logs = await notificationService.getNotificationLogs()
    res.json(logs)
  })

  app.post('/api/webhook', async (req, res) => {
    try {
      const { userId, text, content } = req.body

      // userId 可选；未提供时发给 Bot 当前登录账号（即管理员自己）
      const botStatus = botManager.getStatus()
      const recipient: string | null = userId || (botStatus.loggedIn ? (botStatus.currentUser ?? null) : null)

      if (!recipient) {
        res.status(503).json({ error: 'Bot 未登录，无法发送通知。请先扫码登录。' })
        return
      }

      const sendContent = content || { text: text || 'empty' }
      await notificationService.send(recipient, sendContent)
      res.json({ ok: true, recipient })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  return app
}
