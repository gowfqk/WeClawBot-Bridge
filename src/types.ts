export type AgentType = 'http' | 'cli'

export interface AgentConfig {
  id: string
  name: string
  command: string
  type: AgentType
  description: string
  endpoint?: string
  timeout: number
  headers?: Record<string, string>
  apiKey?: string
  model?: string
  format?: 'native' | 'openai'
  streaming?: boolean
  responsePath?: string
  cliCommand?: string
  cliArgs?: string[]
  cliWorkDir?: string
  cliMode?: 'oneshot' | 'persistent'
  cliSentinel?: string
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
  userId: string
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
  type: 'switch' | 'help' | 'agents' | 'status' | 'message' | 'unknown'
  targetAgentId?: string
}

export interface Storage {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  clear(): Promise<void>
}
