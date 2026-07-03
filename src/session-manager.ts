import type { Storage, Session, ChatEntry } from './types'

const SESSION_KEY_PREFIX = 'session:'
const CONTEXT_TOKEN_KEY_PREFIX = 'context_token:'

interface CacheEntry {
  session: Session
  expires: number
}

export class SessionManager {
  private storage: Storage
  private maxRounds: number
  private expireMs: number
  private cache: Map<string, CacheEntry> = new Map()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5分钟缓存

  constructor(storage: Storage, maxRounds: number = 10, expireMs: number = 30 * 60 * 1000) {
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

    const maxEntries = this.maxRounds * 2
    if (session.history.length > maxEntries) {
      session.history = session.history.slice(session.history.length - maxEntries)
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
    return Date.now() - session.lastActive > this.expireMs
  }

  async getContextToken(userId: string): Promise<string> {
    const token = await this.storage.get<string>(this.contextTokenKey(userId))
    return token || ''
  }

  async setContextToken(userId: string, token: string): Promise<void> {
    await this.storage.set(this.contextTokenKey(userId), token)
  }
}
