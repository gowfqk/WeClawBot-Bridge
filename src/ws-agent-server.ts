/**
 * WS Agent Server — Bridge 端 WebSocket Server
 *
 * Agent 主动连接 Bridge（而非 Bridge 连接 Agent）：
 *   ws://bridge-host:3000/ws/agent
 *
 * 协议：
 *   1. Agent 连接后发送 {type:'auth', token, agentId, name?, command?}
 *   2. Bridge 验证 token → 回复 {type:'auth_ok', agentId} 或 {type:'auth_fail', reason}
 *   3. Bridge 转发微信消息 → {type:'chat', id, payload}
 *   4. Agent 回复 → {type:'chat', id, text}
 *   5. 双方心跳 → {type:'ping'} / {type:'pong'}
 *   6. Agent 可主动推送 → {type:'push', text, userId?}
 */

import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { AgentPayload, AgentResponse } from './types'
import type { Storage } from './types'
import { createLogger } from './logger'

const log = createLogger('ws-agent-server')

// ===== 消息协议 =====

export interface WsAuthMessage {
  type: 'auth'
  token: string
  agentId: string
  name?: string
  command?: string
  description?: string
  model?: string
}

export interface WsChatMessage {
  type: 'chat'
  id: string
  payload: AgentPayload
}

export interface WsChatReply {
  type: 'chat'
  id: string
  text: string
}

export interface WsPushMessage {
  type: 'push'
  text: string
  userId?: string
}

export interface WsErrorMessage {
  type: 'error'
  id?: string
  reason: string
}

export type WsServerInbound = WsAuthMessage | WsChatReply | WsPushMessage | { type: 'pong' } | { type: 'ping' } | { type: 'typing' }
export type WsServerOutbound = WsChatMessage | WsErrorMessage | { type: 'auth_ok'; agentId: string } | { type: 'auth_fail'; reason: string } | { type: 'ping' } | { type: 'pong' }

// ===== 连接信息 =====

interface ConnectedAgent {
  ws: WebSocket
  agentId: string
  name: string
  command: string
  description: string
  model?: string
  connectedAt: number
  lastActivity: number
  pendingRequests: Map<string, {
    resolve: (response: AgentResponse) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>
}

// ===== WS Agent Server =====

export class WsAgentServer {
  private wss: WebSocketServer | null = null
  private connections: Map<string, ConnectedAgent> = new Map()  // agentId → info
  private agentTokens: Map<string, string> = new Map()          // agentId → token（用于认证）
  private storage: Storage | null = null                         // 持久化存储
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private onAgentConnect?: (agentId: string, info: { name: string; command: string; description: string; model?: string }) => void
  private onAgentDisconnect?: (agentId: string) => void
  private onAgentPush?: (agentId: string, text: string, userId?: string) => void

  constructor(options?: {
    storage?: Storage
    onAgentConnect?: (agentId: string, info: { name: string; command: string; description: string; model?: string }) => void
    onAgentDisconnect?: (agentId: string) => void
    onAgentPush?: (agentId: string, text: string, userId?: string) => void
  }) {
    this.storage = options?.storage ?? null
    this.onAgentConnect = options?.onAgentConnect
    this.onAgentDisconnect = options?.onAgentDisconnect
    this.onAgentPush = options?.onAgentPush
  }

  /** 从 Storage 加载已持久化的 token（启动时调用） */
  async loadPersistedTokens(): Promise<void> {
    if (!this.storage) return
    try {
      const tokens = await this.storage.get<Record<string, string>>('ws-agent-tokens')
      if (tokens && typeof tokens === 'object') {
        for (const [agentId, token] of Object.entries(tokens as Record<string, string>)) {
          this.agentTokens.set(agentId, token)
        }
      }
    } catch {
      // 忽略加载失败
    }
  }

  /** 持久化所有 token 到 Storage */
  private async persistTokens(): Promise<void> {
    if (!this.storage) return
    try {
      const tokens: Record<string, string> = {}
      for (const [agentId, token] of this.agentTokens) {
        tokens[agentId] = token
      }
      await this.storage.set('ws-agent-tokens', tokens)
    } catch {
      // 忽略持久化失败
    }
  }

