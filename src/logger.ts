import pino from 'pino'

/** 全局共享 logger 实例 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
})

/** 为子模块创建子 logger */
export function createLogger(module: string) {
  return logger.child({ module })
}
