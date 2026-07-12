import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { WeClawBotAgent } from '../agent-plugin/src/index'

const servers: WebSocketServer[] = []

async function startServer(): Promise<{ url: string; connections: () => number; sockets: WebSocket[] }> {
  const sockets: WebSocket[] = []
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  server.on('connection', socket => { sockets.push(socket) })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `ws://127.0.0.1:${port}`, connections: () => sockets.length, sockets }
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (condition()) return
    await wait(10)
  }
  throw new Error(message)
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('WeClawBotAgent connection lifecycle', () => {
  it('does not reconnect after an explicit disconnect', async () => {
    const bridge = await startServer()
    const agent = new WeClawBotAgent({
      bridgeUrl: bridge.url, agentId: 'yb', token: 'token', reconnectInterval: 20,
    })
    agent.connect()
    await waitFor(() => bridge.connections() === 1, 'initial connection was not established')

    agent.disconnect()
    await wait(80)

    expect(bridge.connections()).toBe(1)
    expect(agent.getStatus()).toBe('disconnected')
  })

  it('does not reconnect when a stale socket closes after a replacement connects', async () => {
    const bridge = await startServer()
    const agent = new WeClawBotAgent({
      bridgeUrl: bridge.url, agentId: 'yb', token: 'token', reconnectInterval: 20,
    })
    agent.connect()
    await waitFor(() => bridge.connections() === 1, 'initial connection was not established')

    ;(agent as any).ws = null
    agent.connect()
    await waitFor(() => bridge.connections() === 2, 'replacement connection was not established')

    bridge.sockets[0].close(4008, 'replaced')
    await wait(80)

    expect(bridge.connections()).toBe(2)
  })
})
