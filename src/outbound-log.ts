import { randomUUID } from 'node:crypto'
import type { NotificationLog, SendContent, SendLogContent, SendLogSource, Storage } from './types'
import { sendFailureCounter } from './metrics'
import { createLogger } from './logger'

const log = createLogger('outbound-log')

const LOG_PREFIX = 'notify:log:'
const MAX_TEXT_PREVIEW = 200

/**
 * Reduce a SendContent to something worth persisting: text preview plus a media
 * descriptor. Buffers must never reach storage — one image would write a
 * several-MB JSON array into the gateway state file.
 */
export function summarizeContent(content: SendContent): SendLogContent {
  const summary: SendLogContent = {}
  const text = content.text ?? content.caption
  if (text) summary.text = text.slice(0, MAX_TEXT_PREVIEW)

  if (content.image) {
    summary.media = { kind: 'image', bytes: content.image.length }
  } else if (content.video) {
    summary.media = { kind: 'video', bytes: content.video.length }
  } else if (content.file) {
    summary.media = { kind: 'file', fileName: content.file.fileName, bytes: content.file.data.length }
  }
  return summary
}

export interface SendLogInput {
  source: SendLogSource
  userId: string
  content: SendContent
  status: 'success' | 'failed'
  error?: string
  /** 通知规则 ID 或 `task:{id}` / `agent:{id}` */
  ruleId?: string
  /** 触发本轮发送的用户消息，仅对话回复路径传 */
  trigger?: string
}

/**
 * One store for every outbound attempt (notifications, scheduled tasks, chat
 * replies). Recording is best-effort: a logging failure must not turn a
 * successfully sent message into a reported error.
 */
export class OutboundLog {
  constructor(private readonly storage: Storage) {}

  async record(input: SendLogInput): Promise<NotificationLog> {
    const entry: NotificationLog = {
      id: randomUUID(),
      source: input.source,
      userId: input.userId,
      content: summarizeContent(input.content),
      status: input.status,
      timestamp: Date.now(),
    }
    if (input.error) entry.error = input.error
    if (input.ruleId) entry.ruleId = input.ruleId
    if (input.trigger) entry.trigger = input.trigger.slice(0, MAX_TEXT_PREVIEW)

    if (input.status === 'failed') {
      sendFailureCounter.inc({ source: input.source })
      log.warn(
        { source: input.source, userId: input.userId, err: input.error, ruleId: input.ruleId },
        '出站发送失败',
      )
    }

    try {
      await this.storage.set(`${LOG_PREFIX}${entry.id}`, entry)
    } catch (err) {
      log.error({ err: (err as Error).message, logId: entry.id }, '发送记录写入失败')
    }
    return entry
  }

  async list(): Promise<NotificationLog[]> {
    const keys = await this.storage.listKeys(LOG_PREFIX)
    const logs: NotificationLog[] = []
    for (const key of keys) {
      const entry = await this.storage.get<NotificationLog>(key)
      if (!entry) continue
      logs.push({ ...entry, source: entry.source ?? 'notify' })
    }
    logs.sort((a, b) => b.timestamp - a.timestamp)
    return logs
  }
}
