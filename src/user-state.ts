import type { Storage, UserState } from './types'
import { normalizeUserId } from './single-user'

const STATE_KEY_PREFIX = 'user:'
const STATE_KEY_SUFFIX = ':state'

export class UserStateManager {
  private storage: Storage
  private defaultAgentId: string | undefined

  constructor(storage: Storage, defaultAgentId?: string) {
    this.storage = storage
    this.defaultAgentId = defaultAgentId
  }

  private stateKey(userId: string): string {
    return `${STATE_KEY_PREFIX}${normalizeUserId(userId)}${STATE_KEY_SUFFIX}`
  }

  async getState(userId: string): Promise<UserState> {
    const normalizedUserId = normalizeUserId(userId)
    const existing = await this.storage.get<UserState>(this.stateKey(normalizedUserId))
    if (existing) return existing

    return {
      userId: normalizedUserId,
      currentAgentId: this.defaultAgentId || null,
      lastActive: Date.now(),
    }
  }

  async switchAgent(userId: string, agentId: string): Promise<void> {
    const state = await this.getState(userId)
    state.currentAgentId = agentId
    state.lastActive = Date.now()
    await this.storage.set(this.stateKey(userId), state)
  }

  async getCurrentAgent(userId: string): Promise<string | null> {
    const state = await this.getState(userId)
    return state.currentAgentId
  }

  async clearState(userId: string): Promise<void> {
    await this.storage.delete(this.stateKey(userId))
  }

  async hasActiveAgent(userId: string): Promise<boolean> {
    const state = await this.getState(userId)
    return state.currentAgentId !== null
  }
}
