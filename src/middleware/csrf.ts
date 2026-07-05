import type { Request, Response, NextFunction } from 'express'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF protection via Origin/Referer verification.
 *
 * For mutating requests (POST/PUT/DELETE/PATCH) from browsers, this middleware
 * checks that the Origin (or Referer) header matches the server's Host or is
 * in the explicit allow-list. Non-browser requests (no Origin/Referer) are
 * allowed through — Bearer token auth already protects them.
 *
 * This follows the OWASP-recommended "Origin Verification" approach:
 * https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#origin-header-verification
 */
export function csrfOriginMiddleware(allowedOrigins?: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip safe (read-only) methods
    if (SAFE_METHODS.has(req.method)) {
      next()
      return
    }

    const origin = req.headers.origin
    const referer = req.headers.referer

    // No Origin or Referer → likely a non-browser client (curl, SDK, etc.)
    // Bearer token auth provides CSRF protection for these.
    if (!origin && !referer) {
      next()
      return
    }

    // Check Origin header
    if (origin) {
      if (isOriginAllowed(origin, req, allowedOrigins)) {
        next()
        return
      }
      res.status(403).json({ error: 'CSRF: Origin not allowed' })
      return
    }

    // Fallback: derive origin from Referer header
    if (referer) {
      try {
        const refererOrigin = new URL(referer).origin
        if (isOriginAllowed(refererOrigin, req, allowedOrigins)) {
          next()
          return
        }
      } catch {
        // Invalid Referer URL — reject
      }
      res.status(403).json({ error: 'CSRF: Referer origin not allowed' })
      return
    }

    next()
  }
}

function isOriginAllowed(
  origin: string,
  req: Request,
  allowedOrigins?: string[],
): boolean {
  // Always allow same-origin requests (Origin matches Host)
  const host = req.headers.host
  if (host) {
    // Check both http and https schemes against the Host header
    if (origin === `http://${host}` || origin === `https://${host}`) {
      return true
    }
  }

  // Check explicit allow-list
  if (allowedOrigins && allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin)
  }

  return false
}
