import type { AgentConfig, AgentPayload, AgentResponse } from './types'
import { CliAgentAdapter } from './cli-agent'

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

  private buildRequestBody(agent: AgentConfig, payload: AgentPayload): Record<string, unknown> {
    if (agent.format === 'openai') {
      const messages: Array<{ role: string; content: string }> = []

      for (const entry of payload.session.history) {
        messages.push({ role: entry.role, content: entry.content })
      }

      messages.push({ role: 'user', content: payload.message.text })

      const body: Record<string, unknown> = {
        messages,
        stream: false,
      }
      if (agent.model) body.model = agent.model
      return body
    }

    return {
      message: {
        text: payload.message.text,
        type: payload.message.type,
        media: payload.message.media
          ? payload.message.media.toString('base64')
          : null,
      },
      session: {
        userId: payload.session.userId,
        agentId: payload.session.agentId,
        history: payload.session.history,
      },
      model: agent.model,
    }
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

      const response = await fetch(agent.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        console.error(`Agent "${agent.id}" HTTP ${response.status}: ${errText.slice(0, 200)}`)
        return { reply: { text: this.defaultFallbackText } }
      }

      const data = await response.json() as Record<string, unknown>

      const text = this.extractResponseText(data)

      return text ? { reply: { text } } : { reply: { text: this.defaultFallbackText } }
    } catch (err: unknown) {
      const error = err as Error
      if (error.name === 'AbortError') {
        return { reply: { text: '服务繁忙，请稍后再试。' } }
      }
      return { reply: { text: this.defaultFallbackText } }
    } finally {
      clearTimeout(timeout)
    }
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
