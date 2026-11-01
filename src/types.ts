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

export interface AgentMedia {
  type: string
  data: Buffer
  fileName?: string
  format?: string
}

export interface AgentPayload {
  message: {
    text: string
    type: string
    /** Internal Buffer or structured media; transports serialize it as base64. */
    media?: Buffer | AgentMedia | null
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
      format?: string
    } | null
  }
  /** 供 HTTP /v1 等程序化调用方识别下游故障；微信仍可显示 reply.text。 */
  error?: {
    message: string
    status: 429 | 502 | 503 | 504
    code: string
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

/** 出站发送记录的来源：通知规则、定时任务、对话回复 */
export type SendLogSource = 'notify' | 'task' | 'reply'

/** 发送记录里的内容摘要 — 媒体只留类型和字节数，不把 Buffer 写进存储。 */
export interface SendLogContent {
  text?: string
  media?: {
    kind: 'image' | 'video' | 'file'
    fileName?: string
    bytes: number
  }
}

export interface NotificationLog {
  id: string
  ruleId?: string
  /** 缺省 = 本次改造之前的历史记录，等同于 'notify' */
  source?: SendLogSource
  userId: string
  content: SendLogContent
  /** 触发本轮发送的用户消息摘要，仅对话回复路径写入 */
  trigger?: string
  status: 'success' | 'failed'
  error?: string
  timestamp: number
}

export type ScheduledTaskKind = 'once' | 'interval' | 'cron'
export type ScheduledTaskSource = 'text' | 'agent'
export type ScheduledTaskRunStatus = 'success' | 'failed' | 'skipped'

export interface ScheduledTask {
  id: string
  name: string
  enabled: boolean
  kind: ScheduledTaskKind
  /** kind=once：绝对时间戳（毫秒） */
  runAt?: number
  /** kind=interval：间隔分钟数 */
  everyMinutes?: number
  /** kind=cron：5/6 段 cron 表达式 */
  schedule?: string
  /** kind=cron：IANA 时区，缺省 Asia/Shanghai */
  timezone?: string
  /** text=直接推送 text；agent=先调用 agentId 再把回复推给用户 */
  source: ScheduledTaskSource
  text?: string
  agentId?: string
  prompt?: string
  /** 留空则发给当前绑定的微信用户 */
  userId?: string
  createdAt: number
  /** 下一次应执行的时刻；null/undefined 表示不再有下次 */
  nextRunAt?: number | null
  lastRunAt?: number
  lastStatus?: ScheduledTaskRunStatus
  lastError?: string
  runCount: number
}

export interface BotStatus {
  loggedIn: boolean
  accountId?: string
  currentUser?: string
  qrUrl?: string
  polling: boolean
  /** 微信 SDK 最近一次上报的错误 — 消息没送达时的主要线索 */
  lastError?: { at: number; message: string }
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
