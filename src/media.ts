import type { AgentMedia, AgentPayload } from './types'

/** Convert the internal Buffer representation to the JSON-safe Agent protocol. */
export function serializeAgentPayload(payload: AgentPayload): Record<string, unknown> {
  const media = normalizeMedia(payload.message.media)
  return {
    ...payload,
    message: {
      ...payload.message,
      media: media ? media.data.toString('base64') : null,
      ...(media ? {
        mediaType: media.type,
        ...(media.fileName ? { mediaFileName: media.fileName } : {}),
        ...(media.format ? { mediaFormat: media.format } : {}),
      } : {}),
    },
  }
}

/** Accept Buffer, JSON Buffer objects, base64 strings, and structured media. */
export function decodeAgentMedia(value: unknown, fallbackType = 'file'): AgentMedia | null {
  if (!value) return null
  if (Buffer.isBuffer(value)) return { type: fallbackType, data: value }

  if (typeof value === 'string') {
    return { type: fallbackType, data: Buffer.from(value, 'base64') }
  }

  if (typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  let data: Buffer | null = null
  if (typeof item.data === 'string') {
    data = Buffer.from(item.data, 'base64')
  } else if (Buffer.isBuffer(item.data)) {
    data = item.data
  } else if (Array.isArray(item.data)) {
    data = Buffer.from(item.data.filter((n): n is number => typeof n === 'number'))
  } else if (Buffer.isBuffer(item.buffer)) {
    data = item.buffer
  }
  if (!data || data.length === 0) return null

  return {
    type: typeof item.type === 'string' && item.type !== 'Buffer'
      ? item.type
      : (typeof item.mediaType === 'string' ? item.mediaType : fallbackType),
    data,
    fileName: typeof item.fileName === 'string'
      ? item.fileName
      : (typeof item.mediaFileName === 'string' ? item.mediaFileName : undefined),
    format: typeof item.format === 'string'
      ? item.format
      : (typeof item.mediaFormat === 'string' ? item.mediaFormat : undefined),
  }
}

export function normalizeMedia(value: unknown, fallbackType = 'file'): AgentMedia | null {
  return decodeAgentMedia(value, fallbackType)
}

/** Extract media from the common Agent response shapes. */
export function extractResponseMedia(data: Record<string, unknown>, fallbackType = 'file'): AgentMedia | null {
  const decodeFrom = (source: Record<string, unknown>): AgentMedia | null => {
    const value = source.media ?? source.file
    if (value == null) return null
    if (typeof value === 'string') {
      return decodeAgentMedia({
        data: value,
        mediaType: source.mediaType,
        mediaFileName: source.mediaFileName,
        mediaFormat: source.mediaFormat,
      }, fallbackType)
    }
    return decodeAgentMedia(value, fallbackType)
  }

  const reply = data.reply
  if (reply && typeof reply === 'object') {
    const media = decodeFrom(reply as Record<string, unknown>)
    if (media) return media
  }
  return decodeFrom(data)
}
