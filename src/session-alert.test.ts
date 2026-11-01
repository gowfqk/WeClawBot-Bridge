import { describe, expect, it } from 'vitest'
import type { NotificationLog } from './types'
import {
  SESSION_ALERT_RULE_ID,
  buildSessionAlertText,
  buildWebhookPayload,
  buildWebhookText,
  countMissedPushes,
  formatClock,
  formatGap,
  interpretWebhookResponse,
  maskWebhookUrl,
  normalizeWebhookUrl,
} from './session-alert'

// 北京时间 2025-01-01 08:00 与 2025-01-02 00:00（校验 hourCycle 不受宿主机时区影响）
const SHANGHAI_MORNING = Date.UTC(2025, 0, 1, 0, 0)
const SHANGHAI_MIDNIGHT = Date.UTC(2025, 0, 1, 16, 0)
const MINUTE = 60_000

const entry = (over: Partial<NotificationLog>): NotificationLog => ({
  id: Math.random().toString(36).slice(2),
  userId: 'default',
  content: { text: 'x' },
  status: 'failed',
  timestamp: 1000,
  ...over,
})

describe('formatGap', () => {
  it('按量级切换单位，负数按 0 处理', () => {
    expect(formatGap(45_000)).toBe('45 秒')
    expect(formatGap(0)).toBe('0 秒')
    expect(formatGap(-1000)).toBe('0 秒')
    expect(formatGap(28 * 60_000)).toBe('28 分钟')
    expect(formatGap(60 * 60_000)).toBe('1 小时')
    expect(formatGap(90 * 60_000)).toBe('1 小时 30 分')
  })
})

describe('formatClock', () => {
  it('固定输出北京时间的 MM-DD HH:mm', () => {
    expect(formatClock(SHANGHAI_MORNING)).toBe('01-01 08:00')
    expect(formatClock(SHANGHAI_MIDNIGHT)).toBe('01-02 00:00')
  })
})

describe('countMissedPushes', () => {
  const from = 1000
  const to = 2000

  it('只统计窗口内的主动推送失败', () => {
    const logs = [
      entry({ timestamp: 1500, source: 'notify' }),
      entry({ timestamp: 1500, source: 'task' }),
      entry({ timestamp: 999, source: 'notify' }),
      entry({ timestamp: 2001, source: 'notify' }),
      entry({ timestamp: 1500, source: 'reply' }),
      entry({ timestamp: 1500, source: 'notify', status: 'success' }),
      entry({ timestamp: 1500, source: 'notify', ruleId: SESSION_ALERT_RULE_ID }),
    ]
    expect(countMissedPushes(logs, from, to)).toBe(2)
  })

  it('边界时刻计入', () => {
    expect(countMissedPushes([entry({ timestamp: from }), entry({ timestamp: to })], from, to)).toBe(2)
  })
})

describe('buildSessionAlertText', () => {
  it('列出过期时刻、恢复时刻、离线时长与漏推条数', () => {
    const text = buildSessionAlertText({
      expiredAt: SHANGHAI_MORNING,
      restoredAt: SHANGHAI_MORNING + 28 * 60_000,
      missedPushes: 3,
    })
    expect(text).toContain('01-01 08:00 失效')
    expect(text).toContain('08:28 重新登录恢复')
    expect(text).toContain('离线 28 分钟')
    expect(text).toContain('3 条主动推送未能送达')
  })

  it('窗口内没有漏推时不谎报丢失', () => {
    const text = buildSessionAlertText({ expiredAt: SHANGHAI_MORNING, restoredAt: SHANGHAI_MORNING + 60_000, missedPushes: 0 })
    expect(text).toContain('无消息丢失')
  })
})

describe('buildWebhookPayload', () => {
  const expired = { kind: 'expired' as const, at: SHANGHAI_MORNING }
  const restored = {
    kind: 'restored' as const,
    at: SHANGHAI_MORNING + 30 * MINUTE,
    offlineMs: 30 * MINUTE,
    missedPushes: 2,
  }

  it('json 格式给出可路由的事件字段', () => {
    const payload = buildWebhookPayload('json', expired)
    expect(payload).toEqual({
      source: 'weclawbot-bridge',
      event: 'wechat_session_expired',
      at: SHANGHAI_MORNING,
      text: buildWebhookText(expired),
      clock: '01-01 08:00',
    })
    expect(buildWebhookPayload('json', restored)).toMatchObject({
      event: 'wechat_session_restored',
      offlineMs: 30 * MINUTE,
      missedPushes: 2,
    })
  })

  it('text 格式贴合企业微信/钉钉群机器人的 text 消息', () => {
    expect(buildWebhookPayload('text', expired)).toEqual({
      msgtype: 'text',
      text: { content: expect.any(String) },
    })
  })

  it('过期文案说明要重新扫码，恢复文案带离线时长与漏推条数', () => {
    expect(buildWebhookText(expired)).toContain('需要重新扫码登录')
    const text = buildWebhookText(restored)
    expect(text).toContain('离线 30 分钟')
    expect(text).toContain('2 条主动推送未送达')
    expect(buildWebhookText({ kind: 'restored', at: SHANGHAI_MORNING, offlineMs: 60_000 })).toContain('没有主动推送丢失')
  })

  it('json 字符串化后不含 secret 之外的意外字段', () => {
    const body = JSON.stringify(buildWebhookPayload('json', expired))
    expect(body).toContain('wechat_session_expired')
  })
})

describe('normalizeWebhookUrl', () => {
  it('只接受 http/https，并去掉首尾空白', () => {
    expect(normalizeWebhookUrl('  https://hooks.example.com/a  ')).toEqual({ ok: true, url: 'https://hooks.example.com/a' })
    expect(normalizeWebhookUrl('')).toEqual({ ok: false, error: '未配置 webhook 地址' })
    expect(normalizeWebhookUrl('ftp://example.com')).toMatchObject({ ok: false })
    expect(normalizeWebhookUrl('不是 URL')).toMatchObject({ ok: false })
  })
})

describe('maskWebhookUrl', () => {
  it('丢掉 query，避免机器人 token 进日志', () => {
    expect(maskWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=SECRET'))
      .toBe('https://oapi.dingtalk.com/robot/send')
  })
})

describe('interpretWebhookResponse', () => {
  it('非 2xx 判失败', () => {
    expect(interpretWebhookResponse(500, '')).toEqual({ ok: false, error: 'HTTP 500' })
  })

  it('群机器人 200 + 非 0 errcode 也算没送达', () => {
    expect(interpretWebhookResponse(200, '{"errcode":93000,"errmsg":"invalid token"}'))
      .toEqual({ ok: false, error: 'errcode=93000 invalid token' })
    expect(interpretWebhookResponse(200, '{"errcode":0,"errmsg":"ok"}').ok).toBe(true)
  })

  it('非 JSON 响应体只看状态码', () => {
    expect(interpretWebhookResponse(201, 'created').ok).toBe(true)
  })
})
