/**
 * WeClawBot Agent Plugin SDK
 *
 * 让 AI Agent 主动连接 WeClawBot-Bridge，无需起 HTTP 服务。
 *
 * 用法：
 *   import { WeClawBotAgent } from 'weclawbot-agent-plugin'
 *
 *   const agent = new WeClawBotAgent({
 *     bridgeUrl: 'ws://bridge-host:3000/ws/agent',
 *     agentId: 'my-claude',
 *     token: 'wsk_xxx',
 *     name: 'Claude Agent',
 *     command: 'claude',
 *   })
 *
 *   agent.onMessage(async (msg) => {
 *     const reply = await myAI.process(msg.text, msg.history)
 *     return { text: reply }
 *   })
 *
 *   agent.connect()
 */

import WebSocket from 'ws'

// ===== 类型 =====

export interface AgentPluginConfig {
  /** Bridge WS 端点，如 ws://host:3000/ws/agent 或 wss://... */
  bridgeUrl: string
  /** Agent ID（需与 Bridge 管理面板注册的 ID 一致） */
  agentId: string
  /** 认证 Token（Bridge 管理面板生成） */
  token: string
  /** Agent 显示名称 */
  name?: string
  /** 切换命令（微信中输入此命令切换到该 Agent） */
  command?: string
  /** Agent 描述 */
  description?: string
  /** 模型名称 */
  model?: string
  /** 自动重连间隔 ms（默认 3000） */
  reconnectInterval?: number
  /** 心跳间隔 ms（默认 25000） */
  heartbeatInterval?: number
  /** 最大重连次数（默认 Infinity） */
  maxReconnectAttempts?: number
  /** AI 后端配置（可选：设置后自动转发消息，无需 onMessage handler） */
  aiBackend?: {
    /** API 端点 URL（OpenAI 格式会自动补全 /chat/completions） */
    url: string
    /** API Key（通过 Authorization: Bearer 发送） */
    apiKey?: string
    /** 请求格式：openai（默认）| qwenpaw | native */
    format?: 'openai' | 'qwenpaw' | 'native'
    /** 模型名称 */
    model?: string
    /** 请求超时 ms（默认 60000） */
    timeout?: number
    /** 额外的请求头 */
    headers?: Record<string, string>
    /** System prompt（仅 openai 格式生效） */
    systemPrompt?: string
    /** 最大历史消息数（默认 50） */
    maxHistory?: number
  }
}

export interface IncomingMessage {
  /** 消息 ID，回复时需携带 */
  id: string
  /** 用户消息文本 */
  text: string
  /** 消息类型 */
  type: string
  /** 用户 ID */
  userId: string
  /** Agent ID */
  agentId: string
  /** 会话历史 */
  history: Array<{ role: string; content: string }>
  /** 原始 media（base64） */
  media?: string | null
}

export interface OutgoingReply {
  /** 回复文本 */
  text: string
}

export type MessageHandler = (msg: IncomingMessage) => Promise<OutgoingReply> | OutgoingReply

export type AgentStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

// ===== 内部协议 =====

interface AuthMessage {
  type: 'auth'
  token: string
  agentId: string
  name?: string
  command?: string
  description?: string
  model?: string
}

interface ChatReplyMessage {
  type: 'chat'
  id: string
  text: string
}

interface ServerChatMessage {
  type: 'chat'
  id: string
  payload: {
    message: { text: string; type: string; media?: string | null }
    session: { userId: string; agentId: string; history: Array<{ role: string; content: string }> }
  }
}

interface ServerMessage {
  type: string
  id?: string
  agentId?: string
  reason?: string
  payload?: ServerChatMessage['payload']
}

// ===== SDK =====

export class WeClawBotAgent {
  private config: Required<Pick<AgentPluginConfig, 'bridgeUrl' | 'agentId' | 'token'>> & AgentPluginConfig
  private ws: WebSocket | null = null
  private messageHandler: MessageHandler | null = null
  private status: AgentStatus = 'disconnected'
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private onStatusChange?: (status: AgentStatus) => void

  constructor(config: AgentPluginConfig, onStatusChange?: (status: AgentStatus) => void) {
    this.config = config
    this.onStatusChange = onStatusChange
  }

