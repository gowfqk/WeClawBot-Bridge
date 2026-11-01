import { randomUUID } from 'node:crypto'
import type { NotificationLog, SendContent, Storage } from './types'
import type { SessionEventKind } from './bot-manager'
import type { SendLogInput } from './outbound-log'
import {
  DEFAULT_SESSION_ALERT_SETTINGS,
  SESSION_ALERT_RULE_ID,
  buildSessionAlertText,
  buildWebhookPayload,
  countMissedPushes,
  formatGap,
  interpretWebhookResponse,
  maskWebhookUrl,
  normalizeWebhookUrl,
  type SessionAlertSettings,
  type SessionGap,
  type SessionWebhookEvent,
  type WebhookAttempt,
} from './session-alert'
import { sessionExpiredCounter, sessionWebhookCounter } from './metrics'
import { createLogger } from './logger'

const log = createLogger('session-alert')

const SETTINGS_KEY = 'config:session_alert'
const GAPS_KEY = 'config:session_alert_gaps'
const MAX_GAPS = 20
const WEBHOOK_ATTEMPTS = 2
const WEBHOOK_TIMEOUT_MS = 8_000
const WEBHOOK_RETRY_DELAY_MS = 1_000

interface SessionAlertBot {
  onSessionEvent(listener: (kind: SessionEventKind) => void): void
  onMessage(handler: (msg: { userId: string; text: string; type: string; hasMedia: boolean; raw: unknown }) => Promise<void>): void
  sendReply(raw: unknown, content: SendContent): Promise<void>
}

interface OutboundLogView {
  list(): Promise<NotificationLog[]>
  record(input: SendLogInput): Promise<NotificationLog>
}

/** 只用于测试注入，生产走全局 fetch。 */
export type WebhookFetch = (url: string, init: RequestInit) => Promise<{ status: number; text(): Promise<string> }>

export interface SessionAlertState {
  settings: SessionAlertSettings
  gaps: SessionGap[]
  /** 已经恢复、但还没找到可用的 context_token 来补发提醒 */
  pendingAlert: SessionGap | null
  /** 非空表示当前正处于掉线窗口，等待重新扫码 */
  outageStartedAt: number | null
  /** 本次掉线的 webhook 结果；恢复后并入掉线记录 */
  outageWebhook?: WebhookAttempt
}

/**
 * 微信 token/session 过期提醒。
 *
 * 过期那一刻 SDK 会清空全部 context_token，微信通道本身就是死的，所以分两条腿：
 * 出站 webhook 立即通知外部（唯一能实时送达的路径），微信侧只能等恢复后
 * 借第一条进来的消息补发。
 */
export class SessionAlertService {
  private settings: SessionAlertSettings = { ...DEFAULT_SESSION_ALERT_SETTINGS }
  private gaps: SessionGap[] = []
  private outage: { startedAt: number; webhook?: WebhookAttempt; webhookDelivery?: Promise<void> } | null = null
  private pendingAlert: SessionGap | null = null
  private alertInFlight = false

  constructor(
    private readonly bot: SessionAlertBot,
    private readonly storage: Storage,
    private readonly outboundLog: OutboundLogView,
    private readonly fetchImpl: WebhookFetch = (url, init) => fetch(url, init) as unknown as Promise<{ status: number; text(): Promise<string> }>,
  ) {}

  async load(): Promise<void> {
    const settings = await this.storage.get<Partial<SessionAlertSettings>>(SETTINGS_KEY)
    if (settings && typeof settings === 'object') {
      this.settings = {
        recordEnabled: settings.recordEnabled !== false,
        pushEnabled: settings.pushEnabled !== false,
        webhookEnabled: settings.webhookEnabled === true,
        webhookUrl: typeof settings.webhookUrl === 'string' ? settings.webhookUrl : '',
        webhookFormat: settings.webhookFormat === 'text' ? 'text' : 'json',
      }
    }
    const gaps = await this.storage.get<SessionGap[]>(GAPS_KEY)
    if (Array.isArray(gaps)) this.gaps = gaps.filter((gap) => typeof gap?.expiredAt === 'number')
  }

  /** 订阅 Bot 事件；调用一次即可，重复调用会注册多个监听器。 */
  start(): void {
    this.bot.onSessionEvent((kind) => { void this.onSessionEvent(kind) })
    this.bot.onMessage(async (msg) => { await this.deliverPendingAlert(msg.raw, msg.userId) })
  }

  getState(): SessionAlertState {
    return {
      settings: { ...this.settings },
      gaps: this.gaps.map((gap) => ({ ...gap })),
      pendingAlert: this.pendingAlert ? { ...this.pendingAlert } : null,
      outageStartedAt: this.outage?.startedAt ?? null,
      ...(this.outage?.webhook ? { outageWebhook: { ...this.outage.webhook } } : {}),
    }
  }

  async saveSettings(patch: Partial<SessionAlertSettings>): Promise<SessionAlertSettings> {
    this.settings = {
      ...this.settings,
      ...(patch.recordEnabled !== undefined ? { recordEnabled: patch.recordEnabled } : {}),
      ...(patch.pushEnabled !== undefined ? { pushEnabled: patch.pushEnabled } : {}),
      ...(patch.webhookEnabled !== undefined ? { webhookEnabled: patch.webhookEnabled } : {}),
      ...(patch.webhookUrl !== undefined ? { webhookUrl: patch.webhookUrl.trim() } : {}),
      ...(patch.webhookFormat !== undefined ? { webhookFormat: patch.webhookFormat } : {}),
    }
    if (!this.settings.pushEnabled) this.pendingAlert = null
    try {
      await this.storage.set(SETTINGS_KEY, this.settings)
    } catch (err) {
      log.error({ err: (err as Error).message }, '提醒设置写入失败')
    }
    return { ...this.settings }
  }

