import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from './storage'
import { OutboundLog } from './outbound-log'
import { SessionAlertService, type SessionAlertBot, type WebhookFetch } from './session-alert-service'
import { SESSION_ALERT_RULE_ID, type SessionAlertSettings } from './session-alert'
import type { SendContent } from './types'

const T0 = Date.UTC(2025, 0, 1, 0, 0)
const MINUTE = 60_000

/** 服务与 OutboundLog 都只读 Date.now()，用它推进时间。 */
let now = T0

interface FakeBot extends SessionAlertBot {
  sendReply: ReturnType<typeof vi.fn>
  fireSession(kind: 'expired' | 'restored'): void
  fireMessage(userId: string): Promise<void>
}

function fakeBot(): FakeBot {
  const sessionListeners: ((kind: 'expired' | 'restored') => void)[] = []
  const messageHandlers: ((msg: { userId: string; text: string; type: string; hasMedia: boolean; raw: unknown }) => Promise<void>)[] = []
  return {
    // 默认成功，单个用例可覆盖
    sendReply: vi.fn(async () => undefined),
    onSessionEvent: (listener) => { sessionListeners.push(listener) },
    onMessage: (handler) => { messageHandlers.push(handler) },
    fireSession(kind) { for (const listener of [...sessionListeners]) listener(kind) },
    async fireMessage(userId) {
      const msg = { userId, text: '在吗', type: 'text', hasMedia: false, raw: { from_user_id: userId } }
      await Promise.all(messageHandlers.map((handler) => handler(msg)))
    },
  }
}

async function harness(settings?: Partial<SessionAlertSettings>, fetchImpl?: WebhookFetch) {
  const storage = new MemoryStorage()
  const bot = fakeBot()
  const outboundLog = new OutboundLog(storage)
  const service = new SessionAlertService(bot, storage, outboundLog, fetchImpl)
  await service.load()
  service.start()
  if (settings) await service.saveSettings(settings)
  bot.fireSession('restored')  // 模拟启动时的首次登录，不应产生任何提醒
  return { storage, bot, outboundLog, service }
}

/** webhook 端：按顺序返回响应，耗尽后重复最后一个；请求体解码后供断言。 */
function fakeFetch(responses: Array<{ status: number; body: string } | Error> = [{ status: 200, body: '{"errcode":0,"errmsg":"ok"}' }]) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  let index = 0
  const impl: WebhookFetch = async (url, init) => {
    const next = responses[Math.min(index, responses.length - 1)]
    index++
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    if (next instanceof Error) throw next
    return { status: next.status, text: async () => next.body }
  }
  return { impl, calls }
}

function alertText(call: unknown[] | undefined): string {
  const content = call?.[1] as SendContent | undefined
  return content?.text ?? ''
}

/** 让掉线窗口处理链上的异步写入跑完：Date.now 被 mock 了，不能用 vi.waitFor。 */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** webhook 失败后的重试间隔是真实的 1 秒，只有这组用例需要等。 */
function realSecond() {
  return new Promise((resolve) => setTimeout(resolve, 1_100))
}

beforeEach(() => {
  now = T0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SessionAlertService 掉线窗口', () => {
  it('启动登录没有掉线历史时不记录也不提醒', async () => {
    const { service, storage } = await harness()
    await settle()
    expect(service.getState().gaps).toEqual([])
    expect(service.getState().pendingAlert).toBeNull()
    expect(await storage.get('config:session_alert_gaps')).toBeUndefined()
  })

  it('过期后锁定窗口起点，重复上报不会把起点推后', async () => {
    const { service, bot } = await harness()
    bot.fireSession('expired')
    now = T0 + 10 * MINUTE
    bot.fireSession('expired')
    expect(service.getState().outageStartedAt).toBe(T0)

    now = T0 + 20 * MINUTE
    bot.fireSession('restored')
    await settle()
    expect(service.getState().gaps).toHaveLength(1)
    const gap = service.getState().gaps[0]
    expect(gap.expiredAt).toBe(T0)
    expect(gap.restoredAt).toBe(T0 + 20 * MINUTE)
  })

  it('恢复时统计窗口内的漏推条数（排除对话回复与成功记录）', async () => {
    const { service, bot, outboundLog } = await harness()
    bot.fireSession('expired')
    now = T0 + 5 * MINUTE
    await outboundLog.record({ source: 'task', userId: 'default', content: { text: '日报' }, status: 'failed', error: 'Bot 未登录' })
    now = T0 + 6 * MINUTE
    await outboundLog.record({ source: 'notify', userId: 'default', content: { text: '恢复正常' }, status: 'success' })
    now = T0 + 6.5 * MINUTE
    await outboundLog.record({ source: 'reply', userId: 'default', content: {}, status: 'failed', error: '轮询中断' })

    now = T0 + 7 * MINUTE
    bot.fireSession('restored')
    await settle()
    expect(service.getState().gaps).toHaveLength(1)
    expect(service.getState().gaps[0].missedPushes).toBe(1)
  })

  it('关掉补发开关后事件照常记录，但不发微信', async () => {
    const { service, bot } = await harness({ pushEnabled: false })
    bot.fireSession('expired')
    now = T0 + MINUTE
    bot.fireSession('restored')
    await settle()
    expect(service.getState().gaps).toHaveLength(1)

    expect(service.getState().pendingAlert).toBeNull()
    await bot.fireMessage('user-1')
    expect(bot.sendReply).not.toHaveBeenCalled()
  })

  it('关闭记录时不落库，但仍然补发', async () => {
    const { service, bot, storage } = await harness({ recordEnabled: false })
    bot.fireSession('expired')
    now = T0 + MINUTE
    bot.fireSession('restored')
    await settle()

    expect(service.getState().gaps).toEqual([])
    expect(await storage.get('config:session_alert_gaps')).toBeUndefined()
    expect(service.getState().pendingAlert).not.toBeNull()

    await bot.fireMessage('user-1')
    expect(bot.sendReply).toHaveBeenCalledTimes(1)
  })
})

