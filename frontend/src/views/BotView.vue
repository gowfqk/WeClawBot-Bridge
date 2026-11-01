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
            <n-descriptions-item label="最近 SDK 错误" :span="2">
              <template v-if="botStatus.lastError">
                <n-space align="center" :size="8">
                  <n-time :time="botStatus.lastError.at" type="datetime" />
                  <span style="font-size: 12px">{{ botStatus.lastError.message }}</span>
                </n-space>
              </template>
              <span v-else>无</span>
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
              <n-button
                type="error"
                ghost
                :loading="unbindLoading"
                @click="handleUnbind"
                style="margin-top: 12px"
              >
                解除绑定
              </n-button>
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
      <!-- Session 过期提醒 -->
      <n-gi>
        <n-card title="Session 过期提醒">
          <n-space vertical :size="14">
            <n-alert
              v-if="alert.outageStartedAt"
              type="error"
              :bordered="false"
              title="微信连接已失效"
            >
              连接于 {{ clock(alert.outageStartedAt) }} 过期，需要你重新扫码登录。
              {{ alert.settings.pushEnabled ? '恢复后会在你的下一条微信消息里补发提醒。' : '补发提醒已关闭，恢复后不会再提示。' }}
              {{ outageWebhookText }}
            </n-alert>
            <n-alert
              v-else-if="alert.pendingAlert"
              type="warning"
              :bordered="false"
              title="掉线提醒待补发"
            >
              {{ clock(alert.pendingAlert.expiredAt) }}–{{ clock(alert.pendingAlert.restoredAt || 0) }}
              离线 {{ offlineText(alert.pendingAlert) }}，等你发一条微信消息后自动补发提醒。
            </n-alert>

            <n-space :size="28">
              <n-space align="center" :size="8">
                <n-switch
                  :value="alert.settings.recordEnabled"
                  :loading="alertSaving"
                  @update:value="(value: boolean) => saveAlertSettings({ recordEnabled: value })"
                />
                <n-text>记录掉线事件</n-text>
              </n-space>
              <n-space align="center" :size="8">
                <n-switch
                  :value="alert.settings.pushEnabled"
                  :loading="alertSaving"
                  @update:value="(value: boolean) => saveAlertSettings({ pushEnabled: value })"
                />
                <n-text>恢复后补发微信提醒</n-text>
              </n-space>
            </n-space>

            <n-space vertical :size="10">
              <n-space align="center" :size="8">
                <n-switch
                  :value="alert.settings.webhookEnabled"
                  :loading="alertSaving"
                  @update:value="(value: boolean) => saveAlertSettings({ webhookEnabled: value })"
                />
                <n-text>Webhook 实时推送</n-text>
                <n-text depth="3" style="font-size: 12px">
                  掉线与恢复各推一次到外部地址，这是唯一能实时送达的提醒方式
                </n-text>
              </n-space>
              <n-space v-if="alert.settings.webhookEnabled" align="center" :size="8">
                <n-input
                  v-model:value="webhookUrlDraft"
                  size="small"
                  style="width: 340px"
                  placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                  @keyup.enter="saveWebhookTarget"
                />
                <n-select
                  v-model:value="webhookFormatDraft"
                  size="small"
                  style="width: 150px"
                  :options="webhookFormatOptions"
                />
                <n-button
                  size="small"
                  :loading="alertSaving"
                  :disabled="webhookTargetUnchanged"
                  @click="saveWebhookTarget"
                >
                  保存
                </n-button>
              </n-space>
            </n-space>

            <n-text depth="3" style="font-size: 12px">
              token 过期那一刻微信通道本身就是断的，微信侧的实时提醒做不到：事件先落在下面这张表，
              重新扫码恢复后再借第一条进来的消息补发提醒。
            </n-text>

            <n-data-table
              v-if="gapRows.length"
              :columns="gapColumns"
              :data="gapRows"
              :row-key="(row: GapRow) => row.id"
              size="small"
            />
            <n-empty v-else description="暂无掉线记录" size="small" />
          </n-space>
        </n-card>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useMessage, useDialog } from 'naive-ui'
import QrcodeVue from 'qrcode.vue'
import { api } from '../composables/api'

interface BotStatusInfo {
  loggedIn: boolean
  accountId?: string
  currentUser?: string
  qrUrl?: string
  polling: boolean
  lastError?: { at: number; message: string }
}

interface WebhookAttempt {
  status: 'sent' | 'failed'
  error?: string
}

interface SessionGap {
  id: string
  expiredAt: number
  restoredAt?: number
  missedPushes: number
  alertedAt?: number
  alertError?: string
  webhook?: { expired?: WebhookAttempt; restored?: WebhookAttempt }
}

interface SessionAlertSettings {
  recordEnabled: boolean
  pushEnabled: boolean
  webhookEnabled: boolean
  webhookUrl: string
  webhookFormat: 'json' | 'text'
}

interface SessionAlertState {
  settings: SessionAlertSettings
  gaps: SessionGap[]
  pendingAlert: SessionGap | null
  outageStartedAt: number | null
  outageWebhook?: WebhookAttempt
}

interface GapRow {
  id: string
  expired: string
  restored: string
  offline: string
  missed: string
  alert: string
  webhook: string
}