  /** 挂载到 HTTP server 上 */
  attach(httpServer: Server, path = '/ws/agent'): void {
    this.wss = new WebSocketServer({ server: httpServer, path, maxPayload: 256 * 1024 })

    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress
      log.info({ clientIp }, 'WS Agent 连接接入')

      let authenticated = false
      let agentId: string | null = null

      // 认证超时：10 秒内必须完成 auth
      const authTimer = setTimeout(() => {
        if (!authenticated) {
          this.send(ws, { type: 'auth_fail', reason: '认证超时' })
          ws.close(4001, 'auth timeout')
        }
      }, 10000)

      ws.on('message', (data) => {
        try {
          let msg: WsServerInbound
          try {
            msg = JSON.parse(data.toString())
          } catch {
            this.send(ws, { type: 'error', reason: '无效 JSON' })
            return
          }

          // 未认证：只接受 auth 消息
          if (!authenticated) {
            if (msg.type !== 'auth') {
              this.send(ws, { type: 'auth_fail', reason: '请先发送 auth 消息' })
              ws.close(4003, 'not authenticated')
              return
            }
            const auth = msg as WsAuthMessage
            const result = this.authenticate(auth, ws)
            if (result.ok) {
              authenticated = true
              agentId = auth.agentId
              clearTimeout(authTimer)
            } else {
              this.send(ws, { type: 'auth_fail', reason: result.reason! })
              ws.close(4003, 'auth failed')
            }
            return
          }

          // 已认证：处理消息
          this.handleMessage(agentId!, msg, ws)
        } catch (err) {
          log.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, 'WS Agent 消息处理失败')
          this.send(ws, { type: 'error', reason: '无效消息' })
        }
      })

      ws.on('close', (code, reason) => {
        clearTimeout(authTimer)
        if (agentId) {
          this.removeConnection(agentId, `连接关闭 (${code}: ${reason.toString() || 'no reason'})`, ws)
        }
      })

