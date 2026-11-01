import { describe, expect, it } from 'vitest'
import type { ScheduledTask } from './types'
import {
  DEFAULT_TASK_TIMEZONE,
  computeNextRunAt,
  cronScheduleError,
  isValidTimezone,
  nextCronRunAt,
  validateScheduledTask,
} from './scheduled-task'

/** 2026-03-05 00:00:00 UTC = 北京时间 08:00 */
const NOW_UTC = Date.UTC(2026, 2, 5, 0, 0, 0)

const agentsWith = (...ids: string[]) => ({
  get: (id: string) => (ids.includes(id) ? { id } : undefined),
})

const baseInput = {
  id: 'morning',
  name: '早间提醒',
  kind: 'cron',
  schedule: '0 9 * * *',
  source: 'text',
  text: '早上好',
}

const validate = (input: unknown, overrides: { now?: number; isCreate?: boolean; agents?: { get(id: string): unknown } } = {}) =>
  validateScheduledTask(input, {
    agents: overrides.agents ?? agentsWith('claude'),
    now: overrides.now ?? NOW_UTC,
    isCreate: overrides.isCreate ?? true,
  })

function taskOf(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't',
    name: 't',
    enabled: true,
    kind: 'cron',
    source: 'text',
    text: 'hi',
    createdAt: NOW_UTC,
    runCount: 0,
    ...overrides,
  } as ScheduledTask
}

describe('cron 校验与时区', () => {
  it('把非法表达式转成人能看懂的错误，而不是静默接受', () => {
    // node-cron v4 的 validate() 只返回布尔值：旧的通知规则据此判断会静默保存一个永不触发的任务。
    expect(cronScheduleError('99 99 99')).toContain('Cron 表达式无效')
    expect(cronScheduleError('')).toContain('Cron 表达式无效')
    expect(cronScheduleError('0 9 * * 1-5')).toBe(null)
  })

  it('识别 IANA 时区名', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
  })

  it('同一个表达式在不同时区的触发点不同', () => {
    const shanghai = nextCronRunAt('0 9 * * *', 'Asia/Shanghai', NOW_UTC)
    const utc = nextCronRunAt('0 9 * * *', 'UTC', NOW_UTC)
    // 北京时间 09:00 = 01:00 UTC；UTC 时区的 09:00 则晚 8 小时
    expect(shanghai).toBe(Date.UTC(2026, 2, 5, 1, 0, 0))
    expect(utc).toBe(Date.UTC(2026, 2, 5, 9, 0, 0))
  })

  it('表达式或时区非法时不抛异常，返回 null', () => {
    expect(nextCronRunAt('not a cron', 'Asia/Shanghai', NOW_UTC)).toBe(null)
    expect(nextCronRunAt('0 9 * * *', 'Mars/Olympus', NOW_UTC)).toBe(null)
    expect(nextCronRunAt('', 'Asia/Shanghai', NOW_UTC)).toBe(null)
  })
})

describe('computeNextRunAt', () => {
  it('一次性任务执行过之后不再有下次', () => {
    const runAt = NOW_UTC + 60_000
    expect(computeNextRunAt(taskOf({ kind: 'once', runAt }), NOW_UTC)).toBe(runAt)
    expect(computeNextRunAt(taskOf({ kind: 'once', runAt, runCount: 1 }), NOW_UTC)).toBe(null)
  })

  it('间隔任务从上次执行时刻往后推，首次则从创建时刻', () => {
    expect(computeNextRunAt(taskOf({ kind: 'interval', everyMinutes: 30, lastRunAt: NOW_UTC }), NOW_UTC))
      .toBe(NOW_UTC + 30 * 60_000)
    expect(computeNextRunAt(taskOf({ kind: 'interval', everyMinutes: 5 }), NOW_UTC))
      .toBe(NOW_UTC + 5 * 60_000)
  })

  it('Cron 任务按自己的时区推算', () => {
    expect(computeNextRunAt(taskOf({ schedule: '0 9 * * *', timezone: 'Asia/Shanghai' }), NOW_UTC))
      .toBe(Date.UTC(2026, 2, 5, 1, 0, 0))
    // 缺省时区落到北京时间，而不是容器 UTC
    expect(computeNextRunAt(taskOf({ schedule: '0 9 * * *', timezone: undefined }), NOW_UTC))
      .toBe(Date.UTC(2026, 2, 5, 1, 0, 0))
    expect(DEFAULT_TASK_TIMEZONE).toBe('Asia/Shanghai')
  })

  it('停用中的任务不排期', () => {
    expect(computeNextRunAt(taskOf({ kind: 'once', runAt: NOW_UTC + 60_000, enabled: false }), NOW_UTC)).toBe(null)
  })
})

describe('validateScheduledTask', () => {
  it('接受合法的 cron 文本任务并补上默认时区', () => {
    const result = validate(baseInput)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.timezone).toBe('Asia/Shanghai')
      expect(result.data.enabled).toBe(true)
      expect(result.data.text).toBe('早上好')
    }
  })

  it('拒绝非法 cron 表达式，错误信息说明原因', () => {
    const result = validate({ ...baseInput, schedule: '0 99 * *' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Cron')
  })

  it('拒绝无法识别的时区', () => {
    const result = validate({ ...baseInput, timezone: 'Mars/Olympus' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('时区')
  })

  it('一次性任务新建时不接受过去的时间，但编辑历史任务时放行', () => {
    const past = { ...baseInput, kind: 'once', schedule: undefined, runAt: NOW_UTC - 1000 }
    const onCreate = validate(past)
    expect(onCreate.ok).toBe(false)
    if (!onCreate.ok) expect(onCreate.error).toContain('晚于当前时间')

    const onUpdate = validate(past, { isCreate: false })
    expect(onUpdate.ok).toBe(true)
  })

  it('间隔任务必须有间隔分钟数', () => {
    const result = validate({ ...baseInput, kind: 'interval', schedule: undefined })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('间隔')
  })

  it('文本任务不能是空白内容', () => {
    const result = validate({ ...baseInput, text: '   ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('文本')
  })

  it('Agent 任务要求 Agent 存在且有提问内容', () => {
    const agentInput = { ...baseInput, source: 'agent', text: undefined, agentId: 'ghost', prompt: '今天有什么安排？' }
    const missing = validate(agentInput)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain('ghost')

    const noPrompt = validate({ ...agentInput, agentId: 'claude', prompt: '' })
    expect(noPrompt.ok).toBe(false)
    if (!noPrompt.ok) expect(noPrompt.error).toContain('Agent')

    const ok = validate({ ...agentInput, agentId: 'claude' })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.data.text).toBeUndefined()
      expect(ok.data.agentId).toBe('claude')
    }
  })

  it('结构校验先于语义校验，ID 非法直接报错', () => {
    const result = validate({ ...baseInput, id: 'bad id with spaces' })
    expect(result.ok).toBe(false)
  })
})
