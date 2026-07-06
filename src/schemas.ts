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
  type: z.enum(['cli', 'http']),
  description: z.string(),
  endpoint: z.string().optional(),
  timeout: z.number().int().positive().max(300000),
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
})

/** 通知发送 */
export const NotifySchema = z.object({
  userId: z.string().min(1),
  content: z.object({
    text: z.string().min(1),
  }),
})

/** 通知规则 */
export const NotifyRuleSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
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

/** 配置导入（兼容旧版：description/timeout 可缺，新字段全部 optional） */
export const ConfigImportSchema = z.object({
  version: z.number().optional(),
  exportedAt: z.string().optional(),
  agents: z.array(AgentConfigSchema).optional(),
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
