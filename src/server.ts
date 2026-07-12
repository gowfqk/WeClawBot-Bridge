import express from 'express'
import path from 'node:path'
import crypto from 'node:crypto'
import type { BotManager } from './bot-manager'
import type { AgentRegistry } from './agent-registry'
import type { CommandHandler } from './command-handler'
import type { NotificationService } from './notification'
import type { SessionManager } from './session-manager'
import type { AppConfig } from './config'
import type { WsAgentServer } from './ws-agent-server'
import { saveAgents } from './config'
import type { Storage } from './types'
import { API_KEY_STORAGE_KEY } from './types'
import type { Logger } from 'pino'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { loggingMiddleware } from './middleware/logging'
import { SessionAuth } from './middleware/session-auth'
import { csrfOriginMiddleware } from './middleware/csrf'
import { getMetrics, botStatus } from './metrics'
import { SINGLE_USER_ID, normalizeUserId } from './single-user'
import { generateWsToken, resolveWsToken, syncWsAgentToken } from './ws-token'
import {
  LoginSchema, SetupSchema, ChangePasswordSchema,
  AgentConfigSchema, NotifySchema, NotifyRuleSchema,
  SessionConfigSchema, ConfigImportSchema, validate,
} from './schemas'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'

export function createServer(
  config: AppConfig,
  botManager: BotManager,
  agentRegistry: AgentRegistry,
  commandHandler: CommandHandler,
  notificationService: NotificationService,
  storage: Storage,
  sessionManager: SessionManager,
  logger: Logger,
  wsAgentServer?: WsAgentServer,
) {
  const app = express()

  // Only trust forwarding headers when deployment explicitly opts in. Public direct
  // access must not be able to spoof X-Forwarded-For and bypass rate limiting.
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)

  // 自定义 CSP 配置，允许管理界面必要的资源
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://static.cloudflareinsights.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "https://static.cloudflareinsights.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      }
    },
    crossOriginOpenerPolicy: false,  // 隧道/反代场景下放宽
    crossOriginResourcePolicy: false, // 隧道/反代场景下放宽
  }))
  
  // CORS 配置：仅在显式设置 ALLOWED_ORIGINS 时允许跨域
  // 未设置时默认同源策略（origin 不匹配的请求仍可到达，但浏览器会阻止读取响应）
  const corsOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : false  // false = 仅允许同源请求
  app.use(cors({
    origin: corsOrigins,
    credentials: true
  }))
  
  app.use(cookieParser())
  app.use(express.json({ limit: '1mb' }))
  app.use(loggingMiddleware(logger))
  const rateLimiter = rateLimitMiddleware()
  app.use(rateLimiter)

  // CSRF 保护：验证浏览器请求的 Origin/Referer 头
  const allowedOrigins = corsOrigins === false
    ? undefined
    : (corsOrigins as string[]).map(o => o.replace(/\/$/, ''))
  app.use('/api', csrfOriginMiddleware(allowedOrigins))

  app.use(express.static(path.resolve(__dirname, '../public')))

  app.get('/admin', (_req, res) => {
    res.redirect('/')
  })

  // ===== 会话认证系统 =====
  const sessionAuth = new SessionAuth(storage, config.apiKey)

  // 认证中间件：验证 Bearer Token 或 HttpOnly Cookie（会话令牌，非密码）
  const dynamicAuth = async (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> => {
    const passwordSet = await sessionAuth.isPasswordSet()
    if (!passwordSet) {
      // 未设置密码，直接放行
      next()
      return
    }
    // 优先从 HttpOnly Cookie 读取，其次从 Authorization header 读取
    const cookieToken = req.cookies?.[COOKIE_NAME]
    const authHeader = req.headers.authorization
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const token = cookieToken || headerToken

    if (!token) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const result = sessionAuth.validateToken(token)
    if (!result.valid) {
      clearAuthCookie(res)
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
</style>
</head>
<body>
<h1>WeClawBot Bridge</h1>
<p class="sub">微信 ↔ OpenClaw AI Agent 桥接网关</p>
<p style="margin-bottom:16px"><a href="/" style="color:#4f46e5;font-size:14px">打开管理面板</a></p>
<div class="card">
  <h3>Bot 状态</h3>
  <p>在线状态：<span class="badge ${status.loggedIn ? 'online' : 'offline'}">${status.loggedIn ? '在线' : '离线'}</span></p>
</div>
<div class="card">
  <h3>已注册 Agent（${agents.length} 个）</h3>
  <p>请登录管理面板查看详情</p>
</div>
</body>
</html>`)
  })

  // 设置认证 cookie 的辅助函数
  const COOKIE_NAME = 'wcbot_session'
  const setAuthCookie = (res: import('express').Response, token: string, expiresAt: number): void => {
    const maxAge = Math.max(0, expiresAt - Date.now())
    // Tunnel/反向代理场景：原始请求可能是 HTTPS，但 Node 侧是 HTTP
    // 通过 X-Forwarded-Proto 判断真实协议
    const isSecure = res.req?.secure || res.req?.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'none' : 'lax',
      maxAge,
      path: '/',
    })
  }

  const clearAuthCookie = (res: import('express').Response): void => {
    const isSecure = res.req?.secure || res.req?.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'
    res.clearCookie(COOKIE_NAME, { path: '/', secure: isSecure, sameSite: isSecure ? 'none' : 'lax' })
  }

  // ===== 认证 API =====
  app.post('/api/auth/login', rateLimitMiddleware(5, 60_000), async (req, res) => {
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

    setAuthCookie(res, session.token, session.expiresAt)
    res.json({ authenticated: true, expiresAt: session.expiresAt })
  })

  app.get('/api/auth/status', async (req, res) => {
    const cookieToken = req.cookies?.[COOKIE_NAME]
    const authHeader = req.headers.authorization
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const token = cookieToken || headerToken

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

  app.post('/api/auth/setup', rateLimitMiddleware(3, 60_000), async (req, res) => {
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
    setAuthCookie(res, session!.token, session!.expiresAt)
    res.json({ ok: true, expiresAt: session!.expiresAt })
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
    setAuthCookie(res, session!.token, session!.expiresAt)
    res.json({ ok: true, expiresAt: session!.expiresAt })
  })

  app.post('/api/auth/logout', dynamicAuth, (req, res) => {
    const cookieToken = req.cookies?.[COOKIE_NAME]
    const authHeader = req.headers.authorization
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const token = cookieToken || headerToken
    sessionAuth.logout(token)
    clearAuthCookie(res)
    res.json({ ok: true })
  })

  app.get('/api/health', (_req, res) => {
    const wsAgents = wsAgentServer ? wsAgentServer.getOnlineAgents().map(a => ({
      id: a.agentId,
      online: true,
      lastActivity: a.lastActivity,
    })) : []
    res.json({
      status: 'ok',
      bot: botManager.getStatus(),
      wsAgents,
    })
  })

  app.get('/api/metrics', async (_req, res) => {
    res.set('Content-Type', 'text/plain')
    res.send(await getMetrics())
  })

  app.post('/api/bot/login', dynamicAuth, async (_req, res) => {
    try {
      // 强制重新走 QR 流程（跳过旧凭据）
      botManager.login((url) => {
        // qrUrl 回调时无需额外处理，getStatus() 会自动拿到
      }, true).catch((err) => {
        logger.error({ err: (err as Error).message }, 'Background login error')
      })
      // 等一小段时间让 qrUrl 回调触发
      await new Promise((r) => setTimeout(r, 2000))
      const status = botManager.getStatus()
      res.json({ qrUrl: status.qrUrl, status: 'waiting_for_scan' })
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Bot login error')
      res.status(500).json({ error: 'Bot 登录失败，请重试' })
    }
  })

  app.get('/api/bot/status', dynamicAuth, (_req, res) => {
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

      const backup = {
        version: 3,
        exportedAt: new Date().toISOString(),
        // Deliberately retain complete Agent credentials for migration, but exclude
        // conversations, notification logs, and opaque storage records.
        agents,
        defaultAgentId: config.defaultAgentId,
        session: sessionConfig,
        notifications: notifyRules,
        // 管理面板密码、会话记录和运行日志不导出，需重新设置/保留在原实例。
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="weclawbot-config.json"')
      res.send(`${JSON.stringify(backup, null, 2)}\n`)
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
      await saveAgents(agentRegistry.listAll(), backup.defaultAgentId || config.defaultAgentId, storage)

      // 导入会话配置
      if (backup.session) {
        await sessionManager.updateConfig(backup.session.maxRounds, backup.session.expireMs)
      }

      // 恢复管理密码：如果备份中包含 apiKey 明文，通过 bcrypt 重新哈希存储
      if (backup.apiKey) {
        await sessionAuth.setPassword(backup.apiKey)
      }

      // v2 新增：导入通知规则
      let notifyCount = 0
      if (backup.notifications && backup.notifications.length > 0) {
        await notificationService.replaceAllRules(backup.notifications)
        notifyCount = backup.notifications.length
      }

      // v2 新增：导入全部存储数据（会话、通知日志、上下文令牌等）
      // 安全限制：禁止覆盖旧版明文密钥和微信上下文令牌
      const BLOCKED_IMPORT_KEYS = new Set([
        'config:api_key', 'config:default_recipient',
      ])
      const isBlockedKey = (key: string) =>
        BLOCKED_IMPORT_KEYS.has(key) || key.startsWith('context_token:')

      let storageCount = 0
      if (backup.storageDump && Object.keys(backup.storageDump).length > 0) {
        for (const [key, value] of Object.entries(backup.storageDump)) {
          if (isBlockedKey(key)) {
            logger.warn({ key }, 'Import skipped blocked storage key')
            continue
          }
          await storage.set(key, value)
          storageCount++
        }
      } else {
        // 兼容 v1 或无 storageDump 的备份：单独恢复 sessions 和 notifyLogs
        if (backup.sessions && backup.sessions.length > 0) {
          for (const session of backup.sessions) {
            const s = session as { userId?: string; agentId?: string }
            if (s.agentId) {
              await storage.set(`session:${SINGLE_USER_ID}:${s.agentId}`, { ...(session as object), userId: SINGLE_USER_ID, agentId: s.agentId })
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

  app.get('/api/agents', dynamicAuth, (_req, res) => {
    const agents = agentRegistry.listAll()
    res.json(agents)
  })

  app.post('/api/agents', dynamicAuth, async (req, res) => {
    try {
      const v = validate(AgentConfigSchema, req.body)
      if (!v.ok) { res.status(400).json({ error: v.error }); return }
      agentRegistry.register(v.data)
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId, storage)
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
      const v = validate(AgentConfigSchema, updated)
      if (!v.ok) { res.status(400).json({ error: v.error }); return }
      agentRegistry.unregister(existing.id)
      agentRegistry.register(v.data)
      if (wsAgentServer) syncWsAgentToken(v.data, wsAgentServer)
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId, storage)
      res.json(v.data)
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
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId, storage)
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.delete('/api/agents/:id', dynamicAuth, async (req, res) => {
    try {
      const agentId = req.params.id as string
      const existing = agentRegistry.get(agentId)
      agentRegistry.unregister(agentId)
      if (wsAgentServer && existing?.type === 'ws-remote') wsAgentServer.removeAgentToken(agentId)
      commandHandler.updateAgents(agentRegistry.listAll())
      await saveAgents(agentRegistry.listAll(), config.defaultAgentId, storage)
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
      // 测试使用隔离的空会话：不能读取或清除真实单用户会话历史。
      const response = await agentRegistry.invoke(agentId, {
        message: { text, type: 'text' },
        session: { userId: SINGLE_USER_ID, agentId, history: [] },
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

  // ===== WS Agent 状态 API =====
  app.get('/api/ws-agents', dynamicAuth, (_req, res) => {
    if (!wsAgentServer) {
      res.json({ agents: [], message: 'WS Agent Server 未启用' })
      return
    }
    const agents = wsAgentServer.getOnlineAgents()
    res.json({ agents, count: agents.length })
  })

  app.post('/api/ws-agents/:id/token', dynamicAuth, (req, res) => {
    if (!wsAgentServer) {
      res.status(503).json({ error: 'WS Agent Server 未启用' })
      return
    }
    const agentId = req.params.id as string
    generateWsToken(
      agentId,
      wsAgentServer,
      agentRegistry,
      () => saveAgents(agentRegistry.listAll(), config.defaultAgentId, storage),
    ).then(token => res.json({ agentId, token })).catch(err => {
      logger.error({ agentId, err: (err as Error).message }, '保存 WS Agent Token 失败')
      res.status(500).json({ error: 'Token 保存失败' })
    })
  })

  // 查看已有 Token（不重新生成）
  app.get('/api/ws-agents/:id/token', dynamicAuth, (req, res) => {
    if (!wsAgentServer) {
      res.status(503).json({ error: 'WS Agent Server 未启用' })
      return
    }
    const agentId = req.params.id as string
    const token = resolveWsToken(agentId, wsAgentServer, agentRegistry)
    if (token) {
      res.json({ agentId, token })
    } else {
      res.status(404).json({ error: 'Token 不存在，请先生成' })
    }
  })

  app.post('/api/notify', dynamicAuth, async (req, res) => {
    try {
      const v = validate(NotifySchema, req.body)
      if (!v.ok) { res.status(400).json({ error: v.error }); return }
      await notificationService.send(v.data.userId, v.data.content)
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/api/notify/rules', dynamicAuth, async (req, res) => {
    try {
      const v = validate(NotifyRuleSchema, req.body)
      if (!v.ok) { res.status(400).json({ error: v.error }); return }
      await notificationService.addRule(v.data)
      res.status(201).json(v.data)
    } catch (err) {
      const error = err as Error
      res.status(400).json({ error: error.message })
    }
  })

  app.delete('/api/notify/rules/:id', dynamicAuth, async (req, res) => {
    try {
      await notificationService.removeRule(req.params.id as string)
      res.json({ ok: true })
    } catch (err) {
      const error = err as Error
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/api/notify/log', dynamicAuth, async (_req, res) => {
    const logs = await notificationService.getNotificationLogs()
    res.json(logs)
  })

  // ===== Webhook 认证 =====
  // 支持两种方式：
  // 1. Bearer Token（与管理面板相同的会话认证）
  // 2. X-Webhook-Secret（专用的 Webhook 密钥，适合 CI/CD 等外部调用）
  const webhookSecret = process.env.WEBHOOK_SECRET
  const webhookAuth = async (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> => {
    // 如果配置了 WEBHOOK_SECRET，则要求验证（使用时序安全比较防止计时攻击）
    if (webhookSecret) {
      const provided = req.headers['x-webhook-secret'] as string | undefined
      if (!provided) {
        res.status(401).json({ error: 'Invalid webhook secret' })
        return
      }
      const a = Buffer.from(provided, 'utf-8')
      const b = Buffer.from(webhookSecret, 'utf-8')
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'Invalid webhook secret' })
        return
      }
      next()
      return
    }
    // 未配置 WEBHOOK_SECRET 时，回退到 Bearer Token 认证
    await dynamicAuth(req, res, next)
  }

  app.post('/api/webhook', webhookAuth, async (req, res) => {
    try {
      const { userId, text, content } = req.body
      const sendContent = content || { text: text || 'empty' }
      await notificationService.send(userId, sendContent)
      res.json({ ok: true, recipient: userId || SINGLE_USER_ID })
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
      if (!agentId) {
        res.status(400).json({ error: 'agentId is required' })
        return
      }
      const session = await sessionManager.getSessionDetail(normalizeUserId(userId as string | undefined), agentId as string)
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
      if (agentId) {
        // 单用户设计：删除指定 Agent 的会话，忽略外部传入 userId。
        const deleted = await sessionManager.deleteSession(normalizeUserId(userId), agentId)
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

  // SPA fallback: 所有非 API、非静态文件路由返回 index.html
  // 必须放在所有 API 路由之后，否则会拦截后续注册的路由
  app.get('*', (_req, res, next) => {
    // 仅对非 API 路径且 Accept HTML 的请求返回 SPA 入口
    if (_req.path.startsWith('/api') || !_req.accepts('html')) {
      next()
      return
    }
    res.sendFile(path.resolve(__dirname, '../public/index.html'))
  })

  // 挂载清理函数，供 shutdown 时调用
  ;(app as unknown as Record<string, unknown>).destroy = (): void => {
    rateLimiter.destroy()
  }

  return app
}
