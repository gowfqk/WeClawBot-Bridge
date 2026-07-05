<template>
  <n-layout has-sider style="height: 100vh">
    <!-- 侧边栏 -->
    <n-layout-sider
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="220"
      :collapsed="collapsed"
      show-trigger
      @collapse="collapsed = true"
      @expand="collapsed = false"
      :native-scrollbar="false"
      style="min-height: 100vh"
    >
      <div class="sider-header">
        <span class="logo-icon">🤖</span>
        <transition name="fade">
          <span v-if="!collapsed" class="logo-text">WeClawBot</span>
        </transition>
      </div>
      <n-menu
        :collapsed="collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="menuOptions"
        :value="currentRoute"
        @update:value="handleMenuSelect"
      />
    </n-layout-sider>

    <!-- 主内容区 -->
    <n-layout>
      <n-layout-header bordered style="height: 56px; display: flex; align-items: center; padding: 0 20px; justify-content: space-between">
        <div style="display: flex; align-items: center; gap: 12px">
          <span style="font-size: 15px; font-weight: 600">🤖 WeClawBot Bridge</span>
          <n-tag :type="botOnline ? 'success' : 'error'" size="small" round>
            {{ botOnline ? '在线' : '离线' }}
          </n-tag>
        </div>
        <div style="display: flex; align-items: center; gap: 12px">
          <n-button quaternary circle @click="themeStore.toggleTheme">
            <template #icon>
              <n-icon><sunny-outline v-if="themeStore.isDark" /><moon-outline v-else /></n-icon>
            </template>
          </n-button>
          <n-button quaternary size="small" @click="handleLogout">
            退出
          </n-button>
        </div>
      </n-layout-header>
      <n-layout-content
        content-style="padding: 24px"
        :native-scrollbar="false"
      >
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NIcon } from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useAuthStore } from '../stores/auth'
import { api } from '../composables/api'
import {
  SunnyOutline,
  MoonOutline,
  RocketOutline,
  PhonePortraitOutline,
  NotificationsOutline,
  ChatbubblesOutline,
  SettingsOutline,
  BookOutline,
} from '@vicons/ionicons5'

const router = useRouter()
const route = useRoute()
const themeStore = useThemeStore()
const authStore = useAuthStore()

const collapsed = ref(false)
const botOnline = ref(false)
let statusTimer: ReturnType<typeof setInterval> | null = null

function renderIcon(icon: any) {
  return () => h(NIcon, null, { default: () => h(icon) })
}

const menuOptions: MenuOption[] = [
  { label: 'Agent 管理', key: '/agents', icon: renderIcon(RocketOutline) },
  { label: 'Bot 控制', key: '/bot', icon: renderIcon(PhonePortraitOutline) },
  { label: '通知管理', key: '/notify', icon: renderIcon(NotificationsOutline) },
  { label: '会话管理', key: '/sessions', icon: renderIcon(ChatbubblesOutline) },
  { label: '设置', key: '/settings', icon: renderIcon(SettingsOutline) },
  { label: 'API 参考', key: '/api', icon: renderIcon(BookOutline) },
]

const currentRoute = computed(() => route.path)

function handleMenuSelect(key: string) {
  router.push(key)
}

async function handleLogout() {
  await authStore.logout()
  router.push('/login')
}

async function pollBotStatus() {
  try {
    const res = await api.get<{ loggedIn: boolean }>('/api/bot/status')
    botOnline.value = res.loggedIn
  } catch {
    botOnline.value = false
  }
}

onMounted(() => {
  pollBotStatus()
  statusTimer = setInterval(pollBotStatus, 10000)
})

onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer)
})
</script>

<style scoped>
.sider-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 56px;
  border-bottom: 1px solid var(--n-border-color);
  padding: 0 16px;
  white-space: nowrap;
  overflow: hidden;
}
.logo-icon {
  font-size: 24px;
  flex-shrink: 0;
}
.logo-text {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.5px;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
