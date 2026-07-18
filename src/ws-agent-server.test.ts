import http from 'node:http'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { WsAgentServer } from './ws-agent-server'

describe('WsAgentServer error replies', () => {
  let httpServer: http.Server | undefined
  let client: WebSocket | undefined
  let server: WsAgentServer | undefined

  afterEach(async () => {
    client?.close()
    server?.close()
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve())
  })

  it('rejects a pending request when an agent reports a correlated error', async () => {
    httpServer = http.createServer()
    server = new WsAgentServer()
    server.setAgentToken('agent-1', 'test-token')
    server.attach(httpServer)
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('test server did not listen')

    client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/agent`)
    await new Promise<void>((resolve, reject) => {
      client!.once('error', reject)
      client!.once('open', () => client!.send(JSON.stringify({
        type: 'auth', agentId: 'agent-1', token: 'test-token',
      })))
      client!.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; id?: string }
        if (message.type === 'auth_ok') resolve()
      })
    })

    client.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; id?: string }
      if (message.type === 'chat' && message.id) {
        client!.send(JSON.stringify({ type: 'error', id: message.id, reason: 'unsupported media' }))
      }
    })

    await expect(server.invoke('agent-1', {
      message: { text: 'hello', type: 'text' },
      session: { userId: 'default', agentId: 'agent-1', history: [] },
    }, 1_000)).rejects.toThrow('unsupported media')
  })
})
