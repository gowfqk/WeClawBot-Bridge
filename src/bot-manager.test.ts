import { describe, expect, it, vi } from 'vitest'

const login = vi.fn(async () => ({ accountId: 'account', userId: 'user' }))
const listeners = new Map<string, (...args: unknown[]) => unknown>()
const on = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
  listeners.set(event, listener)
})
const stop = vi.fn()
const storageDelete = vi.fn(async () => undefined)

vi.mock('@wechatbot/wechatbot', () => ({
  WeChatBot: class {
    login = login
    on = on
    stop = stop
    storage = { delete: storageDelete }
  },
}))

import { BotManager } from './bot-manager'
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
