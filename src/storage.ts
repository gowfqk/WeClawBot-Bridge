import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Storage } from './types'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export class MemoryStorage implements Storage {
  private store = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }
}

export class FileStorage implements Storage {
  private baseDir: string
  private namespace: string

  constructor(baseDir: string, namespace: string = 'default') {
    this.baseDir = baseDir
    this.namespace = namespace
  }

  private keyPath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, '_')
    return path.join(this.baseDir, this.namespace, `${safeKey}.json`)
  }

  async get<T>(key: string): Promise<T | undefined> {
    const filePath = this.keyPath(key)
    try {
      const data = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(data) as T
    } catch {
      return undefined
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const filePath = this.keyPath(key)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(value), 'utf-8')
  }

  async delete(key: string): Promise<void> {
    const filePath = this.keyPath(key)
    try {
      await fs.unlink(filePath)
    } catch {
      // file not found, ok
    }
  }

  async has(key: string): Promise<boolean> {
    const filePath = this.keyPath(key)
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async clear(): Promise<void> {
    const dir = path.join(this.baseDir, this.namespace)
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // dir not found, ok
    }
  }
}

export class EncryptedStorage implements Storage {
  private inner: Storage
  private encryptionKey: Buffer

  constructor(inner: Storage, keyHex: string) {
    this.inner = inner
    const key = Buffer.from(keyHex, 'hex')
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars)`)
    }
    this.encryptionKey = key
  }

  private encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    const result = Buffer.concat([iv, authTag, encrypted])
    return result.toString('base64')
  }

  private decrypt(ciphertext: string): string {
    const data = Buffer.from(ciphertext, 'base64')
    const iv = data.subarray(0, IV_LENGTH)
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8')
  }

  async get<T>(key: string): Promise<T | undefined> {
    const encrypted = await this.inner.get<string>(key)
    if (encrypted === undefined) return undefined
    const decrypted = this.decrypt(encrypted)
    return JSON.parse(decrypted) as T
  }

  async set<T>(key: string, value: T): Promise<void> {
    const plaintext = JSON.stringify(value)
    const encrypted = this.encrypt(plaintext)
    await this.inner.set(key, encrypted)
  }

  async delete(key: string): Promise<void> {
    await this.inner.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return this.inner.has(key)
  }

  async clear(): Promise<void> {
    await this.inner.clear()
  }
}
