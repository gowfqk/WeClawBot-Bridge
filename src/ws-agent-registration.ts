import type { AgentConfig } from './types'

/** Connection-time metadata an Agent reports in its `auth` handshake. */
export interface WsAgentConnectInfo {
  name: string
  command: string
  description: string
  model?: string
}

/**
 * Build the ws-remote {@link AgentConfig} to register when an Agent connects.
 *
 * Panel/stored configuration is authoritative: for an Agent that already
 * exists in the registry, the connection handshake never overwrites its
 * `name` / `command` / `description` / `model`. Handshake values only seed
 * those fields for a brand-new Agent connecting for the first time (dynamic
 * registration).
 *
 * This prevents multiple instances that were each configured with distinct
 * commands in the panel from colliding: a reconnecting client can no longer
 * reset another instance's `command` back to its own default.
 */
export function buildWsRemoteAgentConfig(
  agentId: string,
  info: WsAgentConnectInfo,
  existing?: AgentConfig,
): AgentConfig {
  return {
    ...existing,
    id: agentId,
    name: existing?.name || info.name || agentId,
    command: existing?.command || info.command || agentId,
    type: 'ws-remote',
    description:
      existing?.description || info.description || `WebSocket 远程 Agent (${info.name || agentId})`,
    timeout: existing?.timeout ?? 60000,
    model: existing?.model ?? info.model,
  }
}
