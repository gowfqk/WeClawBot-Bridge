/**
 * WebSocket Agent 通道 — 持久连接接入 AI 后端
 *
 * 特性：
 * - 持久 WebSocket 连接，避免每次 HTTP 握手
 * - 自动重连（指数退避）
 * - 心跳保活
 * - 断线消息排队，重连后重发
 * - 连接健康状态检测
 * - 支持 OpenAI 兼容协议（JSON 消息）
 */

import WebSocket from 'ws'
import type { AgentConfig, AgentPayload, AgentResponse } from './types'
import { createLogger } from './logger'

const log = createLogger('ws-agent')

/** WS 消息协议 — 请求 */
interface WsRequest {
  type: 'chat' | 'ping'
  id: string              // 请求 ID，用于匹配响应
  payload?: AgentPayload  // chat 请求携带 payload
}

/** WS 消息协议 — 响应 */
interface WsResponse {
  type: 'chat' | 'pong' | 'error'
  id: string              // 对应请求 ID
  text?: string           // chat 响应文本
  error?: string          // 错误信息
}

/** 待处理的请求（等待响应的 Promise） */
interface PendingRequest {
  resolve: (response: AgentResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  payload: AgentPayload   // 断线重连后重发
}

export class WsAgentChannel {
  private ws: WebSocket | null = null
  private agentId: string
  private url: string
  private reconnectInterval: number
  private heartbeatInterval: number
  private maxReconnectAttempts: number
  private headers: Record<string, string>

  private connected = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = false

  private pending: Map<string, PendingRequest> = new Map()
  private messageQueue: AgentPayload[] = []  // 断线时排队
  private requestCounter = 0

  private onStatusChange?: (agentId: string, status: WsChannelStatus) => void

  constructor(
    agent: AgentConfig,
    onStatusChange?: (agentId: string, status: WsChannelStatus) => void,
  ) {
    this.agentId = agent.id
    this.url = agent.wsUrl || agent.endpoint || ''
    this.reconnectInterval = agent.wsReconnectInterval || 3000
    this.heartbeatInterval = agent.wsHeartbeatInterval || 30000
    this.maxReconnectAttempts = agent.wsMaxReconnectAttempts || Infinity
    this.onStatusChange = onStatusChange

    this.headers = { ...(agent.headers || {}) }
    if (agent.apiKey) {
      this.headers['Authorization'] = `Bearer ${agent.apiKey}`
    }
  }

  /** 连接状态 */
  get status(): WsChannelStatus {
    if (this.connected) return 'connected'
    if (this.reconnectAttempts > 0) return 'reconnecting'
    return 'disconnected'
  }

