import { describe, expect, it, vi } from 'vitest'

const login = vi.fn(async () => ({ accountId: 'account', userId: 'user' }))
const on = vi.fn()
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
