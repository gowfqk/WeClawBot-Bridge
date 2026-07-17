import type { CommandResult, AgentConfig } from './types'

interface AgentInfo {
  id: string
  name: string
  command: string
  description: string
}

export class CommandHandler {
  private agentCommands: Map<string, AgentInfo> = new Map()
  private agents: AgentInfo[] = []

  updateAgents(agents: AgentConfig[]): void {
    this.agentCommands.clear()
    this.agents = agents.map((a) => ({
      id: a.id,
      name: a.name,
      command: a.command,
      description: a.description,
    }))
    for (const agent of this.agents) {
      const normalized = agent.command.toLowerCase()
      if (this.agentCommands.has(normalized)) {
        continue
      }
      this.agentCommands.set(normalized, agent)
    }
  }

  parse(text: string): CommandResult {
    const trimmed = text.trim()

    if (trimmed === '#help' || trimmed === '#h') {
      return { type: 'help' }
    }

    if (trimmed === '#agents' || trimmed === '#a') {
      return { type: 'agents' }
    }

    if (trimmed === '#status') {
      return { type: 'status' }
    }

    if (trimmed === '#clear') {
      return { type: 'clear' }
    }

    if (trimmed.startsWith('#')) {
      const command = trimmed.slice(1).toLowerCase()

      if (command === 'help' || command === 'h') {
        return { type: 'help' }
      }

      if (command === 'agents' || command === 'a') {
        return { type: 'agents' }
      }

      if (command === 'status') {
        return { type: 'status' }
      }

      const agent = this.agentCommands.get(command)
      if (agent) {
        return { type: 'switch', targetAgentId: agent.id }
      }

      return { type: 'unknown' }
    }

    return { type: 'message' }
  }

  getHelpMessage(): string {
    const lines: string[] = []

    lines.push('══ WeClawBot Bridge ══')
    lines.push('')
    lines.push('**📋 系统命令**')
    lines.push('  `#help` / `#h` — 显示此帮助')
    lines.push('  `#status` — 查看 Bot 在线状态')
    lines.push('  `#agents` / `#a` — 列出所有 Agent')
    lines.push('  `#clear` — 清空当前对话历史')
    lines.push('  `#{名称}` — 切换到指定 Agent')
    lines.push('')
    lines.push('切换 Agent 后直接发消息即可对话')

    return lines.join('\n')
  }

  getAgentsMessage(): string {
    const lines: string[] = []

    if (this.agents.length === 0) {
      return '当前没有可用的 Agent。'
    }

    lines.push('**📡 可用 Agent**')
    lines.push('')
    for (const agent of this.agents) {
      lines.push(`  **#${agent.command}** — ${agent.name}`)
      if (agent.description) {
        lines.push(`  _${agent.description}_`)
      }
    }
    lines.push('')
    lines.push('发送 `#名称` 即可切换')

    return lines.join('\n')
  }

  getStatusMessage(loggedIn: boolean, accountId?: string): string {
    if (!loggedIn) {
      return '🔴 **Bot 离线**'
    }
    return `🟢 **Bot 在线**\n📱 \`${accountId || '未知'}\``
  }
}
