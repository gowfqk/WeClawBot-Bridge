import type { AgentConfig, AgentPayload, AgentResponse } from './types'
import { CliAgentAdapter } from './cli-agent'
import { WsAgentChannel, type WsChannelStatus } from './ws-agent-channel'
import type { WsAgentServer } from './ws-agent-server'
import { createLogger } from './logger'

const log = createLogger('agent-registry')

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map()
  private commandIndex: Map<string, string> = new Map()
  private cliAdapter: CliAgentAdapter
  private wsChannels: Map<string, WsAgentChannel> = new Map()
  private wsAgentServer: WsAgentServer | null = null
  private defaultFallbackText: string

  constructor(defaultFallbackText?: string) {
    this.defaultFallbackText = defaultFallbackText || '服务繁忙，请稍后再试。'
    this.cliAdapter = new CliAgentAdapter()
  }

  /** 注入 WS Agent Server（由 index.ts 调用） */
  setWsAgentServer(server: WsAgentServer): void {
    this.wsAgentServer = server
  }

  register(config: AgentConfig): void {
    const previous = this.agents.get(config.id)
    if (previous) {
      const oldCommand = previous.command.toLowerCase()
      if (this.commandIndex.get(oldCommand) === config.id) this.commandIndex.delete(oldCommand)
    }
    const command = config.command.toLowerCase()
    const existingId = this.commandIndex.get(command)
    if (existingId && existingId !== config.id) {
      throw new Error(`切换命令 "${config.command}" 已被 Agent "${existingId}" 使用`)
    }
    this.agents.set(config.id, { ...config })
    this.commandIndex.set(command, config.id)
    // WS 类型：自动建立持久连接
    if (config.type === 'ws') {
      this.connectWs(config)
    }
  }

  unregister(id: string): void {
    const agent = this.agents.get(id)
    if (agent) {
      this.commandIndex.delete(agent.command.toLowerCase())
      if (agent.type === 'cli') {
        this.cliAdapter.closeSession(id)
      }
      if (agent.type === 'ws') {
        this.disconnectWs(id)
      }
      this.agents.delete(id)
    }
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id)
  }

  findByCommand(command: string): AgentConfig | undefined {
    const id = this.commandIndex.get(command.toLowerCase())
    if (!id) return undefined
    return this.agents.get(id)
  }

  listAll(): AgentConfig[] {
    return Array.from(this.agents.values())
  }

  async invoke(agentId: string, payload: AgentPayload): Promise<AgentResponse> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      return { reply: { text: `Agent "${agentId}" 未找到。` } }
    }

    if (agent.type === 'cli') {
      return this.cliAdapter.invoke(agent, payload)
    }

    if (agent.type === 'ws') {
      return this.invokeWs(agentId, payload)
    }

    if (agent.type === 'ws-remote') {
      return this.invokeWsRemote(agentId, payload)
    }

    return this.invokeHttp(agent, payload)
  }

  private buildOpenAIMessages(
    agent: AgentConfig,
    payload: AgentPayload,
  ): Array<{ role: string; content: string | OpenAIContentPart[] }> {
    const messages: Array<{ role: string; content: string | OpenAIContentPart[] }> = []

    for (const entry of payload.session.history) {
      messages.push({ role: entry.role, content: entry.content })
    }

    const { text, media, type } = payload.message
    const isImage = type === 'image' || type?.startsWith('image')

    if (media && isImage) {
      const mime = type === 'image' ? 'image/jpeg' : `image/${type.replace('image/', '')}`
      const b64 = media.toString('base64')
      const parts: OpenAIContentPart[] = [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'auto' } },
      ]
      if (text) parts.push({ type: 'text', text })
      messages.push({ role: 'user', content: parts })
    } else {
      messages.push({ role: 'user', content: text || '' })
    }

    return messages
  }

  private buildRequestBody(agent: AgentConfig, payload: AgentPayload): Record<string, unknown> {
    if (agent.format === 'qwenpaw') {
      return this.buildQwenPawRequest(agent, payload)
    }

    if (agent.format === 'openai') {
      const messages = this.buildOpenAIMessages(agent, payload)
      const body: Record<string, unknown> = {
        messages,
        stream: agent.streaming === true,
      }
      if (agent.model) body.model = agent.model
      return body
    }

    return {
      message: {
        text: payload.message.text,
        type: payload.message.type,
        media: payload.message.media ? payload.message.media.toString('base64') : null,
      },
      session: {
        userId: payload.session.userId,
        agentId: payload.session.agentId,
        history: payload.session.history,
      },
      model: agent.model,
    }
  }

  /** Build QwenPaw AgentRequest */
  private buildQwenPawRequest(agent: AgentConfig, payload: AgentPayload): Record<string, unknown> {
    const input: Array<Record<string, unknown>> = []

    // History messages
    for (const entry of payload.session.history) {
      input.push({
        type: 'message',
        role: entry.role,
        content: [{ type: 'text', text: entry.content }],
        status: 'completed',
      })
    }

    // Current message
    const { text, media, type } = payload.message
    const isImage = type === 'image' || type?.startsWith('image')
    if (media && isImage) {
      const mime = type === 'image' ? 'jpeg' : type.replace('image/', '')
      const b64 = media.toString('base64')
      const contentBlocks: Array<Record<string, unknown>> = [
        { type: 'image', image: `data:image/${mime};base64,${b64}` },
      ]
      if (text) contentBlocks.push({ type: 'text', text })
      input.push({ type: 'message', role: 'user', content: contentBlocks, status: 'completed' })
    } else {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: text || '' }],
        status: 'completed',
      })
    }

    const body: Record<string, unknown> = {
      input,
      session_id: payload.session.userId,
      user_id: payload.session.userId,
      stream: agent.streaming === true,
    }

    if (agent.model) body.model = agent.model
    // QwenPaw expects api_key in the request body; keep Authorization header too for compatibility.
    if (agent.apiKey) body.api_key = agent.apiKey
    return body
  }

  /** Extract text from QwenPaw response */
  private extractQwenPawText(data: Record<string, unknown>): string | null {
    const output = data.output as Array<Record<string, unknown>> | undefined
    if (!output || output.length === 0) return null

    const lastMsg = output[output.length - 1]
    const content = lastMsg?.content as Array<Record<string, unknown>> | undefined
    if (!content || content.length === 0) return null

    const parts: string[] = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    return parts.length > 0 ? parts.join('') : null
  }

  /** 处理单行 QwenPaw SSE data，返回 'completed' 表示应提前返回 */
  private processQwenPawSSELine(
    dataPayload: string,
    parts: string[],
    lastErrorRef: { value: string | null },
  ): 'completed' | 'continue' {
    if (dataPayload === '[DONE]') return 'continue'
    try {
      const parsed = JSON.parse(dataPayload) as Record<string, unknown>

      // 处理失败事件
      if (parsed.status === 'failed') {
        const err = parsed.error as Record<string, unknown> | undefined
        if (err?.message && typeof err.message === 'string') {
          lastErrorRef.value = err.message as string
        }
        return 'continue'
      }

      // 处理完成事件：从 output 提取完整文本
      if (parsed.status === 'completed' && parsed.output) {
        const outputText = this.extractQwenPawText(parsed)
        if (outputText) {
          parts.length = 0
          parts.push(outputText)
          return 'completed'
        }
      }

      // 处理流式增量：顶层 content 数组
      const content = parsed.content as Array<Record<string, unknown>> | undefined
      if (content) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text)
          }
        }
      }
    } catch {
      // skip non-JSON
    }
    return 'continue'
  }

  /** Parse QwenPaw SSE stream
   *  QwenPaw 始终返回 SSE，事件格式：
   *  - status:"created" / "in_progress" → 开始/进行中
   *  - 流式增量：顶层 content 数组 [{type:"text",text:"..."}]
   *  - status:"completed" → output 数组包含完整消息
   *  - status:"failed" → error 对象 {code, message}
   *  - type:"turn_usage" → 用量统计
   */
  private async readQwenPawSSE(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''

    const decoder = new TextDecoder()
    const parts: string[] = []
    const lastErrorRef = { value: null as string | null }
    let lineBuffer = '' // 缓冲跨 chunk 的不完整行

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split('\n')
        // 最后一段可能不完整，留到下次拼接
        lineBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const dataPayload = trimmed.slice(5).trim()
          if (this.processQwenPawSSELine(dataPayload, parts, lastErrorRef) === 'completed') {
            return parts.join('')
          }
        }
      }

      // 处理缓冲区中剩余的最后一行（无尾换行的场景）
      const tailTrimmed = lineBuffer.trim()
      if (tailTrimmed.startsWith('data:')) {
        const dataPayload = tailTrimmed.slice(5).trim()
        if (this.processQwenPawSSELine(dataPayload, parts, lastErrorRef) === 'completed') {
          return parts.join('')
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 流式增量有内容则返回
    if (parts.length > 0) return parts.join('')

    // 返回服务端错误信息
    if (lastErrorRef.value) return `Agent 错误：${lastErrorRef.value}`

    return ''
  }

  private resolveEndpoint(agent: AgentConfig): string {
    let url = agent.endpoint || ''
    if (agent.format === 'qwenpaw') {
      if (!url.endsWith('/api/console/chat')) {
        url = url.replace(/\/+$/, '') + '/api/console/chat'
      }
    } else if (agent.format === 'openai') {
      if (!url.endsWith('/chat/completions')) {
        url = url.replace(/\/+$/, '') + '/chat/completions'
      }
    }
    return url
  }

  private async invokeHttp(agent: AgentConfig, payload: AgentPayload): Promise<AgentResponse> {
    if (!agent.endpoint) {
      return { reply: { text: 'Agent 未配置端点地址。' } }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), agent.timeout || 30000)

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(agent.headers || {}),
      }

      if (agent.apiKey) {
        headers['Authorization'] = `Bearer ${agent.apiKey}`
      }

      const body = this.buildRequestBody(agent, payload)
      const url = this.resolveEndpoint(agent)

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        log.error({ agentId: agent.id, status: response.status, body: errText.slice(0, 200) }, 'Agent HTTP error')
        const s = response.status
        let msg: string
        if (s === 401 || s === 403) {
          msg = `Agent 认证失败（${s}），请检查 API Key 配置。`
        } else if (s === 404) {
          msg = `Agent 端点地址无效（404），请在管理面板检查端点 URL 配置。`
        } else if (s === 429) {
          msg = `Agent 请求频率超限（429），请稍后再试。`
        } else if (s >= 400 && s < 500) {
          msg = `Agent 请求错误（${s}），请检查 Agent 配置。`
        } else {
          msg = `Agent 服务暂时不可用（${s}），请稍后再试。`
        }
        return { reply: { text: msg } }
      }

      if (agent.streaming && agent.format === 'openai') {
        const text = await this.readSSEStream(response)
        return text ? { reply: { text } } : { reply: { text: this.defaultFallbackText } }
      }

      if (agent.format === 'qwenpaw') {
        // QwenPaw 始终返回 SSE 格式（无论 stream 设置如何）
        const result = await this.readQwenPawSSE(response)
        return result ? { reply: { text: result } } : { reply: { text: this.defaultFallbackText } }
      }

      const data = (await response.json()) as Record<string, unknown>

      const text = agent.responsePath
        ? this.extractByPath(data, agent.responsePath)
        : this.extractResponseText(data)

      return text ? { reply: { text } } : { reply: { text: this.defaultFallbackText } }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name === 'AbortError') {
        return { reply: { text: `Agent 响应超时（>${Math.round((agent.timeout || 30000) / 1000)}s），请稍后再试。` } }
      }
      log.error({ agentId: agent.id, err: error.message }, 'Agent unexpected error')
      return { reply: { text: 'Agent 调用失败，请稍后再试或联系管理员。' } }
    } finally {
      clearTimeout(timeout)
    }
  }

  /** 处理单行 OpenAI SSE data */
  private processOpenAISSELine(dataPayload: string): string {
    if (dataPayload === '[DONE]') return ''
    try {
      const parsed = JSON.parse(dataPayload) as Record<string, unknown>
      const choices = parsed.choices as Array<Record<string, unknown>> | undefined
      if (choices?.[0]) {
        const delta = choices[0].delta as Record<string, unknown> | undefined
        if (typeof delta?.content === 'string') {
          return delta.content
        }
      }
    } catch {
      // skip non-JSON
    }
    return ''
  }

  private async readSSEStream(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''

    const decoder = new TextDecoder()
    let accumulated = ''
    let lineBuffer = '' // 缓冲跨 chunk 的不完整行

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          accumulated += this.processOpenAISSELine(trimmed.slice(5).trim())
        }
      }
      // 处理缓冲区中剩余的最后一行
      const tailTrimmed = lineBuffer.trim()
      if (tailTrimmed.startsWith('data:')) {
        accumulated += this.processOpenAISSELine(tailTrimmed.slice(5).trim())
      }
    } finally {
      reader.releaseLock()
    }

    return accumulated
  }

  private extractByPath(data: Record<string, unknown>, path: string): string | null {
    const keys = path.split('.')
    let current: unknown = data
    for (const key of keys) {
      if (current == null || typeof current !== 'object') return null
      current = (current as Record<string, unknown>)[key]
    }
    return typeof current === 'string' ? current : null
  }

  private extractResponseText(data: Record<string, unknown>): string | null {
    if (data.reply && typeof (data.reply as Record<string, unknown>).text === 'string') {
      return (data.reply as Record<string, unknown>).text as string
    }

    const choices = data.choices as Array<Record<string, unknown>> | undefined
    if (choices && choices.length > 0) {
      const message = choices[0].message as Record<string, unknown> | undefined
      if (message && typeof message.content === 'string') {
        return message.content
      }
      if (typeof choices[0].text === 'string') {
        return choices[0].text as string
      }
    }

    if (typeof data.text === 'string') return data.text
    if (typeof data.content === 'string') return data.content
    if (typeof data.response === 'string') return data.response

    return null
  }

  closeAllCliSessions(): void {
    this.cliAdapter.closeAll()
  }

  /** WS 通道：建立持久连接 */
  private connectWs(agent: AgentConfig): void {
    if (this.wsChannels.has(agent.id)) {
      this.wsChannels.get(agent.id)!.disconnect()
    }
    const channel = new WsAgentChannel(agent, (id, status) => {
      if (status === 'connected') {
        log.info({ agentId: id }, 'WS 通道已连接')
      } else if (status === 'failed') {
        log.error({ agentId: id }, 'WS 通道连接失败，已停止重连')
      }
    })
    this.wsChannels.set(agent.id, channel)
    channel.connect()
  }

  /** WS 通道：断开连接 */
  private disconnectWs(agentId: string): void {
    const channel = this.wsChannels.get(agentId)
    if (channel) {
      channel.disconnect()
      this.wsChannels.delete(agentId)
    }
  }

  /** WS 通道：调用 Agent */
  private async invokeWs(agentId: string, payload: AgentPayload): Promise<AgentResponse> {
    const channel = this.wsChannels.get(agentId)
    if (!channel) {
      return { reply: { text: 'WS Agent 通道未初始化。' } }
    }

    if (channel.status !== 'connected') {
      return { reply: { text: 'Agent 连接中断，正在重连，消息已排队。' } }
    }

    try {
      return await channel.invoke(payload)
    } catch (err) {
      const error = err as Error
      if (error.message.includes('超时')) {
        return { reply: { text: `Agent 响应超时，请稍后再试。` } }
      }
      log.error({ agentId, err: error.message }, 'WS Agent 调用失败')
      return { reply: { text: 'Agent 调用失败，请稍后再试。' } }
    }
  }

  /** WS-Remote 通道：通过 WsAgentServer 路由到远程 Agent */
  private async invokeWsRemote(agentId: string, payload: AgentPayload): Promise<AgentResponse> {
    if (!this.wsAgentServer) {
      return { reply: { text: 'WS Agent Server 未初始化。' } }
    }

    if (!this.wsAgentServer.isOnline(agentId)) {
      return { reply: { text: `Agent "${agentId}" 不在线，请稍后再试。` } }
    }

    try {
      const agent = this.agents.get(agentId)
      return await this.wsAgentServer.invoke(agentId, payload, agent?.timeout || 60000)
    } catch (err) {
      const error = err as Error
      if (error.message.includes('超时')) {
        return { reply: { text: 'Agent 响应超时，请稍后再试。' } }
      }
      log.error({ agentId, err: error.message }, 'WS-Remote Agent 调用失败')
      return { reply: { text: 'Agent 调用失败，请稍后再试。' } }
    }
  }

  /** 获取所有 WS 通道状态 */
  getWsStatus(): Record<string, WsChannelStatus> {
    const status: Record<string, WsChannelStatus> = {}
    for (const [id, channel] of this.wsChannels) {
      status[id] = channel.status
    }
    return status
  }
}
