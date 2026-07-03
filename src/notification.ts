import cron from 'node-cron'
import type { Storage, NotificationRule, NotificationLog, SendContent } from './types'
import type { BotManager } from './bot-manager'
import crypto from 'node:crypto'

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]

export class NotificationService {
  private botManager: BotManager
  private storage: Storage
  private rules: Map<string, NotificationRule> = new Map()
  private cronJobs: Map<string, cron.ScheduledTask> = new Map()
  private eventHandlers: Map<string, () => Promise<void>> = new Map()

  constructor(botManager: BotManager, storage: Storage) {
    this.botManager = botManager
    this.storage = storage
  }

  async send(userId: string, content: SendContent): Promise<void> {
    const logId = crypto.randomUUID()
    const log: NotificationLog = {
      id: logId,
      userId,
      content,
      status: 'success',
      timestamp: Date.now(),
    }

    let lastError: Error | undefined

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.botManager.send(userId, content)
        log.status = 'success'
        delete log.error
        await this.storage.set(`notify:log:${logId}`, log)
        return
      } catch (err) {
        lastError = err as Error
        log.status = 'failed'
        log.error = (err as Error).message
        await this.storage.set(`notify:log:${logId}`, log)

        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]))
        }
      }
    }

    if (lastError) throw lastError
  }

  addRule(rule: NotificationRule): void {
    this.rules.set(rule.id, rule)

    if (rule.type === 'cron' && rule.schedule) {
      this.startCronJob(rule)
    }

    if (rule.type === 'event' && rule.event) {
      const handler = async () => {
        await this.send(rule.userId, rule.content)
      }
      this.eventHandlers.set(rule.event, handler)
    }
  }

  removeRule(id: string): void {
    const rule = this.rules.get(id)
    if (!rule) return

    if (rule.type === 'cron') {
      const job = this.cronJobs.get(id)
      if (job) {
        job.stop()
        this.cronJobs.delete(id)
      }
    }

    if (rule.type === 'event' && rule.event) {
      this.eventHandlers.delete(rule.event)
    }

    this.rules.delete(id)
  }

  private startCronJob(rule: NotificationRule): void {
    if (!rule.schedule) return

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

  async getNotificationLogs(): Promise<NotificationLog[]> {
    const logs: NotificationLog[] = []
    // FileStorage doesn't support key scanning, so this is limited.
    // For production, use a proper DB-backed storage.
    return logs
  }
}
