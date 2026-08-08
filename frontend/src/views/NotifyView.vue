<template>
  <div>
    <n-grid :cols="1" :y-gap="20">
      <!-- 发送通知 -->
      <n-gi>
        <n-card title="发送通知">
          <n-space vertical>
            <n-input
              v-model:value="notifyText"
              type="textarea"
              placeholder="通知文本内容"
              :rows="4"
            />
            <n-button type="primary" :loading="sending" @click="handleSend">
              发送通知
            </n-button>
          </n-space>
        </n-card>
      </n-gi>

      <!-- 发送文件 -->
      <n-gi>
        <n-card title="发送文件">
          <n-space vertical>
            <n-text depth="3" style="font-size: 13px">
              上传图片、视频或其他文件直接发送给当前绑定的微信用户（不经过 Agent）。单个文件最大 20MB。
            </n-text>
            <input
              ref="fileInputRef"
              type="file"
              style="display: none"
              @change="handleFileSelected"
            />
            <n-space align="center">
              <n-button @click="triggerFilePicker">
                选择文件
              </n-button>
              <n-text v-if="selectedFile" depth="2" style="font-size: 13px">
                {{ selectedFile.name }} ({{ formatFileSize(selectedFile.size) }})
              </n-text>
            </n-space>
            <n-input
              v-model:value="fileCaption"
              placeholder="附带说明文字（可选）"
            />
            <n-button
              type="primary"
              :disabled="!selectedFile"
              :loading="sendingFile"
              @click="handleSendFile"
            >
              发送文件
            </n-button>
          </n-space>
        </n-card>
      </n-gi>

      <!-- 通知规则 -->
      <n-gi>
        <n-card title="通知规则">
          <template #header-extra>
            <n-button size="small" type="primary" @click="showAddRule = true">
              添加规则
            </n-button>
          </template>

          <n-data-table
            :columns="ruleColumns"
            :data="rules"
            :bordered="false"
            :row-key="(row: NotifyRule) => row.id"
          />
          <n-empty v-if="rules.length === 0" description="暂无通知规则" style="padding: 40px 0" />
        </n-card>
      </n-gi>

      <!-- 通知日志 -->
      <n-gi>
        <n-card title="通知日志">
          <template #header-extra>
            <n-button size="small" @click="loadLogs">刷新</n-button>
          </template>
          <n-data-table
            :columns="logColumns"
            :data="logs"
            :bordered="false"
            :row-key="(row: NotifyLog) => row.id"
            :pagination="{ pageSize: 10 }"
          />
          <n-empty v-if="logs.length === 0" description="暂无通知记录" style="padding: 40px 0" />
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 添加规则弹窗 -->
    <n-modal v-model:show="showAddRule" title="添加通知规则" preset="card" style="max-width: 500px">
      <n-form :model="ruleForm" label-placement="left" label-width="80">
        <n-form-item label="规则 ID">
          <n-input v-model:value="ruleForm.id" placeholder="唯一标识" />
        </n-form-item>
        <n-form-item label="类型">
          <n-select v-model:value="ruleForm.type" :options="ruleTypeOptions" />
        </n-form-item>
        <n-form-item v-if="ruleForm.type === 'cron'" label="Cron 表达式">
          <n-input v-model:value="ruleForm.schedule" placeholder="如 0 9 * * 1-5" />
        </n-form-item>
        <n-form-item v-if="ruleForm.type === 'event'" label="事件">
          <n-input v-model:value="ruleForm.event" placeholder="事件名称" />
        </n-form-item>
        <n-form-item label="内容">
          <n-input v-model:value="ruleForm.contentText" type="textarea" placeholder="通知内容" :rows="3" />
        </n-form-item>
        <n-button type="primary" block :loading="addingRule" @click="handleAddRule">添加</n-button>
      </n-form>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted } from 'vue'
import { useMessage, useDialog, NButton, NTag, NSpace, NTime } from 'naive-ui'
import { api } from '../composables/api'
import type { DataTableColumns } from 'naive-ui'

interface NotifyRule {
  id: string
  type: 'cron' | 'event'
  schedule?: string
  event?: string
  userId?: string
  content: { text?: string }
}

interface NotifyLog {
  id: string
  ruleId?: string
  userId: string
  content: { text?: string }
  status: 'success' | 'failed'
  error?: string
  timestamp: number
}

const message = useMessage()
const dialog = useDialog()

const notifyText = ref('')
const sending = ref(false)
const rules = ref<NotifyRule[]>([])
const logs = ref<NotifyLog[]>([])
const showAddRule = ref(false)
const addingRule = ref(false)

