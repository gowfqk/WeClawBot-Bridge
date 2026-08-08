import http from 'node:http'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  const sendCalls: Array<{ userId?: string; content: any }> = []
  const notificationService = {
    send: vi.fn(async (userId: string | undefined, content: any) => {
      sendCalls.push({ userId, content })
    }),
    listRules: () => [],
  }

  const app = createServer(
    config,
    { getStatus: () => ({ loggedIn: false, polling: false }) } as any,
    { listAll: () => [] } as any,
    {} as any,
    notificationService as any,
    new MemoryStorage(),
    {} as any,
    pino({ enabled: false }),
  )
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not listen')
  const baseUrl = `http://127.0.0.1:${address.port}`

  // dynamicAuth requires a real login session token, not the raw API key
  // accepted by openAiAuth — log in first to obtain a session cookie.
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-api-key' }),
  })
  const setCookie = loginRes.headers.get('set-cookie')
  if (!setCookie) throw new Error('login did not set a session cookie')
  const cookie = setCookie.split(';')[0]

  return { server, baseUrl, sendCalls, cookie }
}

describe('POST /api/notify/send-file', () => {
  let server: http.Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    server = undefined
  })

  it('forwards the uploaded file as SendContent to the notification service', async () => {
    const started = await startServer()
    server = started.server

    const fileBytes = new Uint8Array([1, 2, 3, 4])
    const formData = new FormData()
    formData.append('file', new Blob([fileBytes], { type: 'image/png' }), 'photo.png')
    formData.append('caption', 'hello')

    const response = await fetch(`${started.baseUrl}/api/notify/send-file`, {
      method: 'POST',
      headers: { Cookie: started.cookie },
      body: formData,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })

    expect(started.sendCalls).toHaveLength(1)
    const [{ userId, content }] = started.sendCalls
    expect(userId).toBeUndefined()
    expect(content.caption).toBe('hello')
    expect(content.file.fileName).toBe('photo.png')
    expect(Buffer.from(content.file.data)).toEqual(Buffer.from(fileBytes))
  })

  it('rejects requests without a file', async () => {
    const started = await startServer()
    server = started.server

    const formData = new FormData()
    formData.append('caption', 'no file here')

    const response = await fetch(`${started.baseUrl}/api/notify/send-file`, {
      method: 'POST',
      headers: { Cookie: started.cookie },
      body: formData,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('请选择') })
    expect(started.sendCalls).toHaveLength(0)
  })

  it('rejects files larger than the configured limit', async () => {
    const started = await startServer()
    server = started.server

    const oversized = new Uint8Array(21 * 1024 * 1024) // > 20MB limit
    const formData = new FormData()
    formData.append('file', new Blob([oversized]), 'big.bin')

    const response = await fetch(`${started.baseUrl}/api/notify/send-file`, {
      method: 'POST',
      headers: { Cookie: started.cookie },
      body: formData,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('过大') })
    expect(started.sendCalls).toHaveLength(0)
  })

  it('rejects requests without an authenticated session', async () => {
    const started = await startServer()
    server = started.server

    const formData = new FormData()
    formData.append('file', new Blob([new Uint8Array([1])]), 'a.bin')

    const response = await fetch(`${started.baseUrl}/api/notify/send-file`, {
      method: 'POST',
      body: formData,
    })

    expect(response.status).toBe(401)
    expect(started.sendCalls).toHaveLength(0)
  })
})
