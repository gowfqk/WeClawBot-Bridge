import type { Request, Response, NextFunction } from 'express'

interface RateLimitStore {
  [ip: string]: { count: number; resetAt: number }
}

export function rateLimitMiddleware(maxRequests: number = 60, windowMs: number = 60_000) {
  const store: RateLimitStore = {}

  setInterval(() => {
    const now = Date.now()
    for (const ip of Object.keys(store)) {
      if (store[ip].resetAt < now) {
        delete store[ip]
      }
    }
  }, windowMs)

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()

    if (!store[ip] || store[ip].resetAt < now) {
      store[ip] = { count: 1, resetAt: now + windowMs }
      next()
      return
    }

    store[ip].count++

    if (store[ip].count > maxRequests) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }

    next()
  }
}