describe('SessionAlertService 补发提醒', () => {
  it('借第一条来消息的 context_token 发送，并写进出站记录', async () => {
    const { service, bot, outboundLog } = await harness()
    bot.fireSession('expired')
    now = T0 + 30 * MINUTE
    bot.fireSession('restored')
    await settle()

    now = T0 + 40 * MINUTE
    await bot.fireMessage('user-1')

    expect(bot.sendReply).toHaveBeenCalledTimes(1)
    expect(alertText(bot.sendReply.mock.calls[0])).toContain('离线 30 分钟')
    expect(service.getState().pendingAlert).toBeNull()
    expect(service.getState().gaps[0].alertedAt).toBe(T0 + 40 * MINUTE)

    const record = (await outboundLog.list()).find((log) => log.ruleId === SESSION_ALERT_RULE_ID)
    expect(record?.status).toBe('success')
    expect(record?.content.text).toContain('失效')
  })

  it('发送失败时保留待发状态，下一条消息重试成功', async () => {
    const { service, bot, outboundLog } = await harness()
    bot.sendReply.mockRejectedValueOnce(new Error('No context_token cached for user user-1'))

    bot.fireSession('expired')
    now = T0 + MINUTE
    bot.fireSession('restored')
    await settle()

    await bot.fireMessage('user-1')
    expect(service.getState().pendingAlert).not.toBeNull()
    expect(service.getState().gaps[0].alertError).toContain('No context_token')

    await bot.fireMessage('user-1')
    expect(bot.sendReply).toHaveBeenCalledTimes(2)
    expect(service.getState().pendingAlert).toBeNull()

    const records = (await outboundLog.list()).filter((log) => log.ruleId === SESSION_ALERT_RULE_ID)
    expect(records.map((log) => log.status).sort()).toEqual(['failed', 'success'])
  })

  it('补发期间并发到达的消息不会触发两次发送', async () => {
    const { service, bot } = await harness()
    let release!: () => void
    bot.sendReply.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))

    bot.fireSession('expired')
    now = T0 + MINUTE
    bot.fireSession('restored')
    await settle()

    const first = bot.fireMessage('user-1')
    await settle()
    expect(bot.sendReply).toHaveBeenCalledTimes(1)
    const second = bot.fireMessage('user-2')

    release()
    await Promise.all([first, second])
    expect(bot.sendReply).toHaveBeenCalledTimes(1)
    expect(service.getState().pendingAlert).toBeNull()
  })

  it('重启后读回全部设置的持久化状态', async () => {
    const { service, storage } = await harness()
    await service.saveSettings({ recordEnabled: true, pushEnabled: false, webhookEnabled: true, webhookUrl: ' https://hooks.example.com/n ', webhookFormat: 'text' })

    const restarted = new SessionAlertService(fakeBot(), storage, new OutboundLog(storage))
    await restarted.load()
    expect(restarted.getState().settings).toEqual({
      recordEnabled: true,
      pushEnabled: false,
      webhookEnabled: true,
      webhookUrl: 'https://hooks.example.com/n',
      webhookFormat: 'text',
    })
  })

  it('中途关掉补发开关会丢弃待发提醒', async () => {
    const { service, bot } = await harness()
    bot.fireSession('expired')
    now = T0 + MINUTE
    bot.fireSession('restored')
    await settle()
    expect(service.getState().pendingAlert).not.toBeNull()

    await service.saveSettings({ pushEnabled: false })
    expect(service.getState().pendingAlert).toBeNull()

    await bot.fireMessage('user-1')
    expect(bot.sendReply).not.toHaveBeenCalled()
  })
})

