import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import type { Storage, NotificationRule, NotificationLog, SendContent, SendLogSource } from './types'
import type { BotManager } from './bot-manager'
import type { OutboundLog } from './outbound-log'
import { NoContextError } from '@wechatbot/wechatbot'
import { createLogger } from './logger'

const log = createLogger('notification')

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]
const NOTIFICATION_RULES_KEY = 'config:notification_rules'

export class NotificationService {
  private botManager: BotManager
  private storage: Storage
  private outboundLog: OutboundLog
  private rules: Map<string, NotificationRule> = new Map()
  private cronJobs: Map<string, ScheduledTask> = new Map()
  private eventHandlers: Map<string, () => Promise<void>> = new Map()

  constructor(botManager: BotManager, storage: Storage, outboundLog: OutboundLog) {
    this.botManager = botManager
    this.storage = storage
    this.outboundLog = outboundLog
  }

  private resolveRecipient(userId?: string): string {
    if (userId) return userId
    const status = this.botManager.getStatus()
    if (status.loggedIn && status.currentUser) return status.currentUser
    throw new Error('Bot 未登录，无法发送通知')
  }

  async send(userId: string | undefined, content: SendContent, sourceId?: string): Promise<void> {
    const recipient = this.resolveRecipient(userId)
    // 定时任务服务用 `task:{id}` 作为 sourceId 传进来，据此区分记录来源。
    const source: SendLogSource = sourceId?.startsWith('task:') ? 'task' : 'notify'

    let lastError: Error | undefined

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.botManager.send(recipient, content)
        await this.outboundLog.record({ source, userId: recipient, content, status: 'success', ruleId: sourceId })
        return
      } catch (err) {
        lastError = err as Error
        const error = err as Error
        // 无 context_token 时重试无意义 — 直接失败
        if (err instanceof NoContextError) {
          await this.outboundLog.record({ source, userId: recipient, content, status: 'failed', error: error.message, ruleId: sourceId })
          log.warn({ recipient, err: error.message }, 'No context_token — send failed (not retrying)')
          throw err
        }

        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]))
        }
      }
    }

    await this.outboundLog.record({
      source,
      userId: recipient,
      content,
      status: 'failed',
      error: lastError?.message ?? '发送失败',
      ruleId: sourceId,
    })
    if (lastError) throw lastError
  }

  /** Load durable notification rules before starting the scheduler. */
  async loadRules(): Promise<void> {
    const rules = await this.storage.get<NotificationRule[]>(NOTIFICATION_RULES_KEY)
    if (Array.isArray(rules)) {
      await this.replaceAllRules(rules, false)
    }
  }

  private async persistRules(): Promise<void> {
    await this.storage.set(NOTIFICATION_RULES_KEY, this.listRules())
  }

  async addRule(rule: NotificationRule): Promise<void> {
    this.removeRuleInMemory(rule.id)
    this.rules.set(rule.id, rule)

    if (rule.type === 'cron' && rule.schedule) {
      this.startCronJob(rule)
    }
    if (rule.type === 'event' && rule.event) {
      this.eventHandlers.set(rule.event, async () => {
        try {
          await this.send(rule.userId, rule.content)
        } catch (err) {
          log.error({ ruleId: rule.id, event: rule.event, err: (err as Error).message }, 'Event notification failed')
        }
      })
    }
    await this.persistRules()
  }

  private removeRuleInMemory(id: string): void {
    const rule = this.rules.get(id)
    if (!rule) return
    if (rule.type === 'cron') {
      const job = this.cronJobs.get(id)
      if (job) {
        job.stop()
        this.cronJobs.delete(id)
      }
    }
    if (rule.type === 'event' && rule.event) this.eventHandlers.delete(rule.event)
    this.rules.delete(id)
  }

  async removeRule(id: string): Promise<void> {
    this.removeRuleInMemory(id)
    await this.persistRules()
  }

  private startCronJob(rule: NotificationRule): void {
    if (!rule.schedule) return

    // 验证 cron 表达式合法性
    try {
      cron.validate(rule.schedule)
    } catch (err) {
      log.error({ ruleId: rule.id, schedule: rule.schedule, err: (err as Error).message }, 'Invalid cron schedule')
      return
    }

    const existing = this.cronJobs.get(rule.id)
    if (existing) {
      existing.stop()
    }

    const job = cron.schedule(rule.schedule, async () => {
      try {
        await this.send(rule.userId, rule.content)
      } catch (err) {
        log.error({ ruleId: rule.id, err: (err as Error).message }, 'Scheduled notification failed')
      }
    })

    this.cronJobs.set(rule.id, job)
  }

  startScheduler(): void {
    for (const rule of this.rules.values()) {
      if (rule.type === 'cron' && rule.schedule) {
        this.startCronJob(rule)
      }
    }
  }

  stopScheduler(): void {
    for (const job of this.cronJobs.values()) {
      job.stop()
    }
    this.cronJobs.clear()
  }

  /** 列出所有通知规则（用于备份导出） */
  listRules(): NotificationRule[] {
    return Array.from(this.rules.values())
  }

  /** Replace all rules; optionally persist the new collection. */
  async replaceAllRules(rules: NotificationRule[], persist: boolean = true): Promise<void> {
    for (const rule of Array.from(this.rules.values())) {
      this.removeRuleInMemory(rule.id)
    }
    for (const rule of rules) {
      this.rules.set(rule.id, rule)
      if (rule.type === 'cron' && rule.schedule) this.startCronJob(rule)
      if (rule.type === 'event' && rule.event) {
        this.eventHandlers.set(rule.event, async () => {
          try {
            await this.send(rule.userId, rule.content)
          } catch (err) {
            log.error({ ruleId: rule.id, event: rule.event, err: (err as Error).message }, 'Event notification failed')
          }
        })
      }
    }
    if (persist) await this.persistRules()
  }

  async getNotificationLogs(): Promise<NotificationLog[]> {
    return this.outboundLog.list()
  }
}
