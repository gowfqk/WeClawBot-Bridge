import http from 'node:http'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStorage } from './storage'
import { createServer } from './server'

describe('initial management authentication', () => {
  let server: http.Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  })

  it('does not expose management APIs before a password is initialized', async () => {
    const storage = new MemoryStorage()
    const app = createServer(
      {
        port: 0,
        storageDir: '',
        encryptionKey: '',
        apiKey: '',
        logLevel: 'silent',
        agents: [],
        defaultAgentId: undefined,
        sessionMaxRounds: 0,
        sessionExpireMs: 0,
      },
      { getStatus: () => ({ loggedIn: false, polling: false }) } as any,
      { listAll: () => [] } as any,
      {} as any,
      {} as any,
      storage,
      {} as any,
      pino({ enabled: false }),
    )
    server = http.createServer(app)
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not listen')

    const response = await fetch(`http://127.0.0.1:${address.port}/api/agents`)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'INITIAL_SETUP_REQUIRED' })
  })
})
