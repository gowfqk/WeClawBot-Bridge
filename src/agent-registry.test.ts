import { describe, expect, it } from 'vitest'
import { AgentRegistry } from './agent-registry'
import type { AgentConfig } from './types'

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'a1',
  name: 'Agent',
  command: 'old',
  type: 'http',
  description: '',
  timeout: 30000,
  ...overrides,
})

describe('AgentRegistry command index', () => {
  it('removes a replaced Agent command mapping', () => {
    const registry = new AgentRegistry()
    registry.register(agent())
    registry.register(agent({ command: 'new' }))

    expect(registry.findByCommand('old')).toBeUndefined()
    expect(registry.findByCommand('new')?.id).toBe('a1')
  })

  it('rejects duplicate commands from different Agents', () => {
    const registry = new AgentRegistry()
    registry.register(agent())
    expect(() => registry.register(agent({ id: 'a2', command: 'old' }))).toThrow('已被 Agent')
  })
})
