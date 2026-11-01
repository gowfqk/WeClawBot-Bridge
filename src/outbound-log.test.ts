import { describe, expect, it, vi } from 'vitest'
import { OutboundLog, summarizeContent } from './outbound-log'
import { MemoryStorage } from './storage'

describe('summarizeContent', () => {
  it('keeps text but never persists media buffers', () => {
    expect(summarizeContent({ text: '早安' })).toEqual({ text: '早安' })
    expect(summarizeContent({ image: Buffer.alloc(2048), caption: '截图' })).toEqual({
      text: '截图',
      media: { kind: 'image', bytes: 2048 },
    })
    expect(summarizeContent({ file: { data: Buffer.alloc(7), fileName: 'report.pdf' } })).toEqual({
      media: { kind: 'file', fileName: 'report.pdf', bytes: 7 },
    })
    expect(summarizeContent({ video: Buffer.alloc(5) })).toEqual({
      media: { kind: 'video', bytes: 5 },
    })
    expect(summarizeContent({})).toEqual({})
  })

  it('truncates long text so one record stays small', () => {
    const summary = summarizeContent({ text: 'x'.repeat(500) })
    expect(summary.text).toHaveLength(200)
  })
})

describe('OutboundLog', () => {
  it('records an attempt and reads it back newest-first', async () => {
    const storage = new MemoryStorage()
    const outboundLog = new OutboundLog(storage)
    let clock = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => ++clock)

    try {
      await outboundLog.record({ source: 'notify', userId: 'u1', content: { text: 'first' }, status: 'success' })
      await outboundLog.record({
        source: 'reply',
        userId: 'u2',
        content: { text: 'second' },
        status: 'failed',
        error: 'No context_token cached for user u2',
        trigger: '帮我写个函数',
      })

      const logs = await outboundLog.list()
      expect(logs).toHaveLength(2)
      expect(logs[0]).toMatchObject({
        source: 'reply',
        userId: 'u2',
        status: 'failed',
        error: 'No context_token cached for user u2',
        trigger: '帮我写个函数',
        content: { text: 'second' },
      })
      expect(logs[1].source).toBe('notify')
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('labels pre-existing records as notification history', async () => {
    const storage = new MemoryStorage()
    await storage.set('notify:log:legacy', {
      id: 'legacy',
      ruleId: 'daily',
      userId: 'u1',
      content: { text: '旧记录' },
      status: 'success',
      timestamp: 1,
    })

    const logs = await new OutboundLog(storage).list()
    expect(logs).toHaveLength(1)
    expect(logs[0].source).toBe('notify')
    expect(logs[0].ruleId).toBe('daily')
  })

  it('still returns the record when storage writing fails', async () => {
    const failing = new MemoryStorage()
    const setSpy = vi.fn(async () => {
      throw new Error('disk full')
    })
    failing.set = setSpy as unknown as MemoryStorage['set']

    const entry = await new OutboundLog(failing).record({
      source: 'reply',
      userId: 'u1',
      content: { text: 'hi' },
      status: 'failed',
      error: 'send failed',
    })
    expect(entry.id).toBeTruthy()
    expect(await new OutboundLog(failing).list()).toEqual([])
  })
})
