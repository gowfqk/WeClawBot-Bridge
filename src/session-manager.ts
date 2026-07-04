import type { Storage, Session, ChatEntry } from './types'

const SESSION_KEY_PREFIX = 'session:'
const CONTEXT_TOKEN_KEY_PREFIX = 'context_token:'
const SESSION_CONFIG_KEY = 'session:config'

interface CacheEntry {
  session: Session
  expires: number
}

export interface SessionSummary {
  userId: string
  agentId: string
  messageCount: number
  lastActive: number
}

export interface SessionConfig {
  maxRounds: number
  expireMs: number
}

export class SessionManager {
  private storage: Storage
  private maxRounds: number
  private expireMs: number
  private cache: Map<string, CacheEntry> = new Map()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5分钟缓存

  constructor(storage: Storage, maxRounds: number = 0, expireMs: number = 0) {
    this.storage = storage
    this.maxRounds = maxRounds
    this.expireMs = expireMs
    
    // 定期清理过期缓存
    setInterval(() => this.cleanExpiredCache(), 60 * 1000)
  }
  
  private cleanExpiredCache(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires < now) {
        this.cache.delete(key)
      }
    }
  }

  private sessionKey(userId: string, agentId: string): string {
    return `${SESSION_KEY_PREFIX}${userId}:${agentId}`
  }

  private contextTokenKey(userId: string): string {
    return `${CONTEXT_TOKEN_KEY_PREFIX}${userId}`
  }

  async getOrCreate(userId: string, agentId: string): Promise<Session> {
    const key = this.sessionKey(userId, agentId)
    
    // 检查缓存
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) {
      cached.session.lastActive = Date.now()
      return cached.session
    }
    
    // 从存储读取
    const existing = await this.storage.get<Session>(key)
    let session: Session
    
    if (existing && !this.isExpired(existing)) {
      session = existing
      session.lastActive = Date.now()
    } else {
      session = {
        userId,
        agentId,
        history: [],
        contextToken: '',
        lastActive: Date.now(),
      }
    }
    
    // 更新缓存
    this.cache.set(key, {
      session,
      expires: Date.now() + this.CACHE_TTL
    })
    
    return session
  }

  async append(userId: string, agentId: string, entry: ChatEntry): Promise<void> {
    const session = await this.getOrCreate(userId, agentId)
    session.history.push(entry)
    session.lastActive = Date.now()

    // maxRounds <= 0 表示不限制轮次
    if (this.maxRounds > 0) {
      const maxEntries = this.maxRounds * 2
      if (session.history.length > maxEntries) {
        session.history = session.history.slice(session.history.length - maxEntries)
      }
    }

    // 更新存储
    const key = this.sessionKey(userId, agentId)
    await this.storage.set(key, session)
    
    // 更新缓存
    this.cache.set(key, {
      session,
      expires: Date.now() + this.CACHE_TTL
    })
  }

  async clear(userId: string, agentId: string): Promise<void> {
    const key = this.sessionKey(userId, agentId)
    await this.storage.delete(key)
    // 清除缓存
    this.cache.delete(key)
  }

  async prune(): Promise<void> {
    // FileStorage doesn't support scanning all keys easily,
    // so pruning is done lazily at getOrCreate time if expired.
    // MemoryStorage: this is a no-op for simplicity.
  }

  isExpired(session: Session): boolean {
    // expireMs <= 0 表示永不过期
    if (this.expireMs <= 0) return false
    return Date.now() - session.lastActive > this.expireMs
  }

  async getContextToken(userId: string): Promise<string> {
    const token = await this.storage.get<string>(this.contextTokenKey(userId))
    return token || ''
  }

  async setContextToken(userId: string, token: string): Promise<void> {
    await this.storage.set(this.contextTokenKey(userId), token)
  }

  // ===== 会话管理方法 =====

  /** 列出所有会话摘要 */
  async listSessions(): Promise<SessionSummary[]> {
    const keys = await this.storage.listKeys(SESSION_KEY_PREFIX)
    const sessions: SessionSummary[] = []

    for (const key of keys) {
      const session = await this.storage.get<Session>(key)
      if (session && session.userId && session.agentId) {
        sessions.push({
          userId: session.userId,
          agentId: session.agentId,
          messageCount: session.history.length,
          lastActive: session.lastActive,
        })
      }
    }

    // 按最后活跃时间降序排列
    sessions.sort((a, b) => b.lastActive - a.lastActive)
    return sessions
  }

  /** 获取单个会话详情 */
  async getSessionDetail(userId: string, agentId: string): Promise<Session | null> {
    const key = this.sessionKey(userId, agentId)
    const session = await this.storage.get<Session>(key)
    if (!session) return null

    // 检查是否过期（如果配置了永不过期则不检查）
    if (this.isExpired(session)) return null

    return session
  }

  /** 删除会话 */
  async deleteSession(userId: string, agentId: string): Promise<boolean> {
    const key = this.sessionKey(userId, agentId)
    const exists = await this.storage.has(key)
    if (!exists) return false

    await this.storage.delete(key)
    this.cache.delete(key)
    return true
  }

  /** 清空所有会话 */
  async clearAllSessions(): Promise<number> {
    const keys = await this.storage.listKeys(SESSION_KEY_PREFIX)
    for (const key of keys) {
      await this.storage.delete(key)
      this.cache.delete(key)
    }
    return keys.length
  }

  /** 获取会话配置 */
  async getConfig(): Promise<SessionConfig> {
    // 优先从存储读取运行时配置
    const stored = await this.storage.get<SessionConfig>(SESSION_CONFIG_KEY)
    if (stored) {
      this.maxRounds = stored.maxRounds
      this.expireMs = stored.expireMs
      return stored
    }
    return { maxRounds: this.maxRounds, expireMs: this.expireMs }
  }

  /** 更新会话配置（持久化） */
  async updateConfig(maxRounds?: number, expireMs?: number): Promise<SessionConfig> {
    if (maxRounds !== undefined) this.maxRounds = maxRounds
    if (expireMs !== undefined) this.expireMs = expireMs

    const config: SessionConfig = { maxRounds: this.maxRounds, expireMs: this.expireMs }
    await this.storage.set(SESSION_CONFIG_KEY, config)
    return config
  }
}
