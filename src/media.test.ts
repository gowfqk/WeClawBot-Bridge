import { describe, expect, it } from 'vitest'
import { decodeAgentMedia, extractResponseMedia, serializeAgentPayload } from './media'

describe('Agent media protocol', () => {
  it('serializes incoming media as base64 with metadata', () => {
    const wire = serializeAgentPayload({
      message: {
        text: '请分析图片',
        type: 'image',
        media: { type: 'image', data: Buffer.from('image-data'), fileName: 'photo.png' },
      },
      session: { userId: 'u', agentId: 'a', history: [] },
    })

    expect((wire.message as Record<string, unknown>).media).toBe(Buffer.from('image-data').toString('base64'))
    expect((wire.message as Record<string, unknown>).mediaType).toBe('image')
    expect((wire.message as Record<string, unknown>).mediaFileName).toBe('photo.png')
  })

  it('decodes structured base64 responses into a Buffer', () => {
    const media = extractResponseMedia({
      reply: {
        text: '文件如下',
        media: { type: 'file', data: Buffer.from('result').toString('base64'), fileName: 'result.txt' },
      },
    })

    expect(media?.type).toBe('file')
    expect(media?.fileName).toBe('result.txt')
    expect(media?.data.toString()).toBe('result')
  })

  it('accepts legacy JSON Buffer objects', () => {
    const media = decodeAgentMedia({ type: 'Buffer', data: [1, 2, 3] }, 'image')
    expect(media?.type).toBe('image')
    expect(media?.data).toEqual(Buffer.from([1, 2, 3]))
  })
})