  private async onSessionEvent(kind: SessionEventKind): Promise<void> {
    if (kind === 'expired') {
      if (this.outage) return
      this.outage = { startedAt: Date.now() }
      sessionExpiredCounter.inc()
      log.warn('微信 session 过期 — 主动推送在重新登录前全部会失败')

      const delivery = this.postWebhook({ kind: 'expired', at: this.outage.startedAt })
        .then((attempt) => { if (this.outage) this.outage.webhook = attempt })
      this.outage.webhookDelivery = delivery
      await delivery
      return
    }

    const outage = this.outage
    this.outage = null
    // 首次登录或解绑后重新绑定：没有掉线窗口，不打扰用户。
    if (!outage) return

    // 过期的 webhook 可能还在重试，等它落定再拼记录，避免结果丢失。
    await outage.webhookDelivery
    const restoredAt = Date.now()
    const logs = await this.outboundLog.list().catch((err) => {
      log.warn({ err: (err as Error).message }, '读取发送记录失败，漏推计数按 0 处理')
      return [] as NotificationLog[]
    })
    const gap: SessionGap = {
      id: randomUUID(),
      expiredAt: outage.startedAt,
      restoredAt,
      missedPushes: countMissedPushes(logs, outage.startedAt, restoredAt),
      webhook: outage.webhook ? { expired: outage.webhook } : undefined,
    }
    log.warn(
      { offline: formatGap(restoredAt - outage.startedAt), missedPushes: gap.missedPushes },
      '微信 session 已恢复',
    )

    if (this.settings.recordEnabled) await this.persistGap(gap)

    const restoredAttempt = await this.postWebhook({
      kind: 'restored',
      at: restoredAt,
      offlineMs: restoredAt - gap.expiredAt,
      missedPushes: gap.missedPushes,
    })
    if (restoredAttempt) {
      gap.webhook = { ...gap.webhook, restored: restoredAttempt }
      await this.persistGapUpdate(gap)
    }

    if (this.settings.pushEnabled) this.pendingAlert = gap
  }

  private async persistGap(gap: SessionGap): Promise<void> {
    this.gaps = [gap, ...this.gaps].slice(0, MAX_GAPS)
    await this.persistGapUpdate(gap)
  }

  private async persistGapUpdate(gap: SessionGap): Promise<void> {
    if (!this.settings.recordEnabled || !this.gaps.includes(gap)) return
    try {
      await this.storage.set(GAPS_KEY, this.gaps)
    } catch (err) {
      log.error({ err: (err as Error).message }, '掉线记录写入失败')
    }
  }

  /** 借刚进来的这条消息的 context_token 补发提醒；失败则等下一条消息再试。 */
  private async deliverPendingAlert(raw: unknown, userId: string): Promise<void> {
    const gap = this.pendingAlert
    if (!gap || this.alertInFlight) return
    this.pendingAlert = null
    this.alertInFlight = true

    const content: SendContent = { text: buildSessionAlertText(gap) }
    let error: string | undefined
    try {
      await this.bot.sendReply(raw, content)
      gap.alertedAt = Date.now()
      log.info({ userId, offline: formatGap((gap.restoredAt ?? Date.now()) - gap.expiredAt) }, '掉线提醒已补发')
    } catch (err) {
      error = (err as Error).message
      gap.alertError = error
      log.warn({ err: error }, '掉线提醒补发失败，将在下一条来消息时重试')
      if (this.settings.pushEnabled) this.pendingAlert = gap
    } finally {
      this.alertInFlight = false
    }

    await this.outboundLog.record({
      source: 'notify',
      userId,
      content,
      status: error ? 'failed' : 'success',
      ruleId: SESSION_ALERT_RULE_ID,
      ...(error ? { error } : {}),
    }).catch(() => undefined)

    await this.persistGapUpdate(gap)
  }

  /**
   * 尽力推送，失败不抛：提醒通道挂了不能连带影响掉线记录与微信补发。
   * 未启用时返回 undefined —— 面板据此显示「未启用」而不是「失败」。
   */
  private async postWebhook(event: SessionWebhookEvent): Promise<WebhookAttempt | undefined> {
    if (!this.settings.webhookEnabled) return undefined

    const target = normalizeWebhookUrl(this.settings.webhookUrl)
    if (!target.ok) {
      log.warn({ err: target.error }, '掉线提醒 webhook 地址不可用，本次未推送')
      sessionWebhookCounter.inc({ status: 'failed' })
      return { status: 'failed', error: target.error }
    }

    const body = JSON.stringify(buildWebhookPayload(this.settings.webhookFormat, event))
    let lastError = '推送失败'

    for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchImpl(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        })
        const result = interpretWebhookResponse(response.status, await response.text())
        if (result.ok) {
          sessionWebhookCounter.inc({ status: 'sent' })
          log.info({ url: maskWebhookUrl(target.url), event: event.kind }, '掉线提醒 webhook 已推送')
          return { status: 'sent' }
        }
        lastError = result.error
      } catch (err) {
        lastError = (err as Error).message
      }
      if (attempt < WEBHOOK_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, WEBHOOK_RETRY_DELAY_MS))
    }

    sessionWebhookCounter.inc({ status: 'failed' })
    log.warn({ url: maskWebhookUrl(target.url), event: event.kind, err: lastError }, '掉线提醒 webhook 推送失败')
    return { status: 'failed', error: lastError }
  }
}
