import cron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import type { Storage, NotificationRule, NotificationLog, SendContent } from './types'
import type { BotManager } from './bot-manager'
import crypto from 'node:crypto'
import { createLogger } from './logger'

const log = createLogger('notification')

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]

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

  /** 批量替换通知规则（用于备份导入） */
  replaceAllRules(rules: NotificationRule[]): void {
    // 先清除现有规则
    for (const rule of this.rules.values()) {
      this.removeRule(rule.id)
    }
    // 添加新规则
    for (const rule of rules) {
      this.addRule(rule)
    }
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