const fileInputRef = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const fileCaption = ref('')
const sendingFile = ref(false)

const ruleForm = ref({
  id: '',
  type: 'cron' as 'cron' | 'event',
  schedule: '',
  event: '',
  contentText: '',
})

const ruleTypeOptions = [
  { label: 'Cron 定时', value: 'cron' },
  { label: '事件触发', value: 'event' },
]

const ruleColumns: DataTableColumns<NotifyRule> = [
  { title: 'ID', key: 'id', width: 120 },
  {
    title: '类型', key: 'type', width: 80,
    render: (row) => h(NTag, { type: row.type === 'cron' ? 'info' : 'warning', size: 'small', round: true }, () => row.type),
  },
  { title: '调度/事件', key: 'schedule', width: 140, render: (row) => row.schedule || row.event || '-' },
  { title: '接收对象', key: 'userId', width: 120, render: () => '默认用户' },
  { title: '内容', key: 'content', ellipsis: { tooltip: true }, render: (row) => row.content?.text || '-' },
  {
    title: '操作', key: 'actions', width: 80,
    render: (row) =>
      h(NButton, {
        size: 'small', quaternary: true, type: 'error',
        onClick: () => confirmDeleteRule(row),
      }, () => '删除'),
  },
]

const logColumns: DataTableColumns<NotifyLog> = [
  { title: '接收对象', key: 'userId', width: 120, render: () => '默认用户' },
  { title: '内容', key: 'content', ellipsis: { tooltip: true }, render: (row) => row.content?.text || '-' },
  {
    title: '状态', key: 'status', width: 80,
    render: (row) => h(NTag, { type: row.status === 'success' ? 'success' : 'error', size: 'small', round: true }, () => row.status),
  },
  { title: '错误', key: 'error', ellipsis: { tooltip: true }, render: (row) => row.error || '-' },
  {
    title: '时间', key: 'timestamp', width: 180,
    render: (row) => h(NTime, { time: row.timestamp, type: 'datetime' }),
  },
]

async function handleSend() {
  if (!notifyText.value) {
    message.warning('请输入通知内容')
    return
  }
  sending.value = true
  try {
    await api.post('/api/notify', { content: { text: notifyText.value } })
    message.success('通知已发送')
    notifyText.value = ''
    loadLogs()
  } catch (e: any) {
    message.error(e.message)
  } finally {
    sending.value = false
  }
}

function triggerFilePicker() {
  fileInputRef.value?.click()
}

function handleFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  selectedFile.value = input.files?.[0] || null
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function handleSendFile() {
  if (!selectedFile.value) return

  sendingFile.value = true
  try {
    const formData = new FormData()
    formData.append('file', selectedFile.value)
    if (fileCaption.value.trim()) formData.append('caption', fileCaption.value.trim())

    await api.uploadFile('/api/notify/send-file', formData)
    message.success('文件已发送')
    selectedFile.value = null
    fileCaption.value = ''
    if (fileInputRef.value) fileInputRef.value.value = ''
    loadLogs()
  } catch (e: any) {
    message.error(e.message)
  } finally {
    sendingFile.value = false
  }
}

async function loadRules() {
  try {
    // 通过 config/export 获取通知规则
    const backup = await api.get<{
      notifications?: NotifyRule[]
    }>('/api/config/export')
    rules.value = backup.notifications || []
  } catch { /* ignore */ }
}

async function loadLogs() {
  try {
    logs.value = await api.get<NotifyLog[]>('/api/notify/log')
  } catch { /* ignore */ }
}

function confirmDeleteRule(rule: NotifyRule) {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除规则 "${rule.id}" 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.del(`/api/notify/rules/${rule.id}`)
        message.success('已删除')
        loadRules()
      } catch (e: any) {
        message.error(e.message)
      }
    },
  })
}

async function handleAddRule() {
  addingRule.value = true
  try {
    await api.post('/api/notify/rules', {
      id: ruleForm.value.id,
      type: ruleForm.value.type,
      schedule: ruleForm.value.type === 'cron' ? ruleForm.value.schedule : undefined,
      event: ruleForm.value.type === 'event' ? ruleForm.value.event : undefined,
      content: { text: ruleForm.value.contentText },
    })
    message.success('规则已添加')
    showAddRule.value = false
    ruleForm.value = { id: '', type: 'cron', schedule: '', event: '', contentText: '' }
    loadRules()
  } catch (e: any) {
    message.error(e.message)
  } finally {
    addingRule.value = false
  }
}

onMounted(() => {
  loadRules()
  loadLogs()
})
</script>
