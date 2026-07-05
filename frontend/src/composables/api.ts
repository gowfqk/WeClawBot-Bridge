/** 统一 API 请求封装 */

let authToken = ''
let tokenExpiresAt = 0

export function setToken(token: string, expiresAt?: number) {
  authToken = token
  tokenExpiresAt = expiresAt || 0
  localStorage.setItem('auth_token', token)
  if (expiresAt) localStorage.setItem('auth_expires', String(expiresAt))
}

export function clearToken() {
  authToken = ''
  tokenExpiresAt = 0
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_expires')
}

export function getToken(): string {
  if (!authToken) {
    authToken = localStorage.getItem('auth_token') || ''
    tokenExpiresAt = Number(localStorage.getItem('auth_expires') || 0)
  }
  // 检查是否过期
  if (tokenExpiresAt && Date.now() > tokenExpiresAt) {
    clearToken()
    return ''
  }
  return authToken
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
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

  const res = await fetch(url, { ...options, headers })

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

  del: <T = unknown>(url: string) =>
    request<T>(url, { method: 'DELETE' }),

  /** 下载文件（返回 blob） */
  download: async (url: string) => {
    const res = await fetch(url, { headers: authHeaders() })
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
