import http from 'node:http'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStorage } from './storage'
import { createServer } from './server'

const config = {
  port: 0,
  storageDir: '',
  encryptionKey: '',
  apiKey: 'test-api-key',
  logLevel: 'silent' as const,
  agents: [],
  defaultAgentId: undefined,
  sessionMaxRounds: 0,
  sessionExpireMs: 0,
}

async function startServer() {
  const calls: Array<{ agentId: string; payload: any }> = []
  let availabilityError: { status: 503; code: string; message: string } | null = null
  let responseError: { status: 429 | 502 | 503 | 504; code: string; message: string } | undefined
  const registry = {
    listAll: () => [
      { id: 'hermes', name: 'Hermes', command: 'hermes' },
      { id: 'qwenpaw', name: 'QwenPaw', command: 'qwenpaw' },
    ],
    get: (id: string) => id === 'hermes'
      ? { id, name: 'Hermes', command: 'hermes', type: 'ws-remote' }
      : undefined,
    getAvailabilityError: () => availabilityError,
    invoke: async (agentId: string, payload: any) => {
      calls.push({ agentId, payload })
      if (responseError) return { reply: { text: responseError.message }, error: responseError }
      return { reply: { text: `reply from ${agentId}` } }
    },
  }
  const app = createServer(
    config,
    { getStatus: () => ({ loggedIn: false, polling: false }) } as any,
    registry as any,
    {} as any,
    {} as any,
    new MemoryStorage(),
    {} as any,
    pino({ enabled: false }),
  )
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not listen')
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    setAvailabilityError: (error: typeof availabilityError) => { availabilityError = error },
    setResponseError: (error: typeof responseError) => { responseError = error },
  }
}

describe('OpenAI-compatible API', () => {
  let server: http.Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    server = undefined
  })

  it('lists registered Agent IDs as models', async () => {
    const started = await startServer()
    server = started.server
    const response = await fetch(`${started.baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer test-api-key' },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      object: 'list',
      data: expect.arrayContaining([expect.objectContaining({ id: 'hermes', object: 'model' })]),
    })
  })

  it('routes model to the matching Agent and returns an OpenAI response', async () => {
    const started = await startServer()
    server = started.server
    const response = await fetch(`${started.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes',
        user: 'client-a',
        messages: [
          { role: 'assistant', content: 'Previous answer' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      object: 'chat.completion',
      model: 'hermes',
      choices: [{ message: { role: 'assistant', content: 'reply from hermes' }, finish_reason: 'stop' }],
    })
    expect(started.calls).toHaveLength(1)
    expect(started.calls[0].agentId).toBe('hermes')
    expect(started.calls[0].payload.session.userId).toMatch(/^openai:[A-Za-z0-9_-]{43}$/)
    expect(started.calls[0].payload.session.userId).not.toContain('client-a')
    expect(started.calls[0].payload.message.text).toBe('Hello')
  })

  it('returns an OpenAI-shaped 404 for an unknown model', async () => {
    const started = await startServer()
    server = started.server
    const response = await fetch(`${started.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'missing', messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'model_not_found' } })
  })

  it('rejects malformed messages and unsupported system/developer roles', async () => {
    const started = await startServer()
    server = started.server
    const headers = { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' }

    const malformed = await fetch(`${started.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'hermes', messages: [null, { role: 'user', content: 'Hello' }] }),
    })
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: 'invalid_messages' } })

    const system = await fetch(`${started.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'hermes', messages: [{ role: 'system', content: 'Secret rule' }, { role: 'user', content: 'Hello' }] }),
    })
    expect(system.status).toBe(400)
    await expect(system.json()).resolves.toMatchObject({ error: { code: 'unsupported_role' } })
  })

  it('returns OpenAI errors when the selected Agent is unavailable or fails', async () => {
    const started = await startServer()
    server = started.server
    const headers = { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' }
    const body = JSON.stringify({ model: 'hermes', messages: [{ role: 'user', content: 'Hello' }] })

    started.setAvailabilityError({ status: 503, code: 'agent_unavailable', message: 'Agent "hermes" is offline.' })
    const unavailable = await fetch(`${started.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body })
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({ error: { type: 'server_error', code: 'agent_unavailable' } })

    started.setAvailabilityError(null)
    started.setResponseError({ status: 504, code: 'upstream_timeout', message: 'Agent timed out.' })
    const timeout = await fetch(`${started.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body })
    expect(timeout.status).toBe(504)
    await expect(timeout.json()).resolves.toMatchObject({ error: { type: 'server_error', code: 'upstream_timeout' } })
  })

  it('emits valid OpenAI SSE framing for stream requests', async () => {
    const started = await startServer()
    server = started.server
    const response = await fetch(`${started.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'hermes', stream: true, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('"chat.completion.chunk"')
    expect(text).toContain('reply from hermes')
    expect(text).toContain('data: [DONE]')
  })
})
