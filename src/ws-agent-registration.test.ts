import { describe, expect, it } from 'vitest'
import type { AgentConfig } from './types'
import { buildWsRemoteAgentConfig, type WsAgentConnectInfo } from './ws-agent-registration'

const connectInfo = (overrides: Partial<WsAgentConnectInfo> = {}): WsAgentConnectInfo => ({
  name: 'QwenPaw',
  command: 'qwenpaw',
  description: 'QwenPaw Channel Plugin',
  ...overrides,
})

const panelAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'qwenpaw-a',
  name: 'QwenPaw A',
  command: 'qa',
  type: 'ws-remote',
  description: '第一台 QwenPaw',
  timeout: 120000,
  ...overrides,
})

describe('buildWsRemoteAgentConfig', () => {
  it('keeps the panel-configured name/command/description when the Agent already exists', () => {
    const result = buildWsRemoteAgentConfig('qwenpaw-a', connectInfo(), panelAgent())

    // The handshake defaults ("QwenPaw"/"qwenpaw") must NOT override panel config.
    expect(result.name).toBe('QwenPaw A')
    expect(result.command).toBe('qa')
    expect(result.description).toBe('第一台 QwenPaw')
    expect(result.timeout).toBe(120000)
    expect(result.type).toBe('ws-remote')
  })

  it('does not let two instances collide on the same command', () => {
    // Two QwenPaw servers connect using the same handshake default command,
    // but each is configured as a distinct panel Agent with its own command.
    const a = buildWsRemoteAgentConfig('qwenpaw-a', connectInfo(), panelAgent({ id: 'qwenpaw-a', command: 'qa' }))
    const b = buildWsRemoteAgentConfig('qwenpaw-b', connectInfo(), panelAgent({ id: 'qwenpaw-b', command: 'qb', name: 'QwenPaw B' }))

    expect(a.command).toBe('qa')
    expect(b.command).toBe('qb')
    expect(a.command).not.toBe(b.command)
  })

  it('seeds fields from the handshake for a brand-new dynamic Agent', () => {
    const result = buildWsRemoteAgentConfig('qwenpaw', connectInfo(), undefined)

    expect(result.name).toBe('QwenPaw')
    expect(result.command).toBe('qwenpaw')
    expect(result.description).toBe('QwenPaw Channel Plugin')
    expect(result.timeout).toBe(60000)
    expect(result.type).toBe('ws-remote')
  })

  it('falls back to the agentId when a new Agent sends empty identity fields', () => {
    const result = buildWsRemoteAgentConfig(
      'qwenpaw-b',
      connectInfo({ name: '', command: '', description: '' }),
      undefined,
    )

    expect(result.name).toBe('qwenpaw-b')
    expect(result.command).toBe('qwenpaw-b')
    expect(result.description).toBe('WebSocket 远程 Agent (qwenpaw-b)')
  })

  it('preserves the panel model over the handshake model', () => {
    const withModel = buildWsRemoteAgentConfig(
      'qwenpaw-a',
      connectInfo({ model: 'handshake-model' }),
      panelAgent({ model: 'panel-model' }),
    )
    expect(withModel.model).toBe('panel-model')

    const newAgent = buildWsRemoteAgentConfig('qwenpaw', connectInfo({ model: 'handshake-model' }), undefined)
    expect(newAgent.model).toBe('handshake-model')
  })
})
