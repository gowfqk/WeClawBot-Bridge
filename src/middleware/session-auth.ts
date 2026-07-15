import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { Storage } from '../types'

const PASSWORD_HASH_KEY = 'config:api_key_hash'
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_SESSIONS = 5 // 最多允许 5 个并发会话

export interface SessionInfo {
  token: string
  createdAt: number
  expiresAt: number
}

export class SessionAuth {
  private storage: Storage
  private envApiKey: string
  private sessions: Map<string, SessionInfo> = new Map()
  private sessionTtlMs: number

  constructor(storage: Storage, envApiKey: string, sessionTtlMs?: number) {
    this.storage = storage
    this.envApiKey = envApiKey
    this.sessionTtlMs = sessionTtlMs || DEFAULT_SESSION_TTL_MS
  }

  /** Check if a password has been set (either env var or stored hash) */
  async isPasswordSet(): Promise<boolean> {
    if (this.envApiKey) return true
    const hash = await this.storage.get<string>(PASSWORD_HASH_KEY)
    return !!hash
  }

  /** Verify a password against env var or stored bcrypt hash */
  async verifyPassword(password: string): Promise<boolean> {
    // Check env var first — use timing-safe comparison to prevent timing attacks
    if (this.envApiKey) {
      const a = Buffer.from(password, 'utf-8')
      const b = Buffer.from(this.envApiKey, 'utf-8')
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true
    }

    // Check stored bcrypt hash
    const hash = await this.storage.get<string>(PASSWORD_HASH_KEY)
    if (hash) {
      return bcrypt.compare(password, hash)
    }

    return false
  }

  /** Set password (bcrypt hash and store) */
  async setPassword(password: string): Promise<void> {
    const hash = await bcrypt.hash(password, 10)
    await this.storage.set(PASSWORD_HASH_KEY, hash)
    // Invalidate all sessions on password change
    this.sessions.clear()
  }

  /** Change password: verify old, then set new */
  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    const verified = await this.verifyPassword(oldPassword)
    if (!verified) return false
    await this.setPassword(newPassword)
    return true
  }

  /** Login: verify password and create session token */
  async login(password: string): Promise<{ token: string; expiresAt: number } | null> {
    const verified = await this.verifyPassword(password)
    if (!verified) return null

    // 清理过期 session
    this.cleanExpired()

    // 限制并发会话数
    if (this.sessions.size >= MAX_SESSIONS) {
      // 移除最早创建的 session
      let oldest: string | null = null
      for (const [token, info] of this.sessions) {
        if (!oldest || info.createdAt < this.sessions.get(oldest)!.createdAt) {
          oldest = token
        }
      }
      if (oldest) {
        const evicted = this.sessions.get(oldest)!
        console.warn(`[SessionAuth] 会话被踢出：达到最大并发数 (${MAX_SESSIONS})，最早会话 (创建于 ${new Date(evicted.createdAt).toISOString()}) 已被移除。如有疑问请检查是否存在异常登录。`)
        this.sessions.delete(oldest)
      }
    }

    const token = crypto.randomUUID()
    const now = Date.now()
    const session: SessionInfo = {
      token,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    }
    this.sessions.set(token, session)
    return { token, expiresAt: session.expiresAt }
  }

  /** Validate a Bearer token against active sessions */
  validateToken(token: string): { valid: boolean; expired: boolean } {
    const session = this.sessions.get(token)
    if (!session) return { valid: false, expired: false }
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return { valid: false, expired: true }
    }
    return { valid: true, expired: false }
  }

  /** Logout: invalidate a specific session */
  logout(token?: string): void {
    if (token) {
      this.sessions.delete(token)
    } else {
      this.sessions.clear()
    }
  }

  /** Clean expired sessions */
  private cleanExpired(): void {
    const now = Date.now()
    for (const [token, info] of this.sessions) {
      if (now > info.expiresAt) {
        this.sessions.delete(token)
      }
    }
  }

  /** Get active session count */
  get sessionCount(): number {
    return this.sessions.size
  }
}
