import type { Request, Response, NextFunction } from 'express'
import type { Logger } from 'pino'

export function loggingMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now()

    res.on('finish', () => {
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: Date.now() - start,
        ip: req.ip,
      })
    })

    next()
  }
}
