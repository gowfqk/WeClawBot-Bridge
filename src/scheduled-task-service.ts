/**
 * ScheduledTaskService — 独立于「通知规则」的定时任务模块。
 *
 * 单个 tick 循环统一驱动 once / interval / cron 三种调度：
 * 每个任务持久化自己的 nextRunAt，到点执行、执行后推进下一次。相比每个 cron
 * 任务各挂一个 node-cron 定时器，这样重启后 nextRunAt 可复原，面板也能直接展示
 * 「下次执行时间」，时区规则也只在 computeNextRunAt 一处。
 */
import type { AgentPayload, AgentResponse, ScheduledTask, SendContent, Storage } from './types'
import {
  CATCH_UP_GRACE_MS,
  computeNextRunAt,
  validateScheduledTask,
  type ScheduledTaskDraft,
} from './scheduled-task'
import { createLogger } from './logger'

const log = createLogger('scheduled-task')

const TASKS_STORAGE_KEY = 'scheduled-tasks'
const MINUTE_MS = 60_000

/** 只注入真正用到的能力，便于单测替换。 */
interface Notifier {
  send(userId: string | undefined, content: SendContent, sourceId?: string): Promise<void>
}

interface AgentGateway {
  get(id: string): unknown
  invoke(agentId: string, payload: AgentPayload): Promise<AgentResponse>
}

export type TaskMutationResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; error: string; status: 400 | 404 | 409 }

export interface ScheduledTaskServiceOptions {
  now?: () => number
  tickIntervalMs?: number
}

export class ScheduledTaskService {
  private tasks = new Map<string, ScheduledTask>()
  private inFlight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number
  private readonly tickIntervalMs: number

  constructor(
    private storage: Storage,
    private notifier: Notifier,
    private agents: AgentGateway,
    options: ScheduledTaskServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.tickIntervalMs = options.tickIntervalMs ?? 20_000
  }

