import { describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from './types'
import { generateWsToken, resolveWsToken } from './ws-token'

const wsRemoteAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: '2022',
  name: 'Agent 2022',
  command: '2022',
  type: 'ws-remote',
  description: '',
  timeout: 60000,
  ...overrides,
})

describe('WS Agent token persistence', () => {
  it('falls back to the persisted Agent apiKey and restores the WS token registry', () => {
    const wsAgentServer = {
      getAgentToken: vi.fn(() => undefined),
      setAgentToken: vi.fn(),
      generateToken: vi.fn(),
    }
    const agentRegistry = {
      get: vi.fn(() => wsRemoteAgent({ apiKey: 'wsk_2022_saved' })),
      register: vi.fn(),
    }

    expect(resolveWsToken('2022', wsAgentServer, agentRegistry)).toBe('wsk_2022_saved')
    expect(wsAgentServer.setAgentToken).toHaveBeenCalledWith('2022', 'wsk_2022_saved')
  })

  it('stores a newly generated token in the Agent configuration', async () => {
    const wsAgentServer = {
      getAgentToken: vi.fn(),
      setAgentToken: vi.fn(),
      generateToken: vi.fn(() => 'wsk_2022_new'),
    }
    const agentRegistry = {
      get: vi.fn(() => wsRemoteAgent()),
      register: vi.fn(),
    }
    const save = vi.fn(async () => undefined)

    await expect(generateWsToken('2022', wsAgentServer, agentRegistry, save)).resolves.toBe('wsk_2022_new')
    expect(agentRegistry.register).toHaveBeenCalledWith(expect.objectContaining({ id: '2022', apiKey: 'wsk_2022_new' }))
    expect(save).toHaveBeenCalledOnce()
  })
})
