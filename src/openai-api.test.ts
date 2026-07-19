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
  const registry = {
    listAll: () => [
      { id: 'hermes', name: 'Hermes', command: 'hermes' },
      { id: 'qwenpaw', name: 'QwenPaw', command: 'qwenpaw' },
    ],
    get: (id: string) => id === 'hermes'
      ? { id, name: 'Hermes', command: 'hermes', type: 'ws-remote' }
      : undefined,
    invoke: async (agentId: string, payload: any) => {
      calls.push({ agentId, payload })
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, calls }
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
          { role: 'system', content: 'Be concise' },
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
    expect(started.calls[0].payload.session.userId).toBe('openai:client-a')
    expect(started.calls[0].payload.message.text).toContain('[System instructions]')
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
