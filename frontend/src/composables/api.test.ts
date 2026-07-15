import { describe, expect, it, vi } from 'vitest'
import { api } from './api'

describe('api.del', () => {
  it('sends a JSON body when supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await api.del('/api/sessions/clear', { agentId: 'agent-a' })

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/clear', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ agentId: 'agent-a' }),
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
    }))
    vi.unstubAllGlobals()
  })
})
