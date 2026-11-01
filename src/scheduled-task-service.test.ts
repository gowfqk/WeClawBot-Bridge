import { describe, expect, it, vi } from 'vitest'
import type { AgentResponse, ScheduledTask } from './types'
import { MemoryStorage } from './storage'
import { CATCH_UP_GRACE_MS } from './scheduled-task'
import { ScheduledTaskService } from './scheduled-task-service'

const BASE = Date.UTC(2026, 2, 5, 0, 0, 0)
const MINUTE = 60_000

function harness(options: { invoke?: (agentId: string, payload: unknown) => Promise<AgentResponse> } = {}) {
  let clock = BASE
  const storage = new MemoryStorage()
  const send = vi.fn(async () => {})
  const invoke = vi.fn(options.invoke ?? (async (): Promise<AgentResponse> => ({ reply: { text: '这是 Agent 的回复' } })))
  const agents = {
    get: (id: string) => (id === 'claude' ? { id } : undefined),
    invoke: (agentId: string, payload: unknown) => invoke(agentId, payload),
  }
  const service = new ScheduledTaskService(
    storage,
    { send },
    agents,
    { now: () => clock, tickIntervalMs: MINUTE },
  )
  const setClock = (ms: number) => { clock = ms }
  return { service, storage, send, invoke, setClock, clock: () => clock }
}

const intervalInput = {
  id: 'heartbeat',
  name: '心跳',
  kind: 'interval',
  everyMinutes: 10,
  source: 'text',
  text: '服务还活着',
}

const cronInput = {
  id: 'morning',
  name: '早报',
  kind: 'cron',
  schedule: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  source: 'text',
  text: '早上好',
}

const agentInput = {
  id: 'briefing',
  name: '每日简报',
  kind: 'interval',
  everyMinutes: 30,
  source: 'agent',
  agentId: 'claude',
  prompt: '今天的重点新闻有哪些？',
}

