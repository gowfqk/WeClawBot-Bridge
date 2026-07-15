import { describe, expect, it, vi } from 'vitest'

const login = vi.fn(async () => ({ accountId: 'account', userId: 'user' }))
const on = vi.fn()

vi.mock('@wechatbot/wechatbot', () => ({
  WeChatBot: class {
    login = login
    on = on
  },
}))

import { BotManager } from './bot-manager'
import { MemoryStorage } from './storage'

describe('BotManager credential recovery', () => {
  it('uses persisted credentials by default after a restart', async () => {
    const manager = new BotManager(new MemoryStorage())
    await manager.login()
    expect(login).toHaveBeenLastCalledWith(expect.objectContaining({ force: false }))
  })

  it('only skips persisted credentials when force is explicitly requested', async () => {
    const manager = new BotManager(new MemoryStorage())
    await manager.login(undefined, true)
    expect(login).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
  })
})
