import type { Request, Response, NextFunction } from 'express'

export function authMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiKey) {
      next()
      return
    }

    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const token = authHeader.slice(7)
    if (token !== apiKey) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    next()
  }
}
