<template>
  <div>
    <n-grid :cols="1" :y-gap="20">
      <!-- 会话配置 -->
      <n-gi>
        <n-card title="会话配置">
          <n-form label-placement="left" label-width="120">
            <n-grid :cols="2" :x-gap="16">
              <n-form-item-gi label="最大对话轮次">
                <n-input-number v-model:value="sessionConfig.maxRounds" :min="0" style="width: 100%" />
                <template #feedback>
                  <span style="font-size: 12px; color: var(--n-text-color-3)">0 表示不限制</span>
                </template>
              </n-form-item-gi>
              <n-form-item-gi label="过期时间">
                <n-select v-model:value="sessionConfig.expireMs" :options="expireOptions" style="width: 100%" />
              </n-form-item-gi>
            </n-grid>
            <n-button type="primary" :loading="savingConfig" @click="saveConfig" style="margin-top: 8px">
              保存配置
            </n-button>
          </n-form>
        </n-card>
      </n-gi>

      <!-- 会话列表 -->
      <n-gi>
        <n-card>
          <template #header>
            <n-space align="center">
              <span>会话列表</span>
              <n-tag size="small" round>{{ sessions.length }}</n-tag>
            </n-space>
          </template>
          <template #header-extra>
            <n-space>
              <n-button size="small" @click="loadSessions">刷新</n-button>
              <n-button size="small" type="error" @click="confirmClearAll">清空全部</n-button>
            </n-space>
          </template>

          <n-data-table
            :columns="sessionColumns"
            :data="sessions"
            :bordered="false"
            :pagination="{ pageSize: 15 }"
          />
          <n-empty v-if="sessions.length === 0" description="暂无会话" style="padding: 40px 0" />
        </n-card>
      </n-gi>

      <!-- 会话详情 -->
      <n-gi v-if="selectedSession">
        <n-card>
          <template #header>
            <span>会话详情：{{ selectedSession.agentId }}</span>
          </template>
          <template #header-extra>
            <n-button size="small" @click="selectedSession = null">关闭</n-button>
          </template>

          <n-descriptions bordered :column="2" style="margin-bottom: 16px">
            <n-descriptions-item label="Agent">{{ selectedSession.agentId }}</n-descriptions-item>
            <n-descriptions-item label="消息数">{{ selectedSession.history?.length || 0 }}</n-descriptions-item>
            <n-descriptions-item label="最后活跃">
              <n-time v-if="selectedSession.lastActive" :time="selectedSession.lastActive" type="datetime" />
              <span v-else>-</span>
            </n-descriptions-item>
          </n-descriptions>

          <!-- 对话历史 -->
          <n-card title="对话历史" size="small" embedded style="max-height: 400px; overflow: auto">
            <div v-if="selectedSession.history && selectedSession.history.length > 0" class="chat-history">
              <div
                v-for="(msg, i) in selectedSession.history"
                :key="i"
                :class="['chat-msg', msg.role === 'user' ? 'chat-user' : 'chat-assistant']"
              >
                <n-tag :type="msg.role === 'user' ? 'info' : 'success'" size="small" round style="margin-right: 8px">
                  {{ msg.role === 'user' ? '用户' : '助手' }}
                </n-tag>
                <span class="chat-content">{{ msg.content }}</span>
                <span class="chat-time">
                  <n-time v-if="msg.timestamp" :time="msg.timestamp" type="datetime" size="small" />
                </span>
              </div>
            </div>
            <n-empty v-else description="暂无对话记录" />
          </n-card>
        </n-card>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted } from 'vue'
import { useMessage, useDialog, NButton, NSpace, NTag, NTime } from 'naive-ui'
import { api } from '../composables/api'
import type { DataTableColumns } from 'naive-ui'

interface SessionInfo {
  userId: string
  agentId: string
  history?: { role: string; content: string; timestamp: number }[]
  contextToken?: string
  lastActive?: number
  expired?: boolean
}

interface SessionConfig {
  maxRounds: number
  expireMs: number
}

const message = useMessage()
const dialog = useDialog()

const sessions = ref<SessionInfo[]>([])
const selectedSession = ref<SessionInfo | null>(null)
const savingConfig = ref(false)

const sessionConfig = ref<SessionConfig>({ maxRounds: 0, expireMs: 0 })

const expireOptions = [
  { label: '永不过期', value: 0 },
  { label: '30 分钟', value: 1800000 },
  { label: '1 小时', value: 3600000 },
  { label: '2 小时', value: 7200000 },
  { label: '24 小时', value: 86400000 },
  { label: '7 天', value: 604800000 },
]

const sessionColumns: DataTableColumns<SessionInfo> = [
  { title: 'Agent', key: 'agentId', width: 140 },
  {
    title: '消息数', key: 'history', width: 90,
    render: (row) => row.history?.length || 0,
  },
  {
    title: '最后活跃', key: 'lastActive', width: 180,
    render: (row) => row.lastActive ? h(NTime, { time: row.lastActive, type: 'datetime' }) : '-',
  },
  {
    title: '过期', key: 'expired', width: 80,
    render: (row) => h(NTag, {
      type: row.expired ? 'error' : 'success',
      size: 'small',
      round: true,
    }, () => row.expired ? '已过期' : '有效'),
  },
  {
    title: '操作', key: 'actions', width: 160,
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => viewDetail(row) }, () => '详情'),
        h(NButton, { size: 'small', quaternary: true, type: 'error', onClick: () => confirmDelete(row) }, () => '删除'),
      ]),
  },
]

async function loadSessions() {
  try {
    sessions.value = await api.get<SessionInfo[]>('/api/sessions')
  } catch (e: any) {
    message.error(e.message)
  }
}

async function loadConfig() {
  try {
    sessionConfig.value = await api.get<SessionConfig>('/api/sessions/config')
  } catch { /* ignore */ }
}

async function saveConfig() {
  savingConfig.value = true
  try {
    sessionConfig.value = await api.put<SessionConfig>('/api/sessions/config', sessionConfig.value)
    message.success('配置已保存')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    savingConfig.value = false
  }
}

async function viewDetail(session: SessionInfo) {
  try {
    const detail = await api.get<SessionInfo>(
      `/api/sessions/detail?agentId=${encodeURIComponent(session.agentId)}`,
    )
    selectedSession.value = detail
  } catch (e: any) {
    message.error(e.message)
  }
}

function confirmDelete(session: SessionInfo) {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除 Agent "${session.agentId}" 的会话吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.del('/api/sessions/clear', { agentId: session.agentId })
        message.success('已删除')
        selectedSession.value = null
        await loadSessions()
      } catch (e: any) {
        message.error(e.message)
      }
    },
  })
}

function confirmClearAll() {
  dialog.error({
    title: '确认清空',
    content: '确定要清空所有会话吗？此操作不可撤销！',
    positiveText: '清空全部',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.del<{ ok: boolean; cleared: number }>('/api/sessions/clear', {})
        message.success('已清空所有会话')
        selectedSession.value = null
        await loadSessions()
      } catch (e: any) {
        message.error(e.message)
      }
    },
  })
}

onMounted(() => {
  loadSessions()
  loadConfig()
})
</script>

<style scoped>
.chat-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-msg {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 6px;
}
.chat-user {
  background: rgba(99, 102, 241, 0.06);
}
.chat-assistant {
  background: rgba(16, 185, 129, 0.06);
}
.chat-content {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
}
.chat-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--n-text-color-3);
}
</style>
