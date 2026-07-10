<template>
  <div>
    <n-grid :cols="1" :y-gap="20">
      <!-- Bot 状态 -->
      <n-gi>
        <n-card title="Bot 状态">
          <n-descriptions bordered :column="2">
            <n-descriptions-item label="在线状态">
              <n-tag :type="botStatus.loggedIn ? 'success' : 'error'" round>
                {{ botStatus.loggedIn ? '在线' : '离线' }}
              </n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="账号">
              {{ botStatus.accountId || '-' }}
            </n-descriptions-item>
            <n-descriptions-item label="通知目标">
              {{ botStatus.currentUser || '-' }}
            </n-descriptions-item>
            <n-descriptions-item label="轮询状态">
              <n-tag :type="botStatus.polling ? 'success' : 'default'" size="small" round>
                {{ botStatus.polling ? '运行中' : '停止' }}
              </n-tag>
            </n-descriptions-item>
          </n-descriptions>
        </n-card>
      </n-gi>

      <!-- 二维码登录 -->
      <n-gi>
        <n-card title="微信扫码登录">
          <n-space vertical align="center">
            <template v-if="botStatus.loggedIn">
              <n-result status="success" title="已登录" :description="`账号: ${botStatus.accountId || botStatus.currentUser}`" />
            </template>
            <template v-else-if="botStatus.qrUrl">
              <div class="qr-container">
                <QrcodeVue :value="botStatus.qrUrl" :size="240" level="M" />
              </div>
              <n-text depth="3" style="font-size: 13px">
                请使用微信扫描二维码登录
              </n-text>
              <n-text depth="3" style="font-size: 12px">
                二维码将自动刷新，也可手动点击刷新
              </n-text>
            </template>
            <template v-else>
              <n-text depth="3">点击下方按钮获取登录二维码</n-text>
            </template>

            <n-button
              v-if="!botStatus.loggedIn"
              type="primary"
              :loading="loginLoading"
              @click="handleLogin"
              style="margin-top: 12px"
            >
              {{ botStatus.qrUrl ? '刷新二维码' : '获取登录二维码' }}
            </n-button>
          </n-space>
        </n-card>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useMessage } from 'naive-ui'
import QrcodeVue from 'qrcode.vue'
import { api } from '../composables/api'

interface BotStatusInfo {
  loggedIn: boolean
  accountId?: string
  currentUser?: string
  qrUrl?: string
  polling: boolean
}

const message = useMessage()
const botStatus = ref<BotStatusInfo>({ loggedIn: false, polling: false })
const loginLoading = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function loadStatus() {
  try {
    botStatus.value = await api.get<BotStatusInfo>('/api/bot/status')
  } catch {
    // 静默失败
  }
}

async function handleLogin() {
  loginLoading.value = true
  try {
    const res = await api.post<{ qrUrl?: string; status: string }>('/api/bot/login')
    if (res.qrUrl) {
      botStatus.value.qrUrl = res.qrUrl
      botStatus.value.loggedIn = false
      message.info('二维码已生成，请用微信扫码')
    }
    // 立即刷新状态
    setTimeout(loadStatus, 2000)
  } catch (e: any) {
    message.error(e.message)
  } finally {
    loginLoading.value = false
  }
}

onMounted(() => {
  loadStatus()
  // 每 5 秒自动刷新 Bot 状态
  pollTimer = setInterval(loadStatus, 5000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.qr-container {
  padding: 16px;
  border-radius: 12px;
  background: var(--n-color, #fff);
  display: inline-block;
}
</style>
