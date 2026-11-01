import { describe, expect, it, vi } from 'vitest'

const login = vi.fn(async () => ({ accountId: 'account', userId: 'user' }))
const listeners = new Map<string, (...args: unknown[]) => unknown>()
const on = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
  listeners.set(event, listener)
})
const stop = vi.fn()
const storageDelete = vi.fn(async () => undefined)
const botReply = vi.fn(async (_msg: unknown, _content: unknown) => {})
const botSend = vi.fn(async (_userId: string, _content: unknown) => {})

vi.mock('@wechatbot/wechatbot', () => ({
  WeChatBot: class {
    login = login
    on = on
    stop = stop
    reply = botReply
    send = botSend
    storage = { delete: storageDelete }
  },
}))

import { BotManager, toBotContent } from './bot-manager'
import { MemoryStorage } from './storage'

describe('BotManager credential recovery', () => {
  it('uses persisted credentials by default after a restart', async () => {
    const manager = new BotManager(new MemoryStorage())
    await manager.login()
    expect(login).toHaveBeenLastCalledWith(expect.objectContaining({ force: false }))
    expect(storageDelete).not.toHaveBeenCalled()
  })

  it('only skips persisted credentials when force is explicitly requested', async () => {
    const manager = new BotManager(new MemoryStorage())
    await manager.login(undefined, true)
    expect(login).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
  })

  it('clears stored credentials before requesting a new QR when force re-binding', async () => {
    storageDelete.mockClear()
    login.mockClear()

    const manager = new BotManager(new MemoryStorage())
    await manager.login(undefined, true)

    // Must clear the old binding's token before calling login(), otherwise the
    // server's QR endpoint recognizes the old token and returns
    // `binded_redirect`, silently reusing the OLD credentials and making
    // "重新绑定" appear to do nothing.
    expect(storageDelete).toHaveBeenCalledWith('credentials')
    expect(storageDelete).toHaveBeenCalledWith('cursor')
    expect(storageDelete).toHaveBeenCalledWith('context_tokens')
    expect(storageDelete).toHaveBeenCalledWith('typing_tickets')

    const deleteOrder = storageDelete.mock.invocationCallOrder[0]
    const loginOrder = login.mock.invocationCallOrder[0]
    expect(deleteOrder).toBeLessThan(loginOrder)
  })
})

describe('BotManager.unbind', () => {
  it('stops polling, clears stored credentials, and resets status without starting a new login', async () => {
    storageDelete.mockClear()
    stop.mockClear()
    login.mockClear()

    const manager = new BotManager(new MemoryStorage())
    await manager.unbind()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(storageDelete).toHaveBeenCalledWith('credentials')
    expect(storageDelete).toHaveBeenCalledWith('cursor')
    expect(storageDelete).toHaveBeenCalledWith('context_tokens')
    expect(storageDelete).toHaveBeenCalledWith('typing_tickets')
    expect(login).not.toHaveBeenCalled()

    const status = manager.getStatus()
    expect(status.loggedIn).toBe(false)
    expect(status.polling).toBe(false)
    expect(status.qrUrl).toBeUndefined()
  })
})

describe('toBotContent', () => {
  it('映射四类内容并在没有任何内容时抛错', async () => {
    const png = Buffer.from('png')
    expect(toBotContent({ text: 'hi' })).toEqual({ text: 'hi' })
    expect(toBotContent({ image: png })).toEqual({ image: png })
    expect(toBotContent({ video: png })).toEqual({ video: png })
    expect(toBotContent({ file: { data: png, fileName: 'a.pdf' } })).toEqual({
      file: png,
      fileName: 'a.pdf',
    })
    // 过去这里会静默「发送成功」，用户端什么都收不到。
    expect(() => toBotContent({ caption: '只有一句说明' })).toThrow(/内容为空/)
    expect(() => toBotContent({})).toThrow(/内容为空/)
  })
})

