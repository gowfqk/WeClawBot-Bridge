import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('../views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('../layouts/AppLayout.vue'),
      children: [
        { path: '', redirect: '/agents' },
        { path: 'agents', name: 'Agents', component: () => import('../views/AgentsView.vue') },
        { path: 'bot', name: 'Bot', component: () => import('../views/BotView.vue') },
        { path: 'notify', name: 'Notify', component: () => import('../views/NotifyView.vue') },
        { path: 'sessions', name: 'Sessions', component: () => import('../views/SessionsView.vue') },
        { path: 'settings', name: 'Settings', component: () => import('../views/SettingsView.vue') },
        { path: 'api', name: 'ApiRef', component: () => import('../views/ApiRefView.vue') },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  // 未认证时总是刷新状态
  if (!auth.isLoggedIn) {
    await auth.checkStatus()
  }

  // 登录页本身始终可访问
  if (to.meta.public) return true

  // 未设密码 → 跳到设置密码页
  if (auth.needsSetup) return { name: 'Login' }
  // 未认证 → 跳到登录页
  if (!auth.isLoggedIn) return { name: 'Login' }
  return true
})

export default router
