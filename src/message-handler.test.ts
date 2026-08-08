import { describe, expect, it } from 'vitest'
import { fallbackFileName } from './message-handler'

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
