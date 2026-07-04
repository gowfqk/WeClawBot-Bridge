import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AgentConfig } from './types'

const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  type: z.enum(['http', 'cli']).default('http'),
  description: z.string(),
  endpoint: z.string().optional(),
  timeout: z.number().int().positive().default(30000),
  headers: z.record(z.string(), z.string()).optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  format: z.enum(['native', 'openai']).optional(),
  streaming: z.boolean().optional(),
  responsePath: z.string().optional(),
  cliCommand: z.string().optional(),
  cliArgs: z.array(z.string()).optional(),
  cliWorkDir: z.string().optional(),
  cliMode: z.enum(['oneshot', 'persistent']).optional(),
  cliSentinel: z.string().optional(),
})

const AgentsFileSchema = z.object({
  agents: z.array(AgentConfigSchema),
  defaultAgentId: z.string().optional(),
})

export interface AppConfig {
  port: number
  storageDir: string
  encryptionKey: string
  apiKey: string
  logLevel: string
  agents: AgentConfig[]
  defaultAgentId: string | undefined
  sessionMaxRounds: number
  sessionExpireMs: number
}

function loadFromEnv(): Partial<AppConfig> {
  return {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
    storageDir: process.env.STORAGE_DIR,
    encryptionKey: process.env.ENCRYPTION_KEY,
    apiKey: process.env.API_KEY,
    logLevel: process.env.LOG_LEVEL,
    sessionMaxRounds: process.env.SESSION_MAX_ROUNDS
      ? parseInt(process.env.SESSION_MAX_ROUNDS, 10)
      : undefined,
    sessionExpireMs: process.env.SESSION_EXPIRE_MS
      ? parseInt(process.env.SESSION_EXPIRE_MS, 10)
      : undefined,
  }
}

let cachedConfig: AppConfig | null = null
let cachedAgentsPath: string | undefined

function resolveAgentsPath(configPath?: string, env?: Partial<AppConfig>): string {
  if (configPath) return configPath
  if (env?.storageDir) return path.join(env.storageDir, 'agents.json')
  return path.resolve(__dirname, '../config/agents.json')
}

export function loadConfig(configPath?: string): AppConfig {
  const env = loadFromEnv()

  const agentsPath = resolveAgentsPath(configPath, env)
  cachedAgentsPath = agentsPath

  let agents: AgentConfig[] = []
  let defaultAgentId: string | undefined

  if (fs.existsSync(agentsPath)) {
    const raw = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'))
    const parsed = AgentsFileSchema.parse(raw)
    agents = parsed.agents
    defaultAgentId = parsed.defaultAgentId
  }

  cachedConfig = {
    port: env.port || 3000,
    storageDir: env.storageDir || path.resolve(process.cwd(), '.wechatbot-gateway'),
    encryptionKey: env.encryptionKey || '',
    apiKey: env.apiKey || '',
    logLevel: env.logLevel || 'info',
    agents,
    defaultAgentId,
    sessionMaxRounds: env.sessionMaxRounds ?? 0,  // 0 = 不限制轮次
    sessionExpireMs: env.sessionExpireMs ?? 0,  // 0 = 永不过期
  }

  return cachedConfig
}

export function saveAgents(agents: AgentConfig[], defaultAgentId?: string): void {
  if (!cachedAgentsPath) {
    cachedAgentsPath = resolveAgentsPath()
  }
  const dir = path.dirname(cachedAgentsPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const data = { agents, defaultAgentId }
  fs.writeFileSync(cachedAgentsPath, JSON.stringify(data, null, 2), 'utf-8')
  if (cachedConfig) {
    cachedConfig.agents = agents
    if (defaultAgentId !== undefined) {
      cachedConfig.defaultAgentId = defaultAgentId
    }
  }
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig()
  }
  return cachedConfig
}

export function reloadConfig(configPath?: string): AppConfig {
  cachedConfig = null
  return loadConfig(configPath)
}