const message = useMessage()
const dialog = useDialog()
const botStatus = ref<BotStatusInfo>({ loggedIn: false, polling: false })
const loginLoading = ref(false)
const unbindLoading = ref(false)
const alert = ref<SessionAlertState>({
  settings: { recordEnabled: true, pushEnabled: true, webhookEnabled: false, webhookUrl: '', webhookFormat: 'json' },
  gaps: [],
  pendingAlert: null,
  outageStartedAt: null,
})
const alertSaving = ref(false)
const webhookUrlDraft = ref('')
const webhookFormatDraft = ref<string>('json')
let webhookDraftLoaded: { url: string; format: string } = { url: '', format: 'json' }
let pollTimer: ReturnType<typeof setInterval> | null = null

const webhookFormatOptions = [
  { label: 'JSON（自建接收端）', value: 'json' },
  { label: '群机器人 text', value: 'text' },
]

// 与后端文案统一按北京时间显示
const clockFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Shanghai',
})

function clock(at: number): string {
  return clockFormat.format(new Date(at)).replace(/[/.]/g, '-')
}

function offlineText(gap: SessionGap): string {
  if (!gap.restoredAt) return '未恢复'
  const minutes = Math.max(0, Math.round((gap.restoredAt - gap.expiredAt) / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

function alertText(gap: SessionGap): string {
  if (gap.alertedAt) return `已送达 ${clock(gap.alertedAt)}`
  if (gap.alertError) return `补发失败：${gap.alertError}`
  if (gap.restoredAt) return '待你发下一条微信消息'
  return '等待重新扫码'
}

function webhookTag(attempt?: WebhookAttempt): string {
  if (!attempt) return '未推送'
  return attempt.status === 'sent' ? '已送达' : `失败：${attempt.error ?? '未知原因'}`
}

function webhookText(gap: SessionGap): string {
  if (!gap.webhook) return '未启用'
  return `失效 ${webhookTag(gap.webhook.expired)} · 恢复 ${webhookTag(gap.webhook.restored)}`
}

const gapColumns = [
  { title: '失效时间', key: 'expired' },
  { title: '恢复时间', key: 'restored' },
  { title: '离线时长', key: 'offline' },
  { title: '漏推', key: 'missed' },
  { title: '提醒状态', key: 'alert' },
  { title: 'Webhook', key: 'webhook' },
]

const gapRows = computed<GapRow[]>(() => alert.value.gaps.map((gap) => ({
  id: gap.id,
  expired: clock(gap.expiredAt),
  restored: gap.restoredAt ? clock(gap.restoredAt) : '-',
  offline: offlineText(gap),
  missed: `${gap.missedPushes} 条`,
  alert: alertText(gap),
  webhook: webhookText(gap),
})))

async function loadStatus() {
  try {
    botStatus.value = await api.get<BotStatusInfo>('/api/bot/status')
  } catch {
    // 静默失败
  }
}

async function loadAlert() {
  try {
    alert.value = await api.get<SessionAlertState>('/api/session-alert')
    syncWebhookDraft()
  } catch {
    // 静默失败
  }
}

/** 输入框没被改动时用后端值刷新；正在编辑则保留用户输入的半截 URL。 */
function syncWebhookDraft() {
  const settings = alert.value.settings
  if (webhookUrlDraft.value === webhookDraftLoaded.url && webhookFormatDraft.value === webhookDraftLoaded.format) {
    webhookUrlDraft.value = settings.webhookUrl
    webhookFormatDraft.value = settings.webhookFormat
  }
  webhookDraftLoaded = { url: settings.webhookUrl, format: settings.webhookFormat }
}

const webhookTargetUnchanged = computed(() => {
  const settings = alert.value.settings
  return webhookUrlDraft.value.trim() === settings.webhookUrl && webhookFormatDraft.value === settings.webhookFormat
})

const outageWebhookText = computed(() => {
  const attempt = alert.value.outageWebhook
  if (!attempt) return ''
  return attempt.status === 'sent'
    ? '外部 webhook 提醒已推送。'
    : `外部 webhook 提醒推送失败：${attempt.error ?? '未知原因'}`
})

async function saveAlertSettings(patch: Partial<SessionAlertSettings>) {
  alertSaving.value = true
  try {
    const res = await api.put<{ settings: SessionAlertSettings }>('/api/session-alert', patch)
    alert.value.settings = res.settings
    syncWebhookDraft()
    message.success('提醒设置已保存')
  } catch (e: any) {
    message.error(e.message)
    await loadAlert()
  } finally {
    alertSaving.value = false
  }
}

async function saveWebhookTarget() {
  if (webhookTargetUnchanged.value) return
  await saveAlertSettings({
    webhookUrl: webhookUrlDraft.value.trim(),
    webhookFormat: webhookFormatDraft.value as SessionAlertSettings['webhookFormat'],
  })
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

function handleUnbind() {
  dialog.warning({
    title: '确认解除绑定',
    content: '解绑后当前微信账号将断开连接，需重新扫码才能继续使用。确认继续？',
    positiveText: '解除绑定',
    negativeText: '取消',
    onPositiveClick: async () => {
      unbindLoading.value = true
      try {
        await api.post('/api/bot/unbind')
        botStatus.value = { loggedIn: false, polling: false }
        message.success('已解除绑定，可重新扫码绑定新账号')
      } catch (e: any) {
        message.error(e.message)
      } finally {
        unbindLoading.value = false
      }
    },
  })
}

onMounted(() => {
  loadStatus()
  loadAlert()
  // 每 5 秒自动刷新 Bot 状态与掉线记录
  pollTimer = setInterval(() => {
    loadStatus()
    loadAlert()
  }, 5000)
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
