import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, setToken, clearToken } from '../composables/api'

export const useAuthStore = defineStore('auth', () => {
  const authenticated = ref(false)
  const passwordSet = ref(false)
  const loading = ref(false)

  const needsSetup = computed(() => !passwordSet.value)
  const isLoggedIn = computed(() => authenticated.value)

  async function checkStatus() {
    try {
      const res = await api.get<{ authenticated: boolean; passwordSet?: boolean; expired?: boolean }>(
        '/api/auth/status',
      )
      authenticated.value = res.authenticated
      passwordSet.value = res.passwordSet ?? false
      // 如果 token 过期但密码已设置，需要重新登录
      if (res.expired) {
        authenticated.value = false
        clearToken()
      }
    } catch {
      authenticated.value = false
    }
  }

  async function login(password: string) {
    loading.value = true
    try {
      const res = await api.post<{ authenticated: boolean; expiresAt?: number }>(
        '/api/auth/login',
        { password },
      )
      if (res.authenticated) {
        // Token 由 HttpOnly Cookie 设置，前端只记录过期时间
        setToken('', res.expiresAt)
        authenticated.value = true
        passwordSet.value = true
      }
      return res
    } finally {
      loading.value = false
    }
  }

  async function setup(password: string) {
    loading.value = true
    try {
      const res = await api.post<{ ok: boolean; expiresAt?: number }>(
        '/api/auth/setup',
        { password },
      )
      // Token 由 HttpOnly Cookie 设置，前端只记录过期时间
      setToken('', res.expiresAt)
      authenticated.value = true
      passwordSet.value = true
      return res
    } finally {
      loading.value = false
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post<{ ok: boolean; expiresAt?: number }>(
      '/api/auth/change-password',
      { oldPassword, newPassword },
    )
    // Token 由 HttpOnly Cookie 设置，前端只记录过期时间
    setToken('', res.expiresAt)
    return res
  }

  async function logout() {
    try {
      await api.post('/api/auth/logout')
    } catch { /* ignore */ }
    clearToken()
    authenticated.value = false
    passwordSet.value = true  // 密码仍存在，只是 token 失效
  }

  return {
    authenticated,
    passwordSet,
    loading,
    needsSetup,
    isLoggedIn,
    checkStatus,
    login,
    setup,
    changePassword,
    logout,
  }
})