  /** 启动连接 */
  connect(): void {
    this.shouldReconnect = true
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    log.info({ agentId: this.agentId, url: this.url }, 'WS 通道连接中...')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, {
        headers: this.headers,
      })
      this.ws = ws
    } catch (err) {
      log.error({ agentId: this.agentId, err }, 'WS 连接创建失败')
      this.scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      if (this.ws !== ws) return
      this.connected = true
      this.reconnectAttempts = 0
      log.info({ agentId: this.agentId }, 'WS 通道已连接')
      this.emitStatus('connected')
      this.startHeartbeat()
      this.flushQueue()
    })

    this.ws.on('message', (data: WebSocket.Data) => {
      if (this.ws !== ws) return
      this.handleMessage(data)
    })

    this.ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      this.ws = null
      this.onDisconnect(`连接关闭 (${code}: ${reason.toString() || 'no reason'})`)
    })

    this.ws.on('error', (err) => {
      log.error({ agentId: this.agentId, err: err.message }, 'WS 连接错误')
      // error 事件后通常会紧跟 close 事件，不需要额外处理
    })

    this.ws.on('ping', () => {
      this.ws?.pong()
    })
  }

  /** 发送消息并等待响应 */
  async invoke(payload: AgentPayload, timeout = 60000): Promise<AgentResponse> {
    if (!this.connected) {
      // 断线时：排队等待重连
      if (this.messageQueue.length < 100) {
        this.messageQueue.push(payload)
        log.warn({ agentId: this.agentId, queueSize: this.messageQueue.length }, 'WS 断线，消息排队')
      }
      return { reply: { text: 'Agent 连接中断，消息已排队，重连后自动发送。' } }
    }

    const id = `${this.agentId}-${++this.requestCounter}-${Date.now()}`
    const request: WsRequest = { type: 'chat', id, payload }

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`WS 请求超时 (${timeout}ms)`))
      }, timeout)

      this.pending.set(id, { resolve, reject, timer, payload })

      try {
        this.ws!.send(JSON.stringify(request))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /** 主动断开 */
  disconnect(): void {
    this.shouldReconnect = false
    this.cleanup()
    if (this.ws) {
      try { this.ws.close(1000, 'client disconnect') } catch {}
      this.ws = null
    }
    this.connected = false
    this.emitStatus('disconnected')
  }

  /** 处理收到的消息 */
  private handleMessage(data: WebSocket.Data): void {
    let msg: WsResponse
    try {
      msg = JSON.parse(data.toString())
    } catch {
      log.warn({ agentId: this.agentId, raw: data.toString().slice(0, 200) }, 'WS 收到非 JSON 消息')
      return
    }

    if (msg.type === 'pong') {
      // 心跳响应，无需处理
      return
    }

    if (msg.type === 'error') {
      log.error({ agentId: this.agentId, id: msg.id, error: msg.error }, 'WS 收到错误响应')
      const pending = msg.id ? this.pending.get(msg.id) : undefined
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(msg.id)
        pending.resolve({ reply: { text: `Agent 错误：${msg.error || '未知错误'}` } })
      }
      return
    }

    if (msg.type === 'chat' && msg.id) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(msg.id)
        const text = msg.text || ''
        pending.resolve({ reply: { text } })
      } else {
        log.warn({ agentId: this.agentId, id: msg.id }, 'WS 收到未知请求 ID 的响应')
      }
      return
    }

    // 服务端主动推送的消息（无 id 或 id 不匹配）
    if (msg.text) {
      log.info({ agentId: this.agentId, text: msg.text?.slice(0, 100) }, 'WS 收到推送消息')
    }
  }

  /** 断线处理 */
  private onDisconnect(reason: string): void {
    const wasConnected = this.connected
    this.connected = false
    this.stopHeartbeat()

    if (wasConnected) {
      log.warn({ agentId: this.agentId, reason }, 'WS 通道断开')
    }

    if (!this.shouldReconnect) {
      this.emitStatus('disconnected')
      return
    }
    this.emitStatus('reconnecting')
    this.scheduleReconnect()
  }

  /** 安排重连（指数退避） */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error({ agentId: this.agentId, attempts: this.reconnectAttempts }, 'WS 达到最大重连次数，停止重连')
      this.emitStatus('failed')
      return
    }

    if (this.reconnectTimer) return

    this.reconnectAttempts++
    // 指数退避：3s, 6s, 12s, 24s... 最大 60s
    const delay = Math.min(
      this.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
      60000,
    )

    log.info({ agentId: this.agentId, attempt: this.reconnectAttempts, delay }, 'WS 安排重连')

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** 心跳保活 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          const ping: WsRequest = { type: 'ping', id: `ping-${Date.now()}` }
          this.ws.send(JSON.stringify(ping))
        } catch {
          this.stopHeartbeat()
        }
      }
    }, this.heartbeatInterval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 重连后发送排队的消息 */
  private flushQueue(): void {
    if (this.messageQueue.length === 0) return

    log.info({ agentId: this.agentId, count: this.messageQueue.length }, 'WS 重连后发送排队消息')
    const queue = [...this.messageQueue]
    this.messageQueue = []

    for (const payload of queue) {
      this.invoke(payload).catch((err) => {
        log.error({ agentId: this.agentId, err: err.message }, 'WS 排队消息发送失败')
      })
    }
  }

  private cleanup(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // 拒绝所有 pending 请求
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('连接断开'))
    }
    this.pending.clear()
  }

  private emitStatus(status: WsChannelStatus): void {
    this.onStatusChange?.(this.agentId, status)
  }
}

export type WsChannelStatus = 'connected' | 'disconnected' | 'reconnecting' | 'failed'