  /** 启动时载入既有任务；nextRunAt 缺失的（历史数据或新载入）会被重新计算。 */
  async load(): Promise<void> {
    const stored = await this.storage.get<{ tasks?: unknown[] }>(TASKS_STORAGE_KEY)
    const list = Array.isArray(stored?.tasks) ? stored!.tasks : []
    this.tasks.clear()
    for (const item of list) {
      const task = item as Partial<ScheduledTask> | null
      if (!task || typeof task.id !== 'string' || !task.kind || !task.source) continue
      this.tasks.set(task.id, task as ScheduledTask)
    }

    const now = this.now()
    let changed = false
    for (const task of this.tasks.values()) {
      if (task.enabled && task.nextRunAt == null) {
        task.nextRunAt = computeNextRunAt(task, now)
        changed = true
      }
    }
    if (changed) await this.persist()
    log.info({ count: this.tasks.size }, '定时任务已载入')
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((err: Error) => {
        log.error({ err: err.message }, '定时任务 tick 异常')
      })
    }, this.tickIntervalMs)
    this.timer.unref?.()
    // 启动即跑一轮：把停机期间过期的任务尽快标记为 skipped 而不是堆积。
    void this.tick().catch((err: Error) => log.error({ err: err.message }, '启动时 tick 异常'))
    log.info({ intervalMs: this.tickIntervalMs }, '定时任务调度器已启动')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  list(): ScheduledTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => {
      const left = a.nextRunAt ?? Number.POSITIVE_INFINITY
      const right = b.nextRunAt ?? Number.POSITIVE_INFINITY
      if (left !== right) return left - right
      return a.createdAt - b.createdAt
    })
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id)
  }

  async create(input: unknown): Promise<TaskMutationResult> {
    const validation = validateScheduledTask(input, {
      agents: this.agents,
      now: this.now(),
      isCreate: true,
    })
    if (!validation.ok) return { ok: false, error: validation.error, status: 400 }
    if (this.tasks.has(validation.data.id)) {
      return { ok: false, error: `任务 ID "${validation.data.id}" 已存在`, status: 409 }
    }

    const task: ScheduledTask = {
      ...validation.data,
      createdAt: this.now(),
      runCount: 0,
      nextRunAt: null,
    }
    task.nextRunAt = computeNextRunAt(task, this.now())
    this.tasks.set(task.id, task)
    await this.persist()
    log.info({ taskId: task.id, kind: task.kind, nextRunAt: task.nextRunAt }, '定时任务已创建')
    return { ok: true, task }
  }

  async update(id: string, input: unknown): Promise<TaskMutationResult> {
    const existing = this.tasks.get(id)
    if (!existing) return { ok: false, error: '任务不存在', status: 404 }

    const validation = validateScheduledTask(input, {
      agents: this.agents,
      now: this.now(),
      isCreate: false,
    })
    if (!validation.ok) return { ok: false, error: validation.error, status: 400 }

    const draft: ScheduledTaskDraft = { ...validation.data, id }
    const rescheduled = existing.kind !== draft.kind
      || existing.runAt !== draft.runAt
      || existing.everyMinutes !== draft.everyMinutes
      || existing.schedule !== draft.schedule
      || existing.timezone !== draft.timezone

    const task: ScheduledTask = {
      ...existing,
      ...draft,
      // 一次性任务改了时间就允许重新触发一次。
      runCount: rescheduled && draft.kind === 'once' ? 0 : existing.runCount,
      createdAt: existing.createdAt,
      nextRunAt: null,
    }
    // 改了调度方式后，旧方式留下的字段不再有意义，清掉避免面板和导出里出现自相矛盾的配置。
    if (task.kind !== 'once') delete task.runAt
    if (task.kind !== 'interval') delete task.everyMinutes
    if (task.kind !== 'cron') {
      delete task.schedule
      delete task.timezone
    }
    if (task.source === 'text') {
      delete task.agentId
      delete task.prompt
    } else {
      delete task.text
    }
    task.nextRunAt = computeNextRunAt(task, this.now())
    this.tasks.set(id, task)
    await this.persist()
    log.info({ taskId: id, rescheduled, nextRunAt: task.nextRunAt }, '定时任务已更新')
    return { ok: true, task }
  }

  async remove(id: string): Promise<{ ok: boolean }> {
    const existed = this.tasks.delete(id)
    if (existed) {
      await this.persist()
      log.info({ taskId: id }, '定时任务已删除')
    }
    return { ok: existed }
  }

  /** 启用/停用。停用中的任务保留 nextRunAt=null，重新启用时按当前时刻重新推算。 */
  async setEnabled(id: string, enabled: boolean): Promise<TaskMutationResult> {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, error: '任务不存在', status: 404 }

    if (enabled && task.kind === 'once' && task.runCount > 0) {
      return { ok: false, error: '该一次性任务已经执行过，请修改执行时间后重试', status: 400 }
    }
    task.enabled = enabled
    task.nextRunAt = enabled ? computeNextRunAt(task, this.now()) : null
    this.tasks.set(id, task)
    await this.persist()
    return { ok: true, task }
  }

  /**
   * 立即执行一次（面板调试用）。除一次性任务外不推进排期：测一次不应该把每天
   * 9 点的任务改成「从现在起 9 点」。
   */
  async runNow(id: string): Promise<TaskMutationResult> {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, error: '任务不存在', status: 404 }
    if (this.inFlight.has(id)) return { ok: false, error: '该任务正在执行中，请稍候', status: 409 }

    const dueAt = task.nextRunAt ?? this.now()
    await this.runTask(task, dueAt, 'manual')
    const fresh = this.tasks.get(id)
    if (!fresh) return { ok: false, error: '任务在执行期间被删除', status: 404 }
    if (fresh.lastStatus === 'failed') {
      return { ok: false, error: fresh.lastError ?? '执行失败', status: 400 }
    }
    return { ok: true, task: fresh }
  }

  /** 推进所有到期任务。并发执行互不阻塞，但 await 到全部结束，方便测试与关停。 */
  async tick(): Promise<void> {
    const now = this.now()
    const pending: Promise<void>[] = []

    for (const task of Array.from(this.tasks.values())) {
      if (!task.enabled || this.inFlight.has(task.id)) continue

      if (task.nextRunAt == null) {
        const computed = computeNextRunAt(task, now)
        task.nextRunAt = computed
        if (computed == null) {
          // 算不出下次执行（配置已不可用），继续留着只会每轮重复落盘。
          task.enabled = false
          task.lastStatus = 'skipped'
          task.lastError = '无法计算下次执行时间（调度配置无效），任务已自动停用'
          log.warn({ taskId: task.id }, '定时任务无法计算下次执行时间，已停用')
        }
        await this.persist()
        continue
      }
      if (task.nextRunAt > now) continue

      const dueAt = task.nextRunAt
      if (now - dueAt > CATCH_UP_GRACE_MS) {
        this.markSkipped(task, dueAt, now)
        await this.persist()
        continue
      }
      pending.push(this.runTask(task, dueAt, 'scheduled'))
    }

    await Promise.all(pending)
  }

  // ===== 内部 =====

  private async runTask(task: ScheduledTask, dueAt: number, trigger: 'scheduled' | 'manual'): Promise<void> {
    this.inFlight.add(task.id)
    const startedAt = this.now()
    try {
      const content = await this.buildContent(task)
      await this.notifier.send(task.userId, content, `task:${task.id}`)
      this.record(task, trigger === 'manual' ? startedAt : dueAt, 'success')
      log.info({ taskId: task.id, trigger, chars: content.text?.length ?? 0 }, '定时任务已推送')
    } catch (err) {
      const message = (err as Error).message
      this.record(task, trigger === 'manual' ? startedAt : dueAt, 'failed', message)
      log.warn({ taskId: task.id, trigger, err: message }, '定时任务执行失败')
    } finally {
      this.inFlight.delete(task.id)
      // 手动试跑一次性任务也要把它关掉，否则到点还会再推一条。
      if (trigger === 'scheduled' || task.kind === 'once') {
        this.advance(task, dueAt)
      } else if (task.nextRunAt == null) {
        task.nextRunAt = computeNextRunAt(task, this.now())
      }
      if (this.tasks.has(task.id)) await this.persist()
    }
  }

  /** 到点执行后的排期推进。 */
  private advance(task: ScheduledTask, ranAt: number): void {
    const now = this.now()
    if (task.kind === 'once') {
      task.enabled = false
      task.nextRunAt = null
      return
    }
    if (task.kind === 'interval') {
      const every = (task.everyMinutes ?? 1) * MINUTE_MS
      const next = ranAt + every
      task.nextRunAt = next > now ? next : now + every
      return
    }
    task.nextRunAt = computeNextRunAt(task, now)
  }

  private markSkipped(task: ScheduledTask, dueAt: number, now: number): void {
    const minutes = Math.round(CATCH_UP_GRACE_MS / MINUTE_MS)
    task.lastStatus = 'skipped'
    task.lastError = `错过执行时间（${new Date(dueAt).toISOString()}），超出 ${minutes} 分钟宽限期，未补跑`
    this.advance(task, dueAt)
    log.warn({ taskId: task.id, dueAt, now }, '定时任务错过执行时间，跳过补跑')
  }

  private record(task: ScheduledTask, ranAt: number, status: 'success' | 'failed', error?: string): void {
    task.lastRunAt = ranAt
    task.lastStatus = status
    task.runCount += 1
    if (error) task.lastError = error
    else delete task.lastError
  }

  private async buildContent(task: ScheduledTask): Promise<SendContent> {
    if (task.source === 'text') {
      const text = task.text?.trim() ?? ''
      if (!text) throw new Error('任务文本为空')
      return { text }
    }

    const agentId = task.agentId
    if (!agentId) throw new Error('任务缺少 Agent ID')
    if (!this.agents.get(agentId)) throw new Error(`Agent "${agentId}" 已不存在，请重新选择`)

    // 每次用任务自己的隔离会话，且不带上任何历史：定时推送不应干扰用户与 Agent
    // 的微信对话上下文，也不该把昨天的内容滚进今天的提问里。
    const response = await this.agents.invoke(agentId, {
      message: { text: task.prompt ?? '', type: 'text' },
      session: { userId: `task:${task.id}`, agentId, history: [] },
    })
    if (response.error) throw new Error(`Agent 调用失败：${response.error.message}`)
    const text = response.reply.text?.trim() ?? ''
    if (!text) throw new Error('Agent 没有返回可推送的内容')
    return { text }
  }

  private async persist(): Promise<void> {
    await this.storage.set(TASKS_STORAGE_KEY, { tasks: this.list() })
  }
}
