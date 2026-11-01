/**
 * 微信 session 过期提醒的纯逻辑：设置默认值、时长/时刻格式化、漏推计数与提醒文案。
 *
 * 这里不订阅 SDK 事件，也不读写 Storage —— 接线在 SessionAlertService，
 * 拆开后可以脱离微信连接单测文案与计数规则。
 */
import type { NotificationLog } from './types'

/** 出站发送记录里标记「这条是掉线提醒本身」的 ruleId，计数时要排除掉。 */
export const SESSION_ALERT_RULE_ID = 'session:expired'

/**
 * json：自建接收端，字段齐全自己路由。
 * text：`{msgtype:"text",text:{content}}`，企业微信与钉钉群机器人的纯文本消息同形。
 */
export type SessionWebhookFormat = 'json' | 'text'

export interface SessionAlertSettings {
  /** 记录掉线/恢复事件，在面板展示 */
  recordEnabled: boolean
  /** 恢复后借第一条来微信消息的 context_token 补发提醒 */
  pushEnabled: boolean
  /** 掉线当下 POST 到外部地址 —— 这是唯一能在通道断开时送达的提醒 */
  webhookEnabled: boolean
  webhookUrl: string
  webhookFormat: SessionWebhookFormat
}

export const DEFAULT_SESSION_ALERT_SETTINGS: SessionAlertSettings = {
  recordEnabled: true,
  pushEnabled: true,
  webhookEnabled: false,
  webhookUrl: '',
  webhookFormat: 'json',
}

export interface WebhookAttempt {
  status: 'sent' | 'failed'
  error?: string
}

/** 一次掉线窗口：过期 → 恢复 → （可选）提醒送达 */
export interface SessionGap {
  id: string
  expiredAt: number
  restoredAt?: number
  /** 掉线期间未送达的主动推送条数（不含对话回复） */
  missedPushes: number
  alertedAt?: number
  alertError?: string
  webhook?: { expired?: WebhookAttempt; restored?: WebhookAttempt }
}

const MINUTE_MS = 60_000

const CLOCK = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
})

/** 面板与微信文案统一按北京时间显示，不受宿主机时区影响。 */
export function formatClock(at: number): string {
  return CLOCK.format(new Date(at)).replace(/[\/.]/g, '-')
}

export function formatGap(elapsedMs: number): string {
  const ms = Math.max(0, elapsedMs)
  if (ms < MINUTE_MS) return `${Math.round(ms / 1000)} 秒`
  const minutes = Math.round(ms / MINUTE_MS)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

/**
 * Count proactive pushes (notifications, scheduled tasks, webhooks) that failed
 * inside the outage window. Chat replies are excluded: while the session is
 * dead there is no inbound message at all, so a reply failure recorded in that
 * window came from a different cause.
 */
export function countMissedPushes(logs: NotificationLog[], from: number, to: number): number {
  return logs.filter((entry) =>
    entry.status === 'failed'
    && entry.source !== 'reply'
    && entry.ruleId !== SESSION_ALERT_RULE_ID
    && entry.timestamp >= from
    && entry.timestamp <= to,
  ).length
}

export function buildSessionAlertText(gap: Pick<SessionGap, 'expiredAt' | 'restoredAt' | 'missedPushes'>): string {
  const restoredAt = gap.restoredAt ?? gap.expiredAt
  const lines = [
    `⚠️ 微信连接于 ${formatClock(gap.expiredAt)} 失效（token/session 过期），${formatClock(restoredAt)} 重新登录恢复，离线 ${formatGap(restoredAt - gap.expiredAt)}。`,
  ]
  if (gap.missedPushes > 0) {
    lines.push(`期间 ${gap.missedPushes} 条主动推送未能送达，明细见管理面板「通知 → 发送记录」。`)
  } else {
    lines.push('期间没有主动推送任务，无消息丢失。')
  }
  return lines.join('\n')
}

export interface SessionWebhookEvent {
  kind: 'expired' | 'restored'
  /** 事件发生时刻（毫秒） */
  at: number
  /** restored 事件才带：离线时长与漏推条数 */
  offlineMs?: number
  missedPushes?: number
}

export function buildWebhookText(event: SessionWebhookEvent): string {
  if (event.kind === 'expired') {
    return [
      `🚨 微信连接于 ${formatClock(event.at)} 失效（token/session 过期），需要重新扫码登录。`,
      '在恢复之前，所有通知与定时任务的主动推送都会失败。',
    ].join('\n')
  }
  const offline = formatGap(event.offlineMs ?? 0)
  const missed = (event.missedPushes ?? 0) > 0
    ? `期间 ${event.missedPushes} 条主动推送未送达。`
    : '期间没有主动推送丢失。'
  return `✅ 微信连接已于 ${formatClock(event.at)} 恢复，离线 ${offline}。${missed}`
}

/**
 * 群机器人只吃 `{msgtype,text:{content}}`，自建接收端想要可路由的字段；
 * 两种形状都在这里定型，服务层只负责发送。
 */
export function buildWebhookPayload(
  format: SessionWebhookFormat,
  event: SessionWebhookEvent,
): Record<string, unknown> {
  const text = buildWebhookText(event)
  if (format === 'text') return { msgtype: 'text', text: { content: text } }
  return {
    source: 'weclawbot-bridge',
    event: event.kind === 'expired' ? 'wechat_session_expired' : 'wechat_session_restored',
    at: event.at,
    text,
    clock: formatClock(event.at),
    ...(event.kind === 'restored'
      ? { offlineMs: event.offlineMs ?? 0, missedPushes: event.missedPushes ?? 0 }
      : {}),
  }
}

/** 只接受 http(s)；群机器人 URL 的 query 里带 token，日志一律脱敏。 */
export function normalizeWebhookUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  const url = rawUrl.trim()
  if (!url) return { ok: false, error: '未配置 webhook 地址' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'webhook 地址无法解析' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `webhook 地址只支持 http/https，收到 ${parsed.protocol}` }
  }
  return { ok: true, url: parsed.toString() }
}

export function maskWebhookUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '无效的 webhook 地址'
  }
}

/**
 * 群机器人即使业务失败也回 200，真正的错误码在响应体里；只看 HTTP 状态会把
 * 「没送达」当成成功。非 2xx、或 body 里 errcode/err_code/code 非 0 都算失败。
 */
export function interpretWebhookResponse(status: number, body: string): { ok: true } | { ok: false; error: string } {
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` }
  const trimmed = body.trim()
  if (!trimmed) return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: true }  // 非 JSON 响应体：状态码已说明问题，不额外猜
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: true }
  const record = parsed as Record<string, unknown>
  const code = record.errcode ?? record.err_code ?? record.code
  if (typeof code === 'number' && code !== 0) {
    const detail = String(record.errmsg ?? record.message ?? '').slice(0, 120)
    return { ok: false, error: detail ? `errcode=${code} ${detail}` : `errcode=${code}` }
  }
  return { ok: true }
}
