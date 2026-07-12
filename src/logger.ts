import pino from 'pino'

/** 生产镜像会移除 devDependencies，因此仅在明确的开发环境加载 pino-pretty。 */
export function getLoggerOptions(): pino.LoggerOptions {
  return {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  }
}

/** 全局共享 logger 实例 */
export const logger = pino(getLoggerOptions())

/** 为子模块创建子 logger */
export function createLogger(module: string) {
  return logger.child({ module })
}
