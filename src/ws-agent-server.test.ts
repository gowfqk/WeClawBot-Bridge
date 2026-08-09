import http from 'node:http'
import type { AddressInfo } from 'node:net'
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

  it('forwards intermediate replies and resolves only after the final reply', async () => {
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
        client!.send(JSON.stringify({ type: 'chat', id: message.id, text: '正在调用工具…', final: false }))
        setTimeout(() => {
          client!.send(JSON.stringify({ type: 'chat', id: message.id, text: '最终回答', final: true }))
        }, 10)
      }
    })

    const intermediate: string[] = []
    await expect(server.invoke('agent-1', {
      message: { text: 'hello', type: 'text' },
      session: { userId: 'default', agentId: 'agent-1', history: [] },
    }, 1_000, (text) => intermediate.push(text))).resolves.toEqual({ reply: { text: '最终回答' } })
    expect(intermediate).toEqual(['正在调用工具…'])
  })

  it('delivers media on intermediate (final:false) replies', async () => {
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

    const mediaBase64 = Buffer.from('fake-image-bytes').toString('base64')
    client.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; id?: string }
      if (message.type === 'chat' && message.id) {
        client!.send(JSON.stringify({
          type: 'chat',
          id: message.id,
          text: '这是图片',
          media: mediaBase64,
          mediaType: 'image',
          mediaFileName: 'photo.jpg',
          mediaFormat: 'jpeg',
          final: false,
        }))
        setTimeout(() => {
          client!.send(JSON.stringify({ type: 'chat', id: message.id, text: '最终回答', final: true }))
        }, 10)
      }
    })

    const intermediate: Array<{ text: string; media?: { data: Buffer; type: string; fileName?: string } }> = []
    await expect(server.invoke('agent-1', {
      message: { text: 'hello', type: 'text' },
      session: { userId: 'default', agentId: 'agent-1', history: [] },
    }, 1_000, (text, media) => intermediate.push({ text, media }))).resolves.toEqual({ reply: { text: '最终回答' } })
    expect(intermediate).toHaveLength(1)
    expect(intermediate[0].text).toBe('这是图片')
    expect(intermediate[0].media?.data.toString()).toBe('fake-image-bytes')
    expect(intermediate[0].media?.type).toBe('image')
    expect(intermediate[0].media?.fileName).toBe('photo.jpg')
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

// ===== Bridge → Agent 媒体发送（文件）=====

const TOKEN = 'wsk_test_file_media_token'

function createServer(): Promise<{ server: WsAgentServer; httpServer: http.Server; url: string }> {
  const wsServer = new WsAgentServer()
  wsServer.setAgentToken('cs', TOKEN)
  const httpServer = http.createServer()
  wsServer.attach(httpServer)
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as AddressInfo
      resolve({ server: wsServer, httpServer, url: `ws://127.0.0.1:${port}/ws/agent` })
    })
  })
}

/** Connect a fake OpenClaw agent and wait for the auth_ok handshake. */
function connectAgent(url: string, agentId = 'cs'): Promise<{ ws: WebSocket; received: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const received: unknown[] = []
    const timer = setTimeout(() => reject(new Error('auth_ok timeout')), 5000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN, agentId, name: 'cs', command: 'cs' }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      received.push(msg)
      if (msg.type === 'auth_ok') {
        clearTimeout(timer)
        resolve({ ws, received })
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** The client receives frames asynchronously; poll until the chat frame lands. */
async function waitForChatFrame(received: unknown[]): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const frame = received.find((m) => (m as Record<string, unknown>).type === 'chat')
    if (frame) return frame as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('no chat frame received within timeout')
}

const mediaServers: Array<{ server: WsAgentServer; httpServer: http.Server }> = []

afterEach(async () => {
  while (mediaServers.length > 0) {
    const { server, httpServer } = mediaServers.pop()!
    server.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  }
})

describe('WS Agent 发送文件给 Agent', () => {
  it('把微信文件 base64 编码后通过 WS 帧发给 Agent', async () => {
    const env = await createServer()
    mediaServers.push(env)
    const { ws, received } = await connectAgent(env.url)

    const fileContent = Buffer.from('%PDF-1.4 mock report content')
    const invokePromise = env.server.invoke('cs', {
      message: {
        text: '请看看这个文件',
        type: 'file',
        media: { type: 'file', data: fileContent, fileName: 'report.pdf', format: 'pdf' },
      },
      session: { userId: 'user', agentId: 'cs', history: [] },
    })

    // The Bridge → Agent chat frame must carry the file as base64 + metadata.
    const frame = await waitForChatFrame(received)
    const payload = frame.payload as { message: Record<string, unknown> }
    expect(frame.type).toBe('chat')
    expect(frame.id).toBeTruthy()
    expect(payload.message.media).toBe(fileContent.toString('base64'))
    expect(payload.message.mediaType).toBe('file')
    expect(payload.message.mediaFileName).toBe('report.pdf')
    expect(payload.message.mediaFormat).toBe('pdf')

    // Fake agent acknowledges, which resolves the invoke() promise.
    ws.send(JSON.stringify({ type: 'chat', id: frame.id as string, text: '收到文件', final: true }))
    const response = await invokePromise
    expect(response.reply.text).toBe('收到文件')

    ws.close()
  })

  it('无文件名时序列化帧不携带 mediaFileName', async () => {
    const env = await createServer()
    mediaServers.push(env)
    const { ws, received } = await connectAgent(env.url)

    const invokePromise = env.server.invoke('cs', {
      message: {
        text: '看看这个',
        type: 'file',
        media: { type: 'file', data: Buffer.from('plain binary'), format: 'bin' },
      },
      session: { userId: 'user', agentId: 'cs', history: [] },
    })

    const frame = await waitForChatFrame(received)
    const payload = frame.payload as { message: Record<string, unknown> }
    expect(payload.message.media).toBe(Buffer.from('plain binary').toString('base64'))
    expect(payload.message.mediaType).toBe('file')
    expect(payload.message.mediaFileName).toBeUndefined()
    expect(payload.message.mediaFormat).toBe('bin')

    ws.send(JSON.stringify({ type: 'chat', id: frame.id as string, text: 'ok', final: true }))
    await invokePromise
    ws.close()
  })
})
