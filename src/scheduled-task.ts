/**
 * 定时任务的纯逻辑：语义校验与「下一次执行时刻」计算。
 *
 * 这里不持有任何定时器，也不读写 Storage —— 实际调度在 ScheduledTaskService，
 * 拆开后既能脱离微信/Agent 单测，也让 cron 时区规则只有一处定义。
 */
import { createTask, validateDetailed } from 'node-cron'
import type { ScheduledTask } from './types'
import { ScheduledTaskSchema, type ScheduledTaskInput } from './schemas'

export const DEFAULT_TASK_TIMEZONE = 'Asia/Shanghai'
/** 服务停机/事件循环卡顿期间，错过超过这个窗口的执行点不再补跑。 */
export const CATCH_UP_GRACE_MS = 15 * 60 * 1000
const MINUTE_MS = 60_000

/** 校验时：可解析的 kind/source 组合约束以外的字段由 zod 负责 */
export type ScheduledTaskDraft = Pick<
  ScheduledTask,
  | 'id' | 'name' | 'enabled' | 'kind' | 'runAt' | 'everyMinutes' | 'schedule'
  | 'timezone' | 'source' | 'text' | 'agentId' | 'prompt' | 'userId'
>

interface AgentLookup {
  get(id: string): unknown
}

interface ValidateOptions {
  agents: AgentLookup
  now: number
  /** 新建时拒绝已经过去的 runAt；编辑既有任务时不以此判死 */
  isCreate: boolean
}

export type ValidationResult =
  | { ok: true; data: ScheduledTaskDraft }
  | { ok: false; error: string }

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** 返回人类可读的错误信息；合法时为 null。 */
export function cronScheduleError(schedule: string): string | null {
  const result = validateDetailed(schedule)
  if (result.valid) return null
  const first = result.errors[0]
  return `Cron 表达式无效：${first?.message ?? schedule}（需要 5 或 6 段，例如 "0 9 * * 1-5"）`
}

interface CronTimeMatcher {
  getNextMatch(from: Date): Date | null
}

/**
 * node-cron 的公开 API 只有 `getNextRuns(count)`，它固定从「现在」往后算，
 * 无法接受基准时刻；因此优先取内部的 timeMatcher，取不到再回退公开 API。
 */
function nextMatchFrom(task: ReturnType<typeof createTask>, from: number): Date | null {
  const matcher = (task as unknown as { timeMatcher?: CronTimeMatcher }).timeMatcher
  if (matcher && typeof matcher.getNextMatch === 'function') {
    return matcher.getNextMatch(new Date(from))
  }
  const [next] = task.getNextRuns(1)
  return next ?? null
}

/** 从 `from` 时刻之后的一次 cron 触发时刻；表达式或时区非法时返回 null。 */
export function nextCronRunAt(schedule: string, timezone: string, from: number = Date.now()): number | null {
  const trimmed = schedule.trim()
  if (!trimmed || cronScheduleError(trimmed) || !isValidTimezone(timezone)) return null
  let task: ReturnType<typeof createTask> | null = null
  try {
    task = createTask(trimmed, () => {}, { timezone })
    const next = nextMatchFrom(task, from)
    return next ? next.getTime() : null
  } catch {
    return null
  } finally {
    void task?.destroy()
  }
}

/** 任务下一次应执行的时刻；已停用或不再有下次时为 null。 */
export function computeNextRunAt(task: ScheduledTask, now: number): number | null {
  if (!task.enabled) return null
  switch (task.kind) {
    case 'once':
      return task.runCount > 0 ? null : (task.runAt ?? null)
    case 'interval': {
      const every = (task.everyMinutes ?? 1) * MINUTE_MS
      return (task.lastRunAt ?? task.createdAt) + every
    }
    case 'cron':
      return nextCronRunAt(task.schedule ?? '', task.timezone ?? DEFAULT_TASK_TIMEZONE, now)
  }
}

export function describeKind(kind: ScheduledTask['kind']): string {
  return kind === 'once' ? '一次性' : kind === 'interval' ? '固定间隔' : 'Cron 表达式'
}

/** 结构 + 语义校验，产出可直接落库的任务草稿。 */
export function validateScheduledTask(input: unknown, opts: ValidateOptions): ValidationResult {
  const parsed = ScheduledTaskSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, error: first?.message || '任务配置校验失败' }
  }

  const raw = parsed.data as ScheduledTaskInput
  const draft: ScheduledTaskDraft = {
    id: raw.id,
    name: raw.name.trim(),
    enabled: raw.enabled !== false,
    kind: raw.kind,
    source: raw.source,
  }
  if (raw.userId?.trim()) draft.userId = raw.userId.trim()

  if (raw.kind === 'once') {
    if (!raw.runAt) return { ok: false, error: '一次性任务必须指定执行时间' }
    if (opts.isCreate && raw.runAt <= opts.now) {
      return { ok: false, error: '一次性任务的执行时间必须晚于当前时间' }
    }
    draft.runAt = raw.runAt
  }

  if (raw.kind === 'interval') {
    if (!raw.everyMinutes) return { ok: false, error: '间隔任务必须指定间隔分钟数' }
    draft.everyMinutes = raw.everyMinutes
  }

  if (raw.kind === 'cron') {
    const schedule = raw.schedule?.trim() ?? ''
    if (!schedule) return { ok: false, error: 'Cron 任务必须填写表达式' }
    const scheduleError = cronScheduleError(schedule)
    if (scheduleError) return { ok: false, error: scheduleError }
    const timezone = raw.timezone?.trim() || DEFAULT_TASK_TIMEZONE
    if (!isValidTimezone(timezone)) return { ok: false, error: `时区 "${timezone}" 无法识别，请使用 IANA 名称（如 Asia/Shanghai）` }
    if (nextCronRunAt(schedule, timezone, opts.now) === null) {
      return { ok: false, error: '该 Cron 表达式在未来一年内没有触发点' }
    }
    draft.schedule = schedule
    draft.timezone = timezone
  }

  if (raw.source === 'text') {
    const text = raw.text?.trim() ?? ''
    if (!text) return { ok: false, error: '请填写要推送的文本内容' }
    draft.text = text
  } else {
    const agentId = raw.agentId?.trim() ?? ''
    if (!agentId) return { ok: false, error: '请选择到点调用的 Agent' }
    if (!opts.agents.get(agentId)) return { ok: false, error: `Agent "${agentId}" 不存在，请先在 Agent 管理里创建` }
    const prompt = raw.prompt?.trim() ?? ''
    if (!prompt) return { ok: false, error: '请填写要问 Agent 的内容' }
    draft.agentId = agentId
    draft.prompt = prompt
  }

  if (!draft.name) return { ok: false, error: '请输入任务名称' }

  return { ok: true, data: draft }
}
