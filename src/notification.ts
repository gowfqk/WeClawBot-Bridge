import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import type { Storage, NotificationRule, NotificationLog, SendContent } from './types'
import type { BotManager } from './bot-manager'
import { NoContextError } from '@wechatbot/wechatbot'
import crypto from 'node:crypto'
import { createLogger } from './logger'

const log = createLogger('notification')

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]
const NOTIFICATION_RULES_KEY = 'config:notification_rules'

export class NotificationService {
  private botManager: BotManager
  private storage: Storage
  private rules: Map<string, NotificationRule> = new Map()
  private cronJobs: Map<string, ScheduledTask> = new Map()
  private eventHandlers: Map<string, () => Promise<void>> = new Map()

  constructor(botManager: BotManager, storage: Storage) {
    this.botManager = botManager
    this.storage = storage
  }

  private resolveRecipient(userId?: string): string {
    if (userId) return userId
    const status = this.botManager.getStatus()
    if (status.loggedIn && status.currentUser) return status.currentUser
    throw new Error('Bot 未登录，无法发送通知')
  }

  async send(userId: string | undefined, content: SendContent): Promise<void> {
    const recipient = this.resolveRecipient(userId)
    const logId = crypto.randomUUID()
    const logEntry: NotificationLog = {
      id: logId,
      userId: recipient,
      content,
      status: 'success',
      timestamp: Date.now(),
    }

    let lastError: Error | undefined

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.botManager.send(recipient, content)
        logEntry.status = 'success'
        delete logEntry.error
        await this.storage.set(`notify:log:${logId}`, logEntry)
        return
      } catch (err) {
        lastError = err as Error
        logEntry.status = 'failed'
        logEntry.error = (err as Error).message
        await this.storage.set(`notify:log:${logId}`, logEntry)

        // 无 context_token 时重试无意义 — 直接失败
        if (err instanceof NoContextError) {
          log.warn({ recipient, err: (err as Error).message }, 'No context_token — send failed (not retrying)')
          throw err
        }

        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]))
        }
      }
    }

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
      this.eventHandlers.set(rule.event, async () => this.send(rule.userId, rule.content))
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
      await this.send(rule.userId, rule.content)
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
        this.eventHandlers.set(rule.event, async () => this.send(rule.userId, rule.content))
      }
    }
    if (persist) await this.persistRules()
  }

  async getNotificationLogs(): Promise<NotificationLog[]> {
    const keys = await this.storage.listKeys('notify:log:')
    const logs: NotificationLog[] = []
    for (const key of keys) {
      const log = await this.storage.get<NotificationLog>(key)
      if (log) logs.push(log)
    }
    // 按时间倒序排列，最新的在前
    logs.sort((a, b) => b.timestamp - a.timestamp)
    return logs
  }
}