  /** 注册消息处理函数 */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  /** 连接到 Bridge */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    this.setStatus('connecting')
    console.log(`[WeClawBot] 连接 ${this.config.bridgeUrl} ...`)

    try {
      this.ws = new WebSocket(this.config.bridgeUrl)
    } catch (err) {
      console.error('[WeClawBot] 连接创建失败:', err)
      this.scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      // 发送认证
      const auth: AuthMessage = {
        type: 'auth',
        token: this.config.token,
        agentId: this.config.agentId,
        name: this.config.name,
        command: this.config.command,
        description: this.config.description,
        model: this.config.model,
      }
      this.ws!.send(JSON.stringify(auth))
    })

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data)
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.onDisconnect(`连接关闭 (${code}: ${reason.toString() || 'no reason'})`)
    })

    this.ws.on('error', (err: Error) => {
      console.error('[WeClawBot] 连接错误:', err.message)
    })

    this.ws.on('ping', () => {
      this.ws?.pong()
    })
  }

  /** 主动推送消息给 Bridge（如主动通知微信用户） */
  push(text: string, userId?: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[WeClawBot] 未连接，无法推送')
      return
    }
    this.ws.send(JSON.stringify({ type: 'push', text, userId }))
  }

  /** 断开连接 */
  disconnect(): void {
    this.cleanup()
    if (this.ws) {
      try { this.ws.close(1000, 'client disconnect') } catch {}
      this.ws = null
    }
    this.setStatus('disconnected')
  }

  /** 当前状态 */
  getStatus(): AgentStatus {
    return this.status
  }

  // ===== 内部方法 =====

  private handleMessage(data: WebSocket.Data): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(data.toString())
    } catch {
      console.warn('[WeClawBot] 收到非 JSON 消息')
      return
    }

    switch (msg.type) {
      case 'auth_ok': {
        this.reconnectAttempts = 0
        this.setStatus('connected')
        this.startHeartbeat()
        console.log(`[WeClawBot] ✅ 认证成功，Agent "${msg.agentId || this.config.agentId}" 已上线`)
        break
      }

      case 'auth_fail': {
        console.error(`[WeClawBot] ❌ 认证失败: ${msg.reason}，稍后重连`)
        this.cleanup()
        this.ws?.close(4003, 'auth failed')
        this.setStatus('reconnecting')
        this.scheduleReconnect()
        break
      }

      case 'chat': {
        this.handleChat(msg as unknown as ServerChatMessage)
        break
      }

      case 'ping': {
        // 回复 pong
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'pong' }))
        }
        break
      }

      case 'error': {
        console.error(`[WeClawBot] 服务端错误: ${msg.reason}`)
        break
      }

      default: {
        console.warn(`[WeClawBot] 未知消息类型: ${msg.type}`)
      }
    }
  }

  private async handleChat(msg: ServerChatMessage): Promise<void> {
    const incoming: IncomingMessage = {
      id: msg.id,
      text: msg.payload.message.text,
      type: msg.payload.message.type,
      userId: msg.payload.session.userId,
      agentId: msg.payload.session.agentId,
      history: msg.payload.session.history,
      media: msg.payload.message.media,
    }

    // Priority 1: custom handler
    if (this.messageHandler) {
      try {
        const reply = await this.messageHandler(incoming)
        this.sendReply(msg.id, reply.text)
      } catch (err) {
        console.error('[WeClawBot] 消息处理失败:', err)
        this.sendReply(msg.id, '处理消息时出错，请稍后再试。')
      }
      return
    }

    // Priority 2: built-in AI backend
    if (this.config.aiBackend) {
      try {
        const text = await this.callAiBackend(incoming)
        this.sendReply(msg.id, text)
      } catch (err) {
        console.error('[WeClawBot] AI 后端调用失败:', err)
        this.sendReply(msg.id, `AI 后端错误：${(err as Error).message}`)
      }
      return
    }

    // No handler configured
    console.warn('[WeClawBot] 收到聊天消息但未注册 handler 且未配置 AI 后端')
    this.sendReply(msg.id, 'Agent 未就绪，请配置 onMessage handler 或 aiBackend 选项。')
  }

  private sendReply(id: string, text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[WeClawBot] 未连接，无法回复')
      return
    }
    const reply: ChatReplyMessage = { type: 'chat', id, text }
    this.ws.send(JSON.stringify(reply))
  }

  /** 内置 AI 后端调用（无需自定义 onMessage handler） */
  private async callAiBackend(msg: IncomingMessage): Promise<string> {
    const backend = this.config.aiBackend!
    const format = backend.format || 'openai'

    let body: Record<string, unknown>
    let apiPath = backend.url

    if (format === 'openai') {
      const messages: Array<{ role: string; content: string }> = []
      if (backend.systemPrompt) {
        messages.push({ role: 'system', content: backend.systemPrompt })
      }
      const maxHistory = backend.maxHistory ?? 50
      const history = msg.history.slice(-maxHistory)
      for (const h of history) {
        messages.push({ role: h.role, content: h.content })
      }
      messages.push({ role: 'user', content: msg.text })
      body = { messages, stream: false }
      if (backend.model) body.model = backend.model
      if (!apiPath.endsWith('/chat/completions')) {
        apiPath = apiPath.replace(/\/+$/, '') + '/chat/completions'
      }
    } else if (format === 'qwenpaw') {
      const input: Array<Record<string, unknown>> = []
      for (const h of msg.history) {
        input.push({
          type: 'message',
          role: h.role,
          content: [{ type: 'text', text: h.content }],
          status: 'completed',
        })
      }
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: msg.text }],
        status: 'completed',
      })
      body = {
        input,
        session_id: msg.userId,
        user_id: msg.userId,
        stream: false,
      }
      if (backend.model) body.model = backend.model
      if (backend.apiKey) body.api_key = backend.apiKey
      if (!apiPath.endsWith('/api/console/chat')) {
        apiPath = apiPath.replace(/\/+$/, '') + '/api/console/chat'
      }
    } else {
      // native format
      body = {
        message: { text: msg.text, type: msg.type, media: msg.media ?? null },
        session: {
          userId: msg.userId,
          agentId: msg.agentId,
          history: msg.history,
        },
      }
      if (backend.model) body.model = backend.model
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(backend.headers || {}),
    }
    if (backend.apiKey && format !== 'qwenpaw') {
      headers['Authorization'] = `Bearer ${backend.apiKey}`
    }
    // QwenPaw: api_key 在 body 中（上方已设置），header 也同时发送以兼容

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), backend.timeout ?? 60000)

    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}${errText ? ': ' + errText.slice(0, 200) : ''}`)
      }

      const data = (await response.json()) as Record<string, unknown>

      if (format === 'openai') {
        const choices = data.choices as Array<Record<string, unknown>> | undefined
        const content = choices?.[0]?.message as Record<string, unknown> | undefined
        return (content?.content as string) || ''
      }

      if (format === 'qwenpaw') {
        const output = data.output as Array<Record<string, unknown>> | undefined
        if (output && output.length > 0) {
          const lastMsg = output[output.length - 1]
          const content = lastMsg.content as Array<Record<string, unknown>> | undefined
          if (content) {
            return content
              .filter((c) => c.type === 'text')
              .map((c) => c.text as string)
              .join('')
          }
        }
        return ''
      }

      // native / fallback
      if (data.reply && typeof (data.reply as Record<string, unknown>).text === 'string') {
        return (data.reply as Record<string, unknown>).text as string
      }
      return (data.text as string) || (data.content as string) || (data.response as string) || ''
    } finally {
      clearTimeout(timeout)
    }
  }

  private onDisconnect(reason: string): void {
    const wasConnected = this.status === 'connected'
    this.cleanup()
    this.setStatus('reconnecting')

    if (wasConnected) {
      console.warn(`[WeClawBot] 连接断开: ${reason}`)
    }

    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    // 无限重连：不设上限
    if (this.reconnectTimer) return

    this.reconnectAttempts++
    const baseInterval = this.config.reconnectInterval ?? 3000
    // 指数退避：3s → 6s → 12s → ... → 最多 60s
    const delay = Math.min(baseInterval * Math.pow(2, this.reconnectAttempts - 1), 60000)

    console.log(`[WeClawBot] ${delay / 1000}s 后重连 (第 ${this.reconnectAttempts} 次)...`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const interval = this.config.heartbeatInterval ?? 25000
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'pong' }))  // 主动保活
      }
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private cleanup(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setStatus(status: AgentStatus): void {
    this.status = status
    this.onStatusChange?.(status)
  }
}