describe('SessionAlertService 掉线 webhook', () => {
  const ON = { webhookEnabled: true, webhookUrl: 'https://hooks.example.com/notify?access_token=SECRET' }

  it('未启用时一次请求都不发，也不在掉线记录里留结果', async () => {
    const fetch = fakeFetch()
    const { service, bot } = await harness({}, fetch.impl)
    bot.fireSession('expired')
    await settle()
    now = T0 + MINUTE
    bot.fireSession('restored')
    await settle()

    expect(fetch.calls).toEqual([])
    expect(service.getState().gaps[0].webhook).toBeUndefined()
  })

  it('过期立即推一次，恢复再推一次并带上离线时长与漏推条数', async () => {
    const fetch = fakeFetch()
    const { service, bot, outboundLog } = await harness(ON, fetch.impl)

    bot.fireSession('expired')
    await settle()
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0].body).toMatchObject({ event: 'wechat_session_expired', clock: '01-01 08:00' })
    expect(service.getState().outageWebhook).toEqual({ status: 'sent' })

    now = T0 + 40 * MINUTE
    await outboundLog.record({ source: 'task', userId: 'default', content: { text: '日报' }, status: 'failed', error: 'Bot 未登录' })
    bot.fireSession('restored')
    await settle()

    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls[1].body).toMatchObject({
      event: 'wechat_session_restored',
      offlineMs: 40 * MINUTE,
      missedPushes: 1,
    })
    expect(service.getState().gaps[0].webhook).toEqual({ expired: { status: 'sent' }, restored: { status: 'sent' } })
  })

  it('群机器人格式提交 msgtype/text，且面板能读回带 token 的地址', async () => {
    const fetch = fakeFetch()
    const { service, bot } = await harness({ ...ON, webhookFormat: 'text' }, fetch.impl)
    bot.fireSession('expired')
    await settle()

    expect(fetch.calls[0].body).toEqual({ msgtype: 'text', text: { content: expect.any(String) } })
    expect(fetch.calls[0].url).toContain('access_token=SECRET')
    expect(service.getState().settings).toMatchObject({ webhookFormat: 'text', webhookUrl: ON.webhookUrl })
  })

  it('地址没填也开了开关：记为失败且不发请求，恢复后仍会补发微信', async () => {
    const fetch = fakeFetch()
    const { service, bot } = await harness({ webhookEnabled: true }, fetch.impl)

    bot.fireSession('expired')
    await settle()
    expect(fetch.calls).toEqual([])
    expect(service.getState().outageWebhook).toEqual({ status: 'failed', error: '未配置 webhook 地址' })

    now = T0 + MINUTE
    bot.fireSession('restored')
    await settle()
    expect(service.getState().gaps[0].webhook?.expired).toEqual({ status: 'failed', error: '未配置 webhook 地址' })
    expect(service.getState().pendingAlert).not.toBeNull()
  })

  it('群机器人回 200 但 errcode 非 0 时判失败，一秒后重试成功', async () => {
    const fetch = fakeFetch([
      { status: 200, body: '{"errcode":93000,"errmsg":"invalid token"}' },
      { status: 200, body: '{"errcode":0,"errmsg":"ok"}' },
    ])
    const { service, bot } = await harness(ON, fetch.impl)

    bot.fireSession('expired')
    await settle()
    expect(service.getState().outageWebhook).toBeUndefined()
    await realSecond()
    await settle()

    expect(fetch.calls).toHaveLength(2)
    expect(service.getState().outageWebhook).toEqual({ status: 'sent' })
  })

  it('两次都推不进去也只是失败，不影响掉线记录', async () => {
    const fetch = fakeFetch([new Error('fetch failed')])
    const { service, bot } = await harness(ON, fetch.impl)

    bot.fireSession('expired')
    await realSecond()
    await settle()
    now = T0 + MINUTE
    bot.fireSession('restored')
    await realSecond()
    await settle()

    expect(fetch.calls).toHaveLength(4)
    const gap = service.getState().gaps[0]
    expect(gap.webhook?.expired).toEqual({ status: 'failed', error: 'fetch failed' })
    expect(gap.webhook?.restored).toEqual({ status: 'failed', error: 'fetch failed' })
  })
})
