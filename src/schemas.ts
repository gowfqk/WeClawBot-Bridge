import { z } from 'zod'

/** 登录请求 */
export const LoginSchema = z.object({
  password: z.string().min(1, '请输入密码'),
})

/** 初始设置密码 */
export const SetupSchema = z.object({
  password: z.string().min(8, '密码至少8位'),
})

/** 修改密码 */
export const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码至少8位'),
})

/** 配置更新 */
export const ConfigSchema = z.object({
  apiKey: z.string().optional(),
})

/** Agent 配置 — 与 types.AgentConfig 保持同步 */
export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  type: z.enum(['cli', 'http', 'ws', 'ws-remote']),
  description: z.string(),
  endpoint: z.string().optional(),
  // 允许长运行 Agent 自行配置超时；不设上限。
  timeout: z.number().int().positive(),
  headers: z.record(z.string(), z.string()).optional(),
  cliEnv: z.record(z.string(), z.string()).optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  format: z.enum(['native', 'openai', 'qwenpaw']).optional(),
  streaming: z.boolean().optional(),
  responsePath: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxHistory: z.number().int().positive().max(100).optional(),
  cliCommand: z.string().optional(),
  cliArgs: z.array(z.string()).optional(),
  cliWorkDir: z.string().optional(),
  cliMode: z.enum(['oneshot', 'persistent']).optional(),
  cliSentinel: z.string().optional(),
  wsUrl: z.string().optional(),
  wsReconnectInterval: z.number().int().positive().max(60000).optional(),
  wsHeartbeatInterval: z.number().int().positive().max(120000).optional(),
  wsMaxReconnectAttempts: z.number().int().nonnegative().optional(),
})

/** 通知发送 */
export const NotifySchema = z.object({
  userId: z.string().min(1).optional(),
  content: z.object({
    text: z.string().min(1),
  }),
})

/** 通知规则 */
export const NotifyRuleSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1).optional(),
  content: z.object({
    text: z.string().min(1),
  }),
  type: z.enum(['cron', 'event']),
  schedule: z.string().optional(),
  event: z.string().optional(),
})

/** 会话配置 */
export const SessionConfigSchema = z.object({
  maxRounds: z.number().int().nonnegative().max(200).optional(),
  expireMs: z.number().int().nonnegative().max(86400000 * 7).optional(),
})

/**
 * 定时任务结构校验。kind/source 之间的组合约束（cron 表达式合法性、once 必须
 * 在未来、agent 来源必须有可用 Agent 等）在 scheduled-task.ts 的语义校验里完成。
 */
export const ScheduledTaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, '任务 ID 只能包含字母、数字、下划线和连字符，最长 64 字符'),
  name: z.string().min(1, '请输入任务名称').max(60),
  enabled: z.boolean().optional(),
  kind: z.enum(['once', 'interval', 'cron']),
  runAt: z.number().int().positive().optional(),
  everyMinutes: z.number().int().min(1, '间隔至少 1 分钟').max(60 * 24 * 7, '间隔最多 7 天').optional(),
  schedule: z.string().max(120).optional(),
  timezone: z.string().max(64).optional(),
  source: z.enum(['text', 'agent']),
  text: z.string().max(4000).optional(),
  agentId: z.string().max(128).optional(),
  prompt: z.string().max(4000).optional(),
  userId: z.string().max(128).optional(),
})

export type ScheduledTaskInput = z.infer<typeof ScheduledTaskSchema>

/** 配置导入（兼容旧版：description/timeout 可缺，新字段全部 optional） */
export const ConfigImportSchema = z.object({
  version: z.number().optional(),
  exportedAt: z.string().optional(),
  agents: z.array(AgentConfigSchema),
  notifications: z.array(NotifyRuleSchema).optional(),
  defaultAgentId: z.string().optional(),
  session: z.object({
    maxRounds: z.number().int().nonnegative().max(200).optional(),
    expireMs: z.number().int().nonnegative().max(86400000 * 7).optional(),
  }).optional(),
  apiKey: z.string().optional(),
  // v2 新增：完整会话数据
  sessions: z.array(z.any()).optional(),
  // v2 新增：通知日志
  notifyLogs: z.array(z.any()).optional(),
  // v2 新增：全部存储数据（key-value）
  storageDump: z.record(z.any()).optional(),
})

/** 校验辅助函数 */
export function validate<T>(schema: z.ZodSchema<T>, data: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(data)
  if (result.success) return { ok: true, data: result.data }
  const first = result.error.issues[0]
  return { ok: false, error: first?.message || '输入校验失败' }
}
