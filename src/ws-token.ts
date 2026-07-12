import type { AgentConfig } from './types'

interface TokenRegistry {
  getAgentToken(agentId: string): string | undefined
  setAgentToken(agentId: string, token: string): void
  removeAgentToken(agentId: string): void
  generateToken(agentId: string): string
}

interface AgentStore {
  get(agentId: string): AgentConfig | undefined
  register(agent: AgentConfig): void
}

/** Read the WS token, recovering it from persisted ws-remote Agent config when needed. */
export function resolveWsToken(
  agentId: string,
  wsAgentServer: TokenRegistry,
  agentRegistry: AgentStore,
): string | undefined {
  const existing = wsAgentServer.getAgentToken(agentId)
  if (existing) return existing

  const agent = agentRegistry.get(agentId)
  const persisted = agent?.type === 'ws-remote' && typeof agent.apiKey === 'string' && agent.apiKey.length > 0
    ? agent.apiKey
    : undefined
  if (persisted) wsAgentServer.setAgentToken(agentId, persisted)
  return persisted
}

/** Synchronize a manually edited Agent Token with the WS authentication registry. */
export function syncWsAgentToken(agent: AgentConfig, wsAgentServer: TokenRegistry): void {
  if (agent.type !== 'ws-remote') {
    wsAgentServer.removeAgentToken(agent.id)
    return
  }
  if (agent.apiKey) {
    wsAgentServer.setAgentToken(agent.id, agent.apiKey)
  } else {
    wsAgentServer.removeAgentToken(agent.id)
  }
}

/** Generate a WS token and store it with the Agent configuration for restart/deploy recovery. */
export async function generateWsToken(
  agentId: string,
  wsAgentServer: TokenRegistry,
  agentRegistry: AgentStore,
  save: () => Promise<void>,
): Promise<string> {
  const token = wsAgentServer.generateToken(agentId)
  const agent = agentRegistry.get(agentId)
  if (agent?.type === 'ws-remote') {
    agentRegistry.register({ ...agent, apiKey: token })
    await save()
  }
  return token
}
