import { describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from './storage'
import { NotificationService } from './notification'

const rule = {
  id: 'daily',
  type: 'cron' as const,
  schedule: '0 9 * * *',
  content: { text: '早安' },
}

function bot() {
  return {
    getStatus: vi.fn(() => ({ loggedIn: true, currentUser: 'default' })),
    send: vi.fn(),
  } as any
}

describe('NotificationService rule persistence', () => {
  it('loads persisted rules and replaces them durably', async () => {
    const storage = new MemoryStorage()
    const first = new NotificationService(bot(), storage)
    await first.replaceAllRules([rule])

    const restarted = new NotificationService(bot(), storage)
    await restarted.loadRules()
    expect(restarted.listRules()).toEqual([rule])

    await restarted.replaceAllRules([])
    const afterDelete = new NotificationService(bot(), storage)
    await afterDelete.loadRules()
    expect(afterDelete.listRules()).toEqual([])
  })
})