      ws.on('error', (err) => {
        log.error({ agentId, err: err.message }, 'WS Agent 连接错误')
      })
    })

    // 心跳检测：每 30s 检查不活跃连接
    this.heartbeatInterval = setInterval(() => this.checkHeartbeats(), 30000)

    log.info({ path }, 'WS Agent Server 已挂载')
  }

  /** 获取 Agent token */
  getAgentToken(agentId: string): string | undefined {
    return this.agentTokens.get(agentId)
  }

  /** 设置 Agent 认证 token（由 Bridge 管理面板分配）。Token 轮换会立即撤销旧连接。 */
  setAgentToken(agentId: string, token: string): void {
    const previous = this.agentTokens.get(agentId)
    this.agentTokens.set(agentId, token)
    this.persistTokens()
    if (previous && previous !== token) this.disconnectAgent(agentId, 'Token 已轮换')
  }

  /** 移除 Agent token 并立即断开已认证的旧连接。 */
  removeAgentToken(agentId: string): void {
    this.agentTokens.delete(agentId)
    this.persistTokens()
    this.disconnectAgent(agentId, 'Token 已撤销')
  }

  /** 生成 token 并注册 */
  generateToken(agentId: string): string {
    const token = `wsk_${crypto.randomBytes(32).toString('base64url')}`
    this.setAgentToken(agentId, token)
    return token
  }

  /** 向 Agent 发送聊天请求（Bridge → Agent） */
  async invoke(agentId: string, payload: AgentPayload, timeout = 180000): Promise<AgentResponse> {
    const conn = this.connections.get(agentId)
    if (!conn) {
      return { reply: { text: `WS Agent "${agentId}" 不在线。` } }
    }

    const id = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const msg: WsChatMessage = { type: 'chat', id, payload }

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingRequests.delete(id)
        reject(new Error(`WS Agent 响应超时 (${timeout}ms)`))
      }, timeout)

      conn.pendingRequests.set(id, { resolve, reject, timer })

      try {
        this.send(conn.ws, msg)
        conn.lastActivity = Date.now()
      } catch (err) {
        conn.pendingRequests.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /** 获取在线 Agent 列表 */
  getOnlineAgents(): Array<{
    agentId: string
    name: string
    command: string
    description: string
    model?: string
    connectedAt: number
    lastActivity: number
    pendingCount: number
  }> {
    return Array.from(this.connections.values()).map(conn => ({
      agentId: conn.agentId,
      name: conn.name,
      command: conn.command,
      description: conn.description,
      model: conn.model,
      connectedAt: conn.connectedAt,
      lastActivity: conn.lastActivity,
      pendingCount: conn.pendingRequests.size,
    }))
  }

  /** Agent 是否在线 */
  isOnline(agentId: string): boolean {
    return this.connections.has(agentId)
  }

  /** 关闭 WS Server */
  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    // 关闭所有 Agent 连接
    for (const [agentId, conn] of this.connections) {
      for (const [, pending] of conn.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Server shutting down'))
      }
      conn.pendingRequests.clear()
      try { conn.ws.close(1001, 'server shutdown') } catch {}
    }
    this.connections.clear()
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    log.info('WS Agent Server 已关闭')
  }

  /** 断开指定 Agent，确保 Token 轮换/撤销立即生效。 */
  private disconnectAgent(agentId: string, reason: string): void {
    const conn = this.connections.get(agentId)
    if (!conn) return
    try { conn.ws.close(4003, reason) } catch {}
    this.removeConnection(agentId, reason, conn.ws)
  }

  // ===== 私有方法 =====

  private authenticate(auth: WsAuthMessage, ws: WebSocket): { ok: boolean; reason?: string } {
    const { token, agentId, name, command, description, model } = auth

    if (!agentId || typeof agentId !== 'string' || agentId.length > 128 || !token || typeof token !== 'string') {
      return { ok: false, reason: '认证消息格式无效' }
    }
    const expected = this.agentTokens.get(agentId)
    if (!expected || typeof token !== 'string') {
      return { ok: false, reason: `Agent "${agentId}" 未注册，请先在管理面板创建 WS Agent 并获取 token` }
    }
    const provided = Buffer.from(token)
    const expectedBuffer = Buffer.from(expected)
    if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) {
      return { ok: false, reason: 'Token 验证失败' }
    }

    // 踢掉旧连接（同一 agentId）
    const existing = this.connections.get(agentId)
    if (existing) {
      log.warn({ agentId }, 'WS Agent 重复连接，踢掉旧连接')
      try { existing.ws.close(4008, 'replaced by new connection') } catch {}
      for (const [, pending] of existing.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error('连接被替换'))
      }
      // Delete only before installing the new connection. The old socket's later
      // close event must not remove the replacement connection.
      this.connections.delete(agentId)
    }

    // 注册新连接
    const conn: ConnectedAgent = {
      ws,
      agentId,
      name: name || agentId,
      command: command || agentId,
      description: description || '',
      model,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      pendingRequests: new Map(),
    }
    this.connections.set(agentId, conn)

    this.send(ws, { type: 'auth_ok', agentId })
    log.info({ agentId, name: conn.name }, 'WS Agent 认证成功')

    this.onAgentConnect?.(agentId, {
      name: conn.name,
      command: conn.command,
      description: conn.description,
      model: conn.model,
    })

    return { ok: true }
  }

  private handleMessage(agentId: string, msg: WsServerInbound, ws: WebSocket): void {
    const conn = this.connections.get(agentId)
    if (!conn || conn.ws !== ws) {
      log.warn({ agentId }, '忽略过期 WS 连接消息')
      return
    }

    conn.lastActivity = Date.now()

    switch (msg.type) {
      case 'chat': {
        // Agent 回复聊天
        const reply = msg as WsChatReply
        const pending = conn.pendingRequests.get(reply.id)
        if (pending) {
          clearTimeout(pending.timer)
          conn.pendingRequests.delete(reply.id)
          pending.resolve({ reply: { text: reply.text || '' } })
        } else {
          log.warn({ agentId, id: reply.id }, '收到未知请求 ID 的回复')
        }
        break
      }

      case 'push': {
        // Agent 主动推送消息
        const push = msg as WsPushMessage
        log.info({ agentId, userId: push.userId, text: push.text?.slice(0, 50) }, 'WS Agent 主动推送')
        this.onAgentPush?.(agentId, push.text, push.userId)
        break
      }

      case 'pong': {
        // 心跳响应，已更新 lastActivity
        break
      }

      case 'ping': {
        // 插件主动发送心跳 — 回复 pong 保持连接
        this.send(ws, { type: 'pong' })
        break
      }

      case 'typing': {
        // Agent 正在输入状态（最佳尽力，不报 unknown type）
        break
      }

      default: {
        log.warn({ agentId, type: (msg as {type: string}).type }, 'WS Agent 发送未知消息类型')
      }
    }
  }

  private removeConnection(agentId: string, reason: string, ws?: WebSocket): void {
    const conn = this.connections.get(agentId)
    if (!conn) return
    if (ws && conn.ws !== ws) {
      log.info({ agentId, reason }, '忽略旧 WS 连接关闭事件，当前连接已被替换')
      return
    }

    log.info({ agentId, reason }, 'WS Agent 断开连接')

    // 拒绝所有 pending 请求
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`Agent 断开连接: ${reason}`))
    }

    this.connections.delete(agentId)
    this.onAgentDisconnect?.(agentId)
  }

  private checkHeartbeats(): void {
    const now = Date.now()
    for (const [agentId, conn] of this.connections) {
      // 60s 无活动 → 发 ping
      if (now - conn.lastActivity > 60000) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          try {
            this.send(conn.ws, { type: 'ping' })
          } catch {
            this.removeConnection(agentId, '心跳发送失败')
          }
        }
      }
      // 120s 无活动 → 踢掉
      if (now - conn.lastActivity > 120000) {
        log.warn({ agentId }, 'WS Agent 心跳超时，断开连接')
        try { conn.ws.close(4009, 'heartbeat timeout') } catch {}
        this.removeConnection(agentId, '心跳超时')
      }
    }
  }

  private send(ws: WebSocket, msg: WsServerOutbound): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }
}
