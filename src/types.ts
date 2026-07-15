export type AgentType = 'http' | 'cli' | 'ws' | 'ws-remote'

export interface AgentConfig {
  id: string
  name: string
  command: string
  type: AgentType
  description: string
  endpoint?: string
  timeout: number
  headers?: Record<string, string>
  /** CLI 进程环境变量（优先于 headers） */
  cliEnv?: Record<string, string>
  apiKey?: string
  model?: string
  format?: 'native' | 'openai' | 'qwenpaw'
  streaming?: boolean
  responsePath?: string
  systemPrompt?: string
  maxHistory?: number
  cliCommand?: string
  cliArgs?: string[]
  cliWorkDir?: string
  cliMode?: 'oneshot' | 'persistent'
  cliSentinel?: string
  /** WebSocket 通道配置 */
  wsUrl?: string
  wsReconnectInterval?: number   // 重连间隔 ms，默认 3000
  wsHeartbeatInterval?: number   // 心跳间隔 ms，默认 30000
  wsMaxReconnectAttempts?: number // 最大重连次数，默认 Infinity
}

export interface UserState {
  userId: string
  currentAgentId: string | null
  lastActive: number
}

export interface ChatEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface Session {
  userId: string
  agentId: string
  history: ChatEntry[]
  contextToken: string
  lastActive: number
}

export interface AgentPayload {
  message: {
    text: string
    type: string
    media?: Buffer | null
  }
  session: {
    userId: string
    agentId: string
    history: ChatEntry[]
  }
}

export const API_KEY_STORAGE_KEY = 'config:api_key'
export const DEFAULT_RECIPIENT_KEY = 'config:default_recipient'

export interface AgentResponse {
  reply: {
    text: string
    media?: {
      type: string
      data: Buffer
      fileName?: string
    } | null
  }
}

export interface SendContent {
  text?: string
  image?: Buffer
  file?: {
    data: Buffer
    fileName: string
  }
  video?: Buffer
  caption?: string
}

export interface NotificationRule {
  id: string
  type: 'cron' | 'event'
  schedule?: string
  event?: string
  userId?: string
  content: SendContent
}

export interface NotificationLog {
  id: string
  ruleId?: string
  userId: string
  content: SendContent
  status: 'success' | 'failed'
  error?: string
  timestamp: number
}

export interface BotStatus {
  loggedIn: boolean
  accountId?: string
  currentUser?: string
  qrUrl?: string
  polling: boolean
}

export interface CommandResult {
  type: 'switch' | 'help' | 'agents' | 'status' | 'clear' | 'message' | 'unknown'
  targetAgentId?: string
}

export interface Storage {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  clear(): Promise<void>
  listKeys(prefix?: string): Promise<string[]>
}
