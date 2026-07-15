/** 统一 API 请求封装 */

// Token 现在通过 HttpOnly Cookie 自动携带，不再存储在 localStorage
// 仅保留 tokenExpiresAt 用于前端判断是否过期（跳转登录页）

let tokenExpiresAt = 0

export function setToken(_token: string, expiresAt?: number) {
  // Token 由服务端通过 HttpOnly Cookie 设置，前端无需手动存储
  tokenExpiresAt = expiresAt || 0
  if (expiresAt) localStorage.setItem('auth_expires', String(expiresAt))
}

export function clearToken() {
  tokenExpiresAt = 0
  localStorage.removeItem('auth_expires')
}

export function isTokenExpired(): boolean {
  if (!tokenExpiresAt) {
    tokenExpiresAt = Number(localStorage.getItem('auth_expires') || 0)
  }
  return tokenExpiresAt > 0 && Date.now() > tokenExpiresAt
}

export function authHeaders(): Record<string, string> {
  // Cookie 由浏览器自动携带，此处仅用于非浏览器客户端（curl 等）的 Bearer Token 回退
  // 浏览器环境下不设置 Authorization header，让 cookie 生效
  return {}
}

/** 处理 401/403 认证错误 */
function handleAuthError(status: number, data: Record<string, unknown>): boolean {
  if (status === 401 && data.code === 'TOKEN_EXPIRED') {
    clearToken()
    window.location.reload()
    return true
  }
  if (status === 403 && data.code === 'PASSWORD_NOT_SET') {
    clearToken()
    window.location.href = '/login'
    return true
  }
  return false
}

export async function request<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const hasBody = options.body !== undefined
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...authHeaders(),
    ...(options.headers as Record<string, string> || {}),
  }

  // credentials: 'include' 确保 HttpOnly Cookie 在所有场景下携带（含 SameSite=None）
  const res = await fetch(url, { ...options, headers, credentials: 'include' })

  if (res.status === 401 || res.status === 403) {
    const data = await res.json().catch(() => ({}))
    if (handleAuthError(res.status, data)) {
      throw new Error(data.error || '认证失败')
    }
    throw new Error(data.error || (res.status === 401 ? '认证失败' : '禁止访问'))
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `请求失败 (${res.status})`)
  }

  return res.json()
}

export const api = {
  get: <T = unknown>(url: string) =>
    request<T>(url),

  post: <T = unknown>(url: string, body?: unknown) =>
    request<T>(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),

  put: <T = unknown>(url: string, body: unknown) =>
    request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),

  del: <T = unknown>(url: string, body?: unknown) =>
    request<T>(url, {
      method: 'DELETE',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  /** 下载文件（返回 blob） */
  download: async (url: string) => {
    const res = await fetch(url, { headers: authHeaders(), credentials: 'include' })
    if (res.status === 401 || res.status === 403) {
      const data = await res.json().catch(() => ({}))
      handleAuthError(res.status, data)
      throw new Error(data.error || '认证失败')
    }
    if (!res.ok) throw new Error(`下载失败 (${res.status})`)
    return res.blob()
  },

  /** 上传 JSON 文件 */
  uploadJson: async (url: string, data: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'include',
    })
    if (res.status === 401 || res.status === 403) {
      const err = await res.json().catch(() => ({}))
      handleAuthError(res.status, err)
      throw new Error(err.error || '认证失败')
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `上传失败 (${res.status})`)
    }
    return res.json()
  },
}
