import { describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from './storage'
import { NotificationService } from './notification'
import { OutboundLog } from './outbound-log'
import { NoContextError } from '@wechatbot/wechatbot'

const rule = {
  id: 'daily',
  type: 'cron' as const,
  schedule: '0 9 * * *',
  content: { text: '早安' },
}

function bot(sendImpl?: (userId: string, content: unknown) => Promise<void>) {
  return {
    getStatus: vi.fn(() => ({ loggedIn: true, currentUser: 'default' })),
    send: vi.fn(sendImpl ?? (async () => undefined)),
  } as any
}

function service(sendImpl?: (userId: string, content: unknown) => Promise<void>) {
  const storage = new MemoryStorage()
  const outboundLog = new OutboundLog(storage)
  const botManager = bot(sendImpl)
  return { storage, outboundLog, botManager, service: new NotificationService(botManager, storage, outboundLog) }
}

describe('NotificationService rule persistence', () => {
  it('loads persisted rules and replaces them durably', async () => {
    const storage = new MemoryStorage()
    const first = new NotificationService(bot(), storage, new OutboundLog(storage))
    await first.replaceAllRules([rule])

    const restarted = new NotificationService(bot(), storage, new OutboundLog(storage))
    await restarted.loadRules()
    expect(restarted.listRules()).toEqual([rule])

    await restarted.replaceAllRules([])
    const afterDelete = new NotificationService(bot(), storage, new OutboundLog(storage))
    await afterDelete.loadRules()
    expect(afterDelete.listRules()).toEqual([])
  })
})

describe('NotificationService 发送记录', () => {
  it('成功发送后留下 notify 来源的成功记录', async () => {
    const { service: svc, outboundLog } = service()
    await svc.send('user-1', { text: '早安' })

    const [entry] = await outboundLog.list()
    expect(entry).toMatchObject({ source: 'notify', userId: 'user-1', status: 'success', content: { text: '早安' } })
  })

  it('定时任务来源的记录用 task 标记并带上规则 ID', async () => {
    const { outboundLog, service: svc } = service()
    await svc.send('user-1', { text: '每日报告' }, 'task:report-daily')

    const [entry] = await outboundLog.list()
    expect(entry).toMatchObject({ source: 'task', ruleId: 'task:report-daily', status: 'success' })
  })

  it('媒体发送只记录类型和大小，不落 Buffer', async () => {
    const { outboundLog, service: svc } = service()
    await svc.send('user-1', { image: Buffer.alloc(4096), caption: '截图' })

    const [entry] = await outboundLog.list()
    expect(entry.content).toEqual({ text: '截图', media: { kind: 'image', bytes: 4096 } })
  })

  it('缺少 context_token 时不重试，直接记一条失败', async () => {
    const botManager = bot(async () => {
      throw new NoContextError('user-1')
    })
    const storage = new MemoryStorage()
    const svc = new NotificationService(botManager, storage, new OutboundLog(storage))

    await expect(svc.send('user-1', { text: 'hi' })).rejects.toBeInstanceOf(NoContextError)

    expect(botManager.send).toHaveBeenCalledTimes(1)
    const [entry] = await svc.getNotificationLogs()
    expect(entry).toMatchObject({ status: 'failed', source: 'notify' })
    expect(entry.error).toContain('context_token')
  })

  it('未登录且没有接收对象时抛错，不产生记录', async () => {
    const botManager = { getStatus: () => ({ loggedIn: false, polling: false }), send: vi.fn() } as any
    const storage = new MemoryStorage()
    const svc = new NotificationService(botManager, storage, new OutboundLog(storage))

    await expect(svc.send(undefined, { text: 'hi' })).rejects.toThrow('Bot 未登录')
    expect(botManager.send).not.toHaveBeenCalled()
    expect(await svc.getNotificationLogs()).toEqual([])
  })
})
