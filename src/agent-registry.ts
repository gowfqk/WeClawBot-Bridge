import type { AgentConfig, AgentPayload, AgentResponse } from './types'
import { CliAgentAdapter } from './cli-agent'

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map()
  private commandIndex: Map<string, string> = new Map()
  private cliAdapter: CliAgentAdapter
  private defaultFallbackText: string

  constructor(defaultFallbackText?: string) {
    this.defaultFallbackText = defaultFallbackText || '服务繁忙，请稍后再试。'
    this.cliAdapter = new CliAgentAdapter()
  }

  register(config: AgentConfig): void {
    this.agents.set(config.id, { ...config })
    this.commandIndex.set(config.command.toLowerCase(), config.id)
  }

  unregister(id: string): void {
    const agent = this.agents.get(id)
    if (agent) {
      this.commandIndex.delete(agent.command.toLowerCase())
      if (agent.type === 'cli') {
        this.cliAdapter.closeSession(id)
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

  /** Parse QwenPaw SSE stream */
  private async readQwenPawSSE(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''

    const decoder = new TextDecoder()
    const parts: string[] = []

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const dataPayload = trimmed.slice(5).trim()
          try {
            const parsed = JSON.parse(dataPayload) as Record<string, unknown>
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
        }
      }
    } finally {
      reader.releaseLock()
    }

    return parts.join('')
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
        console.error(`Agent "${agent.id}" HTTP ${response.status}: ${errText.slice(0, 200)}`)
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
        const text = await this.readQwenPawSSE(response)
        return text ? { reply: { text } } : { reply: { text: this.defaultFallbackText } }
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
      console.error(`Agent "${agent.id}" unexpected error:`, error.message)
      return { reply: { text: `Agent 调用失败：${error.message}` } }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readSSEStream(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''

    const decoder = new TextDecoder()
    let accumulated = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') break
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>
            const choices = parsed.choices as Array<Record<string, unknown>> | undefined
            if (choices?.[0]) {
              const delta = choices[0].delta as Record<string, unknown> | undefined
              if (typeof delta?.content === 'string') {
                accumulated += delta.content
              }
            }
          } catch {
            // skip non-JSON
          }
        }
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
}
