import { describe, expect, it, vi } from 'vitest'
import { createMessageHandler, fallbackFileName, toSendContent } from './message-handler'
import type { MessageHandlerContext } from './message-handler'
import { OutboundLog } from './outbound-log'
import { MemoryStorage } from './storage'

describe('fallbackFileName', () => {
  it('uses the Agent-provided filename when it already has an extension', () => {
    expect(fallbackFileName({ type: 'file', data: Buffer.from('x'), fileName: 'report.pdf' })).toBe('report.pdf')
    expect(fallbackFileName({ type: 'image', data: Buffer.from('x'), fileName: 'photo.png' })).toBe('photo.png')
  })

  it('appends a type-based extension when the filename has none', () => {
    expect(fallbackFileName({ type: 'file', data: Buffer.from('x'), fileName: 'report' })).toBe('report.bin')
    expect(fallbackFileName({ type: 'image', data: Buffer.from('x'), fileName: 'photo' })).toBe('photo.png')
  })

  it('falls back to a type default when no filename is provided', () => {
    expect(fallbackFileName({ type: 'image', data: Buffer.from('x') })).toBe('image.png')
    expect(fallbackFileName({ type: 'video', data: Buffer.from('x') })).toBe('video.mp4')
    expect(fallbackFileName({ type: 'voice', data: Buffer.from('x') })).toBe('voice.wav')
    expect(fallbackFileName({ type: 'voice', data: Buffer.from('x'), format: 'silk' })).toBe('voice.silk')
    expect(fallbackFileName({ type: 'file', data: Buffer.from('x') })).toBe('file.bin')
    expect(fallbackFileName({ type: 'unknown-thing', data: Buffer.from('x') })).toBe('file.bin')
  })
})

describe('toSendContent', () => {
  it('routes image and video straight to the SDK media branches', () => {
    const png = Buffer.from('png')
    expect(toSendContent({ type: 'image', data: png }, '看这个')).toEqual({ image: png, caption: '看这个' })
    expect(toSendContent({ type: 'video', data: png })).toEqual({ video: png, caption: '' })
  })

  it('sends voice and files as generic files with a usable extension', () => {
    const wav = Buffer.from('wav')
    expect(toSendContent({ type: 'voice', data: wav, fileName: 'reply' })).toEqual({
      file: { data: wav, fileName: 'reply.wav' },
      caption: '',
    })
  })
})

interface HarnessOptions {
  replyText?: string
  replyMedia?: { type: string; data: Buffer; fileName?: string }
  intermediates?: Array<{ text: string; media?: { type: string; data: Buffer; fileName?: string } }>
  sendReply?: (raw: unknown, content: { text?: string }) => Promise<void>
  sendTyping?: (userId: string) => Promise<void>
}

function harness(options: HarnessOptions) {
  const storage = new MemoryStorage()
  const outboundLog = new OutboundLog(storage)
  const sent: Array<{ text?: string }> = []

  const ctx = {
    commandHandler: { parse: () => ({ type: 'message' }) },
    userState: { getCurrentAgent: async () => 'demo' },
    agentRegistry: {
      invoke: async (_id: string, _payload: unknown, onIntermediate?: (text: string, media?: never) => void) => {
        for (const item of options.intermediates ?? []) {
          onIntermediate?.(item.text, item.media as never)
        }
        return {
          reply: {
            text: options.replyText ?? '',
            ...(options.replyMedia ? { media: options.replyMedia as never } : {}),
          },
        }
      },
    },
    sessionManager: {
      getOrCreate: async () => ({ history: [] }),
      append: async () => undefined,
    },
    botManager: {
      sendReply: options.sendReply ?? (async (_raw: unknown, content: { text?: string }) => { sent.push(content) }),
      sendTyping: options.sendTyping ?? (async () => undefined),
      download: async () => null,
    },
    outboundLog,
  } as unknown as MessageHandlerContext

  return { ctx, sent, outboundLog, handler: createMessageHandler(ctx) }
}

const incoming = {
  userId: 'user-1@im.wechat',
  text: '帮我写个函数',
  type: 'text',
  hasMedia: false,
  raw: { userId: 'user-1@im.wechat' },
}

describe('createMessageHandler 出站失败可见', () => {
  it('成功回复不留失败记录', async () => {
    const { sent, outboundLog, handler } = harness({ replyText: '这是回复' })
    await handler(incoming)

    expect(sent).toEqual([{ text: '这是回复' }])
    expect(await outboundLog.list()).toEqual([])
  })

  it('回复发送失败时记下未送达的内容与触发消息，并补发兜底提示', async () => {
    const { sent, outboundLog, handler } = harness({
      replyText: '模型说了一半',
      sendReply: async (_raw, content) => {
        if (content.text === '模型说了一半') throw new Error('No context_token cached for user user-1@im.wechat')
        sent.push(content)
      },
    })

    await expect(handler(incoming)).rejects.toThrow('No context_token')

    const [failure] = await outboundLog.list()
    expect(failure).toMatchObject({
      source: 'reply',
      userId: 'user-1@im.wechat',
      status: 'failed',
      content: { text: '模型说了一半' },
      trigger: '帮我写个函数',
    })
    expect(sent).toEqual([{ text: '服务繁忙，请稍后再试。' }])
  })

  it('Agent 没有任何产出时给占位回复并记录原因', async () => {
    const { sent, outboundLog, handler } = harness({ replyText: '' })
    await handler(incoming)

    expect(sent).toEqual([{ text: '本轮没有生成回复内容，请重试或换个说法。' }])
    const [failure] = await outboundLog.list()
    expect(failure).toMatchObject({ source: 'reply', status: 'failed', ruleId: 'agent:demo' })
    expect(failure.error).toContain('没有产出回复内容')
  })

  it('中间结果已经送达时不再补发占位回复', async () => {
    const { sent, outboundLog, handler } = harness({
      replyText: '',
      intermediates: [{ text: '我先说一半' }],
    })
    await handler(incoming)

    expect(sent).toEqual([{ text: '我先说一半' }])
    expect(await outboundLog.list()).toEqual([])
  })

  it('打字指示器失败不影响这一轮对话', async () => {
    const sendTyping = vi.fn(async () => {
      throw new Error('No typing ticket')
    })
    const { sent, handler } = harness({ replyText: '照常说', sendTyping })
    await handler(incoming)

    expect(sendTyping).toHaveBeenCalled()
    expect(sent).toEqual([{ text: '照常说' }])
  })

  it('兜底提示也发不出去时不再抛新异常掩盖原始错误', async () => {
    const { outboundLog, handler } = harness({
      replyText: '模型回复',
      sendReply: async () => {
        throw new Error('轮询连接中断')
      },
    })

    await expect(handler(incoming)).rejects.toThrow('轮询连接中断')
    const logs = await outboundLog.list()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ source: 'reply', status: 'failed', error: '轮询连接中断' })
  })
})