describe('ScheduledTaskService 到点推送', () => {
  it('到点把固定文本推给微信，并推进下一次', async () => {
    const { service, send, setClock } = harness()
    const created = await service.create(intervalInput)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    setClock(BASE + 10 * MINUTE)
    await service.tick()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toEqual([undefined, { text: '服务还活着' }, 'task:heartbeat'])

    const after = service.get('heartbeat')!
    expect(after.lastStatus).toBe('success')
    expect(after.runCount).toBe(1)
    expect(after.nextRunAt).toBe(BASE + 20 * MINUTE)
  })

  it('同一时刻只跑一次，执行中的任务不会被重复触发', async () => {
    const { service, send, setClock } = harness()
    await service.create(intervalInput)
    setClock(BASE + 10 * MINUTE)
    await Promise.all([service.tick(), service.tick()])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('Agent 来源：先独立提问（不带历史），再推它的回复', async () => {
    const { service, send, invoke, setClock } = harness()
    await service.create(agentInput)

    setClock(BASE + 30 * MINUTE)
    await service.tick()

    expect(invoke).toHaveBeenCalledTimes(1)
    const [agentId, payload] = invoke.mock.calls[0] as unknown as [string, {
      message: { text: string }
      session: { userId: string; agentId: string; history: unknown[] }
    }]
    expect(agentId).toBe('claude')
    expect(payload.message.text).toBe('今天的重点新闻有哪些？')
    expect(payload.session).toEqual({ userId: 'task:briefing', agentId: 'claude', history: [] })
    expect(send).toHaveBeenCalledWith(undefined, { text: '这是 Agent 的回复' }, 'task:briefing')
  })

  it('Agent 调用失败时记录错误，但排期照常推进', async () => {
    const { service, send, setClock } = harness({
      invoke: async (): Promise<AgentResponse> => ({
        reply: { text: '' },
        error: { message: '上游超时', status: 502, code: 'UPSTREAM' },
      }),
    })
    await service.create(agentInput)

    setClock(BASE + 30 * MINUTE)
    await service.tick()

    expect(send).not.toHaveBeenCalled()
    const failed = service.get('briefing')!
    expect(failed.lastStatus).toBe('failed')
    expect(failed.lastError).toContain('上游超时')
    expect(failed.runCount).toBe(1)
    expect(failed.nextRunAt).toBe(BASE + 60 * MINUTE)
  })

  it('Agent 空回复算失败，不推送空白消息', async () => {
    const { service, send, setClock } = harness({
      invoke: async (): Promise<AgentResponse> => ({ reply: { text: '   ' } }),
    })
    await service.create(agentInput)
    setClock(BASE + 30 * MINUTE)
    await service.tick()
    expect(send).not.toHaveBeenCalled()
    expect(service.get('briefing')!.lastError).toContain('没有返回')
  })

  it('一次性任务推完就停用，不会在下次 tick 再推一条', async () => {
    const { service, send, setClock } = harness()
    const runAt = BASE + 5 * MINUTE
    const created = await service.create({
      id: 'todo', name: '提醒', kind: 'once', runAt, source: 'text', text: '去取快递',
    })
    expect(created.ok).toBe(true)

    setClock(runAt)
    await service.tick()
    expect(send).toHaveBeenCalledTimes(1)

    const done = service.get('todo')!
    expect(done.enabled).toBe(false)
    expect(done.nextRunAt).toBeNull()

    setClock(runAt + MINUTE)
    await service.tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('停机错过超过宽限期的执行点：标记跳过而不是补推', async () => {
    const { service, send, setClock } = harness()
    await service.create(intervalInput)

    setClock(BASE + 10 * MINUTE + CATCH_UP_GRACE_MS + MINUTE)
    await service.tick()

    expect(send).not.toHaveBeenCalled()
    const skipped = service.get('heartbeat')!
    expect(skipped.lastStatus).toBe('skipped')
    expect(skipped.lastError).toContain('超出 15 分钟宽限期')
    expect(skipped.runCount).toBe(0)
    // 不补跑，但排期要跳到当前时刻之后的下一个点（now + 间隔）
    expect(skipped.nextRunAt).toBe(BASE + 10 * MINUTE + CATCH_UP_GRACE_MS + MINUTE + 10 * MINUTE)
  })

  it('手动试跑不改动排期，一次性任务除外', async () => {
    const { service, send } = harness()
    await service.create(intervalInput)
    const before = service.get('heartbeat')!.nextRunAt

    const result = await service.runNow('heartbeat')
    expect(result.ok).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(service.get('heartbeat')!.nextRunAt).toBe(before)

    await service.create({ id: 'todo', name: '提醒', kind: 'once', runAt: BASE + 5 * MINUTE, source: 'text', text: '取快递' })
    await service.runNow('todo')
    expect(service.get('todo')!.enabled).toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('算不出下次执行时间的任务自动停用，避免每轮重复落盘', async () => {
    const { service, storage } = harness()
    // 历史脏数据：一次性任务没有执行时间
    await storage.set('scheduled-tasks', {
      tasks: [{ id: 'broken', name: '坏任务', enabled: true, kind: 'once', source: 'text', text: 'x', createdAt: BASE, runCount: 0 }],
    })
    await service.load()
    await service.tick()

    const broken = service.get('broken')!
    expect(broken.enabled).toBe(false)
    expect(broken.lastStatus).toBe('skipped')
    expect(broken.lastError).toContain('自动停用')
  })
})

describe('ScheduledTaskService 持久化与增删改', () => {
  it('重启后按持久化数据恢复，并补算缺失的下次执行时间', async () => {
    const storage = new MemoryStorage()
    let clock = BASE
    const service = new ScheduledTaskService(
      storage,
      { send: vi.fn(async () => {}) },
      { get: () => undefined, invoke: vi.fn() },
      { now: () => clock },
    )
    await service.create(cronInput)

    const reloaded = new ScheduledTaskService(
      storage,
      { send: vi.fn(async () => {}) },
      { get: () => undefined, invoke: vi.fn() },
      { now: () => clock },
    )
    await reloaded.load()
    const task = reloaded.get('morning')!
    // 北京时间 09:00 = 01:00 UTC
    expect(task.nextRunAt).toBe(Date.UTC(2026, 2, 5, 1, 0, 0))
    expect(task.lastStatus).toBeUndefined()
  })

  it('重复 ID 返回 409，不存在与停用后再启用各有对应语义', async () => {
    const { service, setClock } = harness()
    await service.create(intervalInput)
    const duplicate = await service.create(intervalInput)
    expect(duplicate).toMatchObject({ ok: false, status: 409 })

    const missing = await service.update('nope', intervalInput)
    expect(missing).toMatchObject({ ok: false, status: 404 })

    const removed = await service.remove('heartbeat')
    expect(removed.ok).toBe(true)
    expect(await service.remove('heartbeat')).toMatchObject({ ok: false })

    // 一次性任务跑完后不允许直接再启用
    await service.create({ id: 'todo', name: '提醒', kind: 'once', runAt: BASE + MINUTE, source: 'text', text: 'x' })
    setClock(BASE + 2 * MINUTE)
    await service.tick()
    const reEnable = await service.setEnabled('todo', true)
    expect(reEnable).toMatchObject({ ok: false, status: 400 })
  })

  it('停用后不再触发，重新启用按当前时刻重排', async () => {
    const { service, send, setClock } = harness()
    await service.create(cronInput)

    await service.setEnabled('morning', false)
    setClock(Date.UTC(2026, 2, 5, 1, 0, 0))
    await service.tick()
    expect(send).not.toHaveBeenCalled()
    expect(service.get('morning')!.nextRunAt).toBeNull()

    await service.setEnabled('morning', true)
    expect(service.get('morning')!.nextRunAt).toBe(Date.UTC(2026, 2, 6, 1, 0, 0))
  })

  it('改了执行时间的一次性任务允许重新触发', async () => {
    const { service, setClock } = harness()
    await service.create({ id: 'todo', name: '提醒', kind: 'once', runAt: BASE + MINUTE, source: 'text', text: 'x' })
    setClock(BASE + 2 * MINUTE)
    await service.tick()
    expect(service.get('todo')!.runCount).toBe(1)

    const updated = await service.update('todo', {
      id: 'todo', name: '提醒', kind: 'once', runAt: BASE + 30 * MINUTE, source: 'text', text: 'x',
    })
    expect(updated.ok).toBe(true)
    const task = service.get('todo')!
    expect(task.runCount).toBe(0)
    expect(task.enabled).toBe(true)
    expect(task.nextRunAt).toBe(BASE + 30 * MINUTE)
  })

  it('URL 里的 ID 才是准的，避免请求体改 ID 把任务改名复制', async () => {
    const { service } = harness()
    await service.create(intervalInput)
    const result = await service.update('heartbeat', { ...intervalInput, id: 'hijack', text: '改了内容' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.task.id).toBe('heartbeat')
    expect(service.get('hijack')).toBeUndefined()
  })

  it('改了调度方式或内容来源后不残留旧配置', async () => {
    const { service } = harness({
      invoke: async (): Promise<AgentResponse> => ({ reply: { text: 'ok' } }),
    })
    await service.create(cronInput)
    await service.update('morning', {
      id: 'morning', name: '早报', kind: 'interval', everyMinutes: 15, source: 'agent', agentId: 'claude', prompt: '今天有什么安排？',
    })

    const task = service.get('morning')!
    expect(task.schedule).toBeUndefined()
    expect(task.timezone).toBeUndefined()
    expect(task.everyMinutes).toBe(15)
    expect(task.text).toBeUndefined()
    expect(task.nextRunAt).toBe(BASE + 15 * MINUTE)
  })

  it('任务列表按下次执行时间排序，未排期的沉底', async () => {
    const { service } = harness()
    await service.create({ id: 'slow', name: '慢', kind: 'interval', everyMinutes: 60, source: 'text', text: 'x' })
    await service.create({ id: 'fast', name: '快', kind: 'interval', everyMinutes: 5, source: 'text', text: 'x' })
    await service.setEnabled('slow', false)
    expect(service.list().map((t: ScheduledTask) => t.id)).toEqual(['fast', 'slow'])
  })
})
