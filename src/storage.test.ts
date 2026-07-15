import { describe, it, expect, afterAll } from 'vitest'
import { MemoryStorage, FileStorage } from './storage'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('MemoryStorage', () => {
  it('stores and retrieves values', async () => {
    const s = new MemoryStorage()
    await s.set('key', 'value')
    expect(await s.get('key')).toBe('value')
  })

  it('returns undefined for missing key', async () => {
    const s = new MemoryStorage()
    expect(await s.get('missing')).toBeUndefined()
  })

  it('deletes values', async () => {
    const s = new MemoryStorage()
    await s.set('key', 'value')
    await s.delete('key')
    expect(await s.get('key')).toBeUndefined()
  })

  it('lists keys with prefix', async () => {
    const s = new MemoryStorage()
    await s.set('notify:log:1', 'a')
    await s.set('notify:log:2', 'b')
    await s.set('config:key', 'c')
    const keys = await s.listKeys('notify:log:')
    expect(keys).toHaveLength(2)
  })
})

describe('FileStorage', () => {
  const tmpDir = path.join(os.tmpdir(), `wechatbot-test-${Date.now()}`)

  it('stores and retrieves values without key collision', async () => {
    const s = new FileStorage(tmpDir, 'test')
    await s.set('a:b', 'value1')
    await s.set('a_b', 'value2')
    // 不同的 key 不应碰撞
    expect(await s.get('a:b')).toBe('value1')
    expect(await s.get('a_b')).toBe('value2')
  })

  it('lists keys with prefix', async () => {
    const s = new FileStorage(tmpDir, 'list')
    await s.set('notify:log:1', { id: 1 })
    await s.set('notify:log:2', { id: 2 })
    await s.set('config:key', 'c')
    const keys = await s.listKeys('notify:log:')
    expect(keys.sort()).toEqual(['notify:log:1', 'notify:log:2'])
  })

  it('deletes values', async () => {
    const s = new FileStorage(tmpDir, 'del')
    await s.set('key', 'value')
    await s.delete('key')
    expect(await s.get('key')).toBeUndefined()
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
})