describe('BotManager SDK 事件', () => {
  it('轮询循环的启停反映在轮询状态上', () => {
    const manager = new BotManager(new MemoryStorage())
    expect(manager.getStatus().polling).toBe(false)

    listeners.get('poll:start')!()
    expect(manager.getStatus().polling).toBe(true)

    listeners.get('poll:stop')!()
    expect(manager.getStatus().polling).toBe(false)
  })

  it('SDK 错误记入状态，成为「消息没送达」的第一线索', () => {
    const manager = new BotManager(new MemoryStorage())
    expect(manager.getStatus().lastError).toBeUndefined()

    listeners.get('error')!(new Error('getupdates timeout'))
    const status = manager.getStatus()
    expect(status.lastError?.message).toBe('getupdates timeout')
    expect(status.lastError?.at).toBeGreaterThan(0)
  })

  it('非 Error 的 SDK 上报也不会丢失', () => {
    const manager = new BotManager(new MemoryStorage())
    listeners.get('error')!('字符串错误')
    expect(manager.getStatus().lastError?.message).toBe('字符串错误')
  })

  it('凭证生命周期事件转发给订阅者，登录与恢复都算 restored', () => {
    const manager = new BotManager(new MemoryStorage())
    const seen: string[] = []
    manager.onSessionEvent((kind) => seen.push(kind))

    listeners.get('session:expired')!()
    listeners.get('session:restored')!({ accountId: 'account', userId: 'user' })
    listeners.get('login')!({ accountId: 'account', userId: 'user' })

    expect(seen).toEqual(['expired', 'restored', 'restored'])
  })

  it('一个监听器抛错不影响其他监听器', () => {
    const manager = new BotManager(new MemoryStorage())
    const seen: string[] = []
    manager.onSessionEvent(() => { throw new Error('订阅者炸了') })
    manager.onSessionEvent((kind) => seen.push(kind))

    listeners.get('session:expired')!()
    expect(seen).toEqual(['expired'])
  })
})

describe('BotManager 长文本分条', () => {
  const sentTexts = (mock: typeof botReply) =>
    mock.mock.calls.map(([, content]) => (content as { text: string }).text)

  it('超出 SDK 4000 字预算时自己按代码块边界分条，不让 SDK 从围栏中间切断', async () => {
    botReply.mockClear()
    const body = Array.from({ length: 900 }, (_, i) => `  const value${i} = ${i}`).join('\n')
    const text = `前置说明。\n\n\`\`\`js\n${body}\n\`\`\`\n\n后置说明。`
    expect(text.length).toBeGreaterThan(4000)

    const manager = new BotManager(new MemoryStorage())
    await manager.sendReply({ from_user_id: 'user' }, { text })

    const pieces = sentTexts(botReply)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(4000)
      const fences = piece.split('\n').filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line)).length
      expect(fences % 2, `围栏被切断:\n${piece.slice(0, 80)}…`).toBe(0)
    }
    expect(pieces.join('\n')).toContain('前置说明。')
    expect(pieces.at(-1)).toContain('后置说明。')
  })

  it('预算内的文本与媒体内容原样单次发送', async () => {
    botReply.mockClear()
    botSend.mockClear()
    const manager = new BotManager(new MemoryStorage())

    await manager.sendReply({ from_user_id: 'user' }, { text: '短回复\n\n```js\nok\n```' })
    expect(sentTexts(botReply)).toEqual(['短回复\n\n```js\nok\n```'])

    await manager.send('user', { image: Buffer.from('png') })
    expect(botSend).toHaveBeenCalledTimes(1)
    expect(botSend.mock.calls[0][1]).toMatchObject({ image: Buffer.from('png') })
  })
})

describe('BotManager message dispatch', () => {
  it('does not block later messages while a handler is waiting for approval', async () => {
    const manager = new BotManager(new MemoryStorage())
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const handled: string[] = []

    manager.onMessage(async (msg) => {
      handled.push(msg.text)
      if (msg.text === 'run dangerous command') await firstPending
    })

    const listener = listeners.get('message')
    expect(listener).toBeTypeOf('function')
    const message = (text: string) => ({
      userId: 'user',
      text,
      type: 'text',
      images: [],
      files: [],
      videos: [],
      voices: [],
    })

    const firstResult = listener!(message('run dangerous command'))
    const approveResult = listener!(message('/approve'))

    expect(firstResult).toBeUndefined()
    expect(approveResult).toBeUndefined()
    await vi.waitFor(() => expect(handled).toEqual(['run dangerous command', '/approve']))

    releaseFirst()
    await Promise.resolve()
  })
})
