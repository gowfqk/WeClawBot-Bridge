import express from 'express'
import path from 'node:path'
import type { BotManager } from './bot-manager'
import type { AgentRegistry } from './agent-registry'
import type { CommandHandler } from './command-handler'
import type { NotificationService } from './notification'
import type { SessionManager } from './session-manager'
import type { AppConfig } from './config'
import { saveAgents } from './config'
import type { Storage } from './types'
import { API_KEY_STORAGE_KEY } from './types'
import type { Logger } from 'pino'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { loggingMiddleware } from './middleware/logging'
import { SessionAuth } from './middleware/session-auth'
import { csrfOriginMiddleware } from './middleware/csrf'
import { getMetrics, botStatus } from './metrics'
import {
  LoginSchema, SetupSchema, ChangePasswordSchema,
  AgentConfigSchema, NotifySchema, NotifyRuleSchema,
  SessionConfigSchema, ConfigImportSchema, validate,
} from './schemas'
import cors from 'cors'
import helmet from 'helmet'

export function createServer(
  config: AppConfig,
  botManager: BotManager,
  agentRegistry: AgentRegistry,
  commandHandler: CommandHandler,
  notificationService: NotificationService,
  storage: Storage,
  sessionManager: SessionManager,
  logger: Logger,
) {
  const app = express()

  // 自定义 CSP 配置，允许管理界面必要的资源
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://static.cloudflareinsights.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
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
  
  app.use(express.json({ limit: '1mb' }))
  app.use(loggingMiddleware(logger))
  app.use(rateLimitMiddleware())

  // CSRF 保护：验证浏览器请求的 Origin/Referer 头
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim().replace(/\/$/, ''))
  app.use('/api', csrfOriginMiddleware(allowedOrigins))

  app.use(express.static(path.resolve(__dirname, '../public')))

  app.get('/admin', (_req, res) => {
    res.redirect('/')
  })

  // SPA fallback: 所有非 API、非静态文件路由返回 index.html
  app.get('*', (_req, res, next) => {
    // 仅对非 API 路径且 Accept HTML 的请求返回 SPA 入口
    if (_req.path.startsWith('/api') || !_req.accepts('html')) {
      next()
      return
    }
    res.sendFile(path.resolve(__dirname, '../public/index.html'))
  })

  // ===== 会话认证系统 =====
  const sessionAuth = new SessionAuth(storage, config.apiKey)

  // 认证中间件：验证 Bearer Token（会话令牌，非密码）
  const dynamicAuth = async (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> => {
    const passwordSet = await sessionAuth.isPasswordSet()
    if (!passwordSet) {
      // 未设置密码，直接放行
      next()
      return
    }
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const token = authHeader.slice(7)
    const result = sessionAuth.validateToken(token)
    if (!result.valid) {
      if (result.expired) {
        res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' })
      } else {
        res.status(401).json({ error: 'Unauthorized' })
      }
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
<p style="margin-bottom:16px"><a href="/" style="color:#4f46e5;font-size:14px">打开管理面板</a></p>
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
    const v = validate(LoginSchema, req.body)
    if (!v.ok) { res.status(400).json({ error: v.error }); return }
    const { password } = v.data
    const passwordSet = await sessionAuth.isPasswordSet()

    if (!passwordSet) {
      // 未设置密码，提示先设置密码
      res.status(403).json({ error: '请先设置管理密码', code: 'PASSWORD_NOT_SET' })
      return
    }

    if (!password) {
      res.status(400).json({ error: '请输入密码' })
      return
    }

    const session = await sessionAuth.login(password)
    if (!session) {
      res.status(401).json({ error: '密码错误' })
      return
    }

    res.json({ authenticated: true, token: session.token, expiresAt: session.expiresAt })
  })

  app.get('/api/auth/status', async (req, res) => {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''

    const passwordSet = await sessionAuth.isPasswordSet()
    if (!passwordSet) {
      // 未设置密码：不认为已认证，强制用户先设置密码
      res.json({ authenticated: false, passwordSet: false })
      return
    }

    const result = sessionAuth.validateToken(token)
    if (result.expired) {
      res.json({ authenticated: false, passwordSet: true, expired: true })
      return
    }

    res.json({ authenticated: result.valid, passwordSet: true })
  })

  app.post('/api/auth/setup', async (req, res) => {
    // 首次设置密码（仅在未设置时允许）
    const passwordSet = await sessionAuth.isPasswordSet()
    if (passwordSet) {
      res.status(403).json({ error: '密码已设置，请使用修改密码接口' })
      return
    }

    const v = validate(SetupSchema, req.body)
    if (!v.ok) { res.status(400).json({ error: v.error }); return }
    const { password } = v.data

    await sessionAuth.setPassword(password)

    // 设置密码后自动登录，返回会话 Token
    const session = await sessionAuth.login(password)
    res.json({ ok: true, token: session!.token, expiresAt: session!.expiresAt })
  })

  app.post('/api/auth/change-password', dynamicAuth, async (req, res) => {
    const v = validate(ChangePasswordSchema, req.body)
    if (!v.ok) { res.status(400).json({ error: v.error }); return }
    const { oldPassword, newPassword } = v.data

    const success = await sessionAuth.changePassword(oldPassword, newPassword)
    if (!success) {
      res.status(401).json({ error: '旧密码错误' })
      return
    }

    // 密码修改成功后自动重新登录
    const session = await sessionAuth.login(newPassword)
    res.json({ ok: true, token: session!.token, expiresAt: session!.expiresAt })
  })

  app.post('/api/auth/logout', dynamicAuth, (req, res) => {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
    sessionAuth.logout(token)
    res.json({ ok: true })
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

  app.get('/api/config', dynamicAuth, async (_req, res) => {
    const passwordSet = await sessionAuth.isPasswordSet()
    res.json({ apiKeySet: passwordSet })
  })

  app.post('/api/config', dynamicAuth, async (req, res) => {
    try {
      const { apiKey } = req.body
      if (apiKey !== undefined) {
        if (apiKey) {
          await sessionAuth.setPassword(apiKey)
        } else {
          // 清空密码：同时删除旧明文 key 和新哈希 key
          await storage.delete(API_KEY_STORAGE_KEY)
          await storage.delete('config:api_key_hash')
          sessionAuth.logout()
        }
      }
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  // ===== 配置备份 =====
  app.get('/api/config/export', dynamicAuth, async (_req, res) => {
    try {
      const agents = agentRegistry.listAll()
      const sessionConfig = await sessionManager.getConfig()
      const notifyRules = notificationService.listRules()

      // 导出全部存储数据
      const allKeys = await storage.listKeys()
      const storageDump: Record<string, unknown> = {}
      for (const key of allKeys) {
        const val = await storage.get(key)
        if (val !== undefined) storageDump[key] = val
      }

      // 导出会话列表
      const sessionKeys = allKeys.filter(k => k.startsWith('session:') && k !== 'session:config')
      const sessions: unknown[] = []
      for (const key of sessionKeys) {
        const val = await storage.get(key)
        if (val !== undefined) sessions.push(val)
      }

      // 导出通知日志
      const notifyLogKeys = allKeys.filter(k => k.startsWith('notify:log:'))
      const notifyLogs: unknown[] = []
      for (const key of notifyLogKeys) {
        const val = await storage.get(key)
        if (val !== undefined) notifyLogs.push(val)
      }

      const backup = {
        version: 2,
        exportedAt: new Date().toISOString(),
        agents,
        defaultAgentId: config.defaultAgentId,
        session: sessionConfig,
        notifications: notifyRules,
        sessions,
        notifyLogs,
        storageDump,
        // apiKey 不导出，防止密钥泄露
      }

      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', 'attachment; filename="weclawbot-backup.json"')
      res.json(backup)
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/api/config/import', dynamicAuth, async (req, res) => {
    try {
      // 旧版备份兼容：补全缺失的必填字段
      const raw = req.body as Record<string, unknown>
      if (raw.agents && Array.isArray(raw.agents)) {
        for (const agent of raw.agents as Record<string, unknown>[]) {
          if (!agent.description) agent.description = agent.name as string || ''
          if (!agent.timeout) agent.timeout = 30000
          if (!agent.type) agent.type = 'http'
          if (!agent.command) agent.command = agent.id as string || ''
        }
      }
      const v = validate(ConfigImportSchema, raw)
      if (!v.ok) { res.status(400).json({ error: `无效的备份文件：${v.error}` }); return }
      const backup = v.data

      // 导入 Agent
      for (const agent of agentRegistry.listAll()) {
        agentRegistry.unregister(agent.id)
      }
      for (const agent of backup.agents!) {
        agentRegistry.register(agent)
      }
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), backup.defaultAgentId || config.defaultAgentId)

      // 导入会话配置
      if (backup.session) {
        await sessionManager.updateConfig(backup.session.maxRounds, backup.session.expireMs)
      }

      // 导入 API Key（可选，使用 bcrypt 哈希存储）
      if (backup.apiKey) {
        await sessionAuth.setPassword(backup.apiKey)
      }

      // v2 新增：导入通知规则
      let notifyCount = 0
      if (backup.notifications && backup.notifications.length > 0) {
        notificationService.replaceAllRules(backup.notifications)
        notifyCount = backup.notifications.length
      }

      // v2 新增：导入全部存储数据（会话、通知日志、上下文令牌等）
      let storageCount = 0
      if (backup.storageDump && Object.keys(backup.storageDump).length > 0) {
        for (const [key, value] of Object.entries(backup.storageDump)) {
          await storage.set(key, value)
          storageCount++
        }
      } else {
        // 兼容 v1 或无 storageDump 的备份：单独恢复 sessions 和 notifyLogs
        if (backup.sessions && backup.sessions.length > 0) {
          for (const session of backup.sessions) {
            const s = session as { userId?: string; agentId?: string }
            if (s.userId && s.agentId) {
              await storage.set(`session:${s.userId}:${s.agentId}`, session)
              storageCount++
            }
          }
        }
        if (backup.notifyLogs && backup.notifyLogs.length > 0) {
          for (const log of backup.notifyLogs) {
            const l = log as { id?: string }
            if (l.id) {
              await storage.set(`notify:log:${l.id}`, log)
              storageCount++
            }
          }
        }
      }

      res.json({
        ok: true,
        agents: backup.agents!.length,
        session: !!backup.session,
        notifications: notifyCount,
        storageKeys: storageCount,
      })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/api/agents', (_req, res) => {
    res.json(agentRegistry.listAll())
  })

  app.post('/api/agents', dynamicAuth, async (req, res) => {
    try {
      const v = validate(AgentConfigSchema, req.body)
      if (!v.ok) { res.status(400).json({ error: v.error }); return }
      agentRegistry.register(v.data)
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId)
      res.status(201).json(v.data)
    } catch (err) {
      const error = err as Error
      res.status(400).json({ error: error.message })
    }
  })

  app.put('/api/agents/:id', dynamicAuth, async (req, res) => {
    try {
      const existing = agentRegistry.get(req.params.id as string)
      if (!existing) {
        res.status(404).json({ error: 'Agent not found' })
        return
      }
      // 将 null 转为 undefined 以便清空可选字段
      const body = { ...req.body }
      for (const [k, v] of Object.entries(body)) {
        if (v === null) (body as Record<string, unknown>)[k] = undefined
      }
      const updated = { ...existing, ...body, id: existing.id }
      agentRegistry.unregister(existing.id)
      agentRegistry.register(updated)
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId)
      res.json(updated)
    } catch (err) {
      const error = err as Error
      res.status(400).json({ error: error.message })
    }
  })

  // Must come before /api/agents/:id to catch empty-ID case
  app.delete('/api/agents/', dynamicAuth, async (req, res) => {
    try {
      const agent = agentRegistry.get('')
      if (!agent) { res.status(404).json({ error: 'No agent with empty ID' }); return }
      agentRegistry.unregister('')
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId)
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.delete('/api/agents/:id', dynamicAuth, async (req, res) => {
    try {
      agentRegistry.unregister(req.params.id as string)
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId)
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
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
      const session = await sessionManager.getOrCreate('admin-test', agentId)
      const response = await agentRegistry.invoke(agentId, {
        message: { text, type: 'text' },
        session: { userId: 'admin-test', agentId, history: session.history },
      })
      // 持久化测试消息
      sessionManager.append('admin-test', agentId, { role: 'user', content: text, timestamp: Date.now() })
      sessionManager.append('admin-test', agentId, { role: 'assistant', content: response.reply.text, timestamp: Date.now() })
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
      const v = validate(NotifyRuleSchema, req.body)
      if (!v.ok) { res.status(400).json({ error: v.error }); return }
      notificationService.addRule(v.data)
      res.status(201).json(v.data)
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

  // ===== 会话管理 API =====
  app.get('/api/sessions', dynamicAuth, async (_req, res) => {
    try {
      const sessions = await sessionManager.listSessions()
      res.json(sessions)
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/api/sessions/detail', dynamicAuth, async (req, res) => {
    try {
      const { userId, agentId } = req.query
      if (!userId || !agentId) {
        res.status(400).json({ error: 'userId and agentId are required' })
        return
      }
      const session = await sessionManager.getSessionDetail(userId as string, agentId as string)
      if (!session) {
        res.status(404).json({ error: 'Session not found' })
        return
      }
      res.json(session)
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.delete('/api/sessions/clear', dynamicAuth, async (req, res) => {
    try {
      const { userId, agentId } = req.body
      if (userId && agentId) {
        // 删除指定会话
        const deleted = await sessionManager.deleteSession(userId, agentId)
        res.json({ ok: true, deleted })
      } else {
        // 清空所有会话
        const count = await sessionManager.clearAllSessions()
        res.json({ ok: true, cleared: count })
      }
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/api/sessions/config', dynamicAuth, async (_req, res) => {
    try {
      const config = await sessionManager.getConfig()
      res.json(config)
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.put('/api/sessions/config', dynamicAuth, async (req, res) => {
    try {
      const v = validate(SessionConfigSchema, req.body)
      if (!v.ok) { res.status(400).json({ error: v.error }); return }
      const { maxRounds, expireMs } = v.data
      const cfg = await sessionManager.updateConfig(maxRounds, expireMs)
      res.json(cfg)
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  return app
}
