<template>
  <div>
    <n-card title="定时任务">
      <template #header-extra>
        <n-space>
          <n-button size="small" :loading="loading" @click="loadTasks">刷新</n-button>
          <n-button size="small" type="primary" @click="openCreate">新建任务</n-button>
        </n-space>
      </template>

      <n-text depth="3" style="font-size: 13px; display: block; margin-bottom: 12px">
        到点自动推送消息到微信。内容可以是固定文本，也可以先调用一个 Agent、把它这一次的回复推给你。
        与「通知管理」里的通知规则相互独立。
      </n-text>

      <n-data-table
        :columns="taskColumns"
        :data="tasks"
        :loading="loading"
        :bordered="false"
        :scroll-x="1080"
        :row-key="(row: ScheduledTask) => row.id"
        :pagination="{ pageSize: 12 }"
      />
      <n-empty v-if="!loading && tasks.length === 0" description="暂无定时任务" style="padding: 40px 0" />
    </n-card>

    <!-- 新建 / 编辑 -->
    <n-modal
      v-model:show="showModal"
      :title="editingId ? '编辑定时任务' : '新建定时任务'"
      preset="card"
      style="max-width: 620px"
    >
      <n-form :model="form" label-placement="left" label-width="96" :show-feedback="false">
        <n-space vertical size="large">
          <n-form-item label="任务名称">
            <n-input v-model:value="form.name" placeholder="如 每天早间简报" maxlength="60" />
          </n-form-item>

          <n-form-item label="任务 ID">
            <n-input
              v-model:value="form.id"
              :disabled="!!editingId"
              placeholder="字母、数字、下划线、连字符"
            />
          </n-form-item>

          <n-form-item label="调度方式">
            <n-radio-group v-model:value="form.kind">
              <n-radio-button value="cron">Cron</n-radio-button>
              <n-radio-button value="interval">固定间隔</n-radio-button>
              <n-radio-button value="once">一次性</n-radio-button>
            </n-radio-group>
          </n-form-item>

          <n-form-item v-if="form.kind === 'cron'" label="表达式">
            <n-space vertical style="width: 100%">
              <n-input v-model:value="form.schedule" placeholder="如 0 9 * * 1-5（分 时 日 月 周）" @update:value="schedulePreview" />
              <n-select
                v-model:value="form.timezone"
                :options="timezoneOptions"
                filterable
                tag
                @update:value="schedulePreview"
              />
              <n-text :depth="previewError ? 2 : 3" :type="previewError ? 'error' : undefined" style="font-size: 12px">
                <template v-if="previewError">{{ previewError }}</template>
                <template v-else-if="previewRunAt !== null">下次执行：{{ previewText }}</template>
                <template v-else>时区默认北京时间；容器时钟是 UTC 也不影响。</template>
              </n-text>
            </n-space>
          </n-form-item>

          <n-form-item v-if="form.kind === 'interval'" label="间隔">
            <n-space align="center">
              <n-input-number v-model:value="form.everyMinutes" :min="1" :max="10080" style="width: 160px" />
              <n-text depth="3" style="font-size: 13px">分钟执行一次（最多 7 天）</n-text>
            </n-space>
          </n-form-item>

          <n-form-item v-if="form.kind === 'once'" label="执行时间">
            <n-date-picker
              v-model:value="form.runAt"
              type="datetime"
              style="width: 100%"
              :actions="['clear']"
            />
          </n-form-item>

          <n-divider style="margin: 4px 0" />

          <n-form-item label="内容来源">
            <n-radio-group v-model:value="form.source">
              <n-radio-button value="text">固定文本</n-radio-button>
              <n-radio-button value="agent">先问 Agent</n-radio-button>
            </n-radio-group>
          </n-form-item>

          <n-form-item v-if="form.source === 'text'" label="推送内容">
            <n-input
              v-model:value="form.text"
              type="textarea"
              :rows="4"
              maxlength="4000"
              placeholder="到点原样推送到微信"
            />
          </n-form-item>

          <template v-else>
            <n-form-item label="Agent">
              <n-select
                v-model:value="form.agentId"
                :options="agentOptions"
                :loading="loadingAgents"
                placeholder="选择要调用的 Agent"
              />
            </n-form-item>
            <n-form-item label="提问内容">
              <n-input
                v-model:value="form.prompt"
                type="textarea"
                :rows="4"
                maxlength="4000"
                placeholder="到点发给 Agent 的问题，它的回复会被推送。每次都是独立提问，不带历史。"
              />
            </n-form-item>
          </template>

          <n-form-item label="立即启用">
            <n-switch v-model:value="form.enabled" />
          </n-form-item>

          <n-button type="primary" block :loading="saving" @click="handleSave">
            {{ editingId ? '保存修改' : '创建任务' }}
          </n-button>
        </n-space>
      </n-form>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted, onUnmounted } from 'vue'
import { useMessage, useDialog, NButton, NSpace, NSwitch, NTag, NText, NTime } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '../composables/api'

type TaskKind = 'once' | 'interval' | 'cron'
type TaskSource = 'text' | 'agent'

interface ScheduledTask {
  id: string
  name: string
  enabled: boolean
  kind: TaskKind
  runAt?: number
  everyMinutes?: number
  schedule?: string
  timezone?: string
  source: TaskSource
  text?: string
  agentId?: string
  prompt?: string
  createdAt: number
  nextRunAt?: number | null
  lastRunAt?: number
  lastStatus?: 'success' | 'failed' | 'skipped'
  lastError?: string
  runCount: number
}

interface AgentOption {
  id: string
  name: string
}

const message = useMessage()
const dialog = useDialog()

const tasks = ref<ScheduledTask[]>([])
const loading = ref(false)
const saving = ref(false)
const showModal = ref(false)
const editingId = ref<string | null>(null)

const agents = ref<AgentOption[]>([])
const loadingAgents = ref(false)

const previewRunAt = ref<number | null>(null)
const previewError = ref('')
let previewTimer: ReturnType<typeof setTimeout> | null = null

const kindLabel: Record<TaskKind, string> = {
  once: '一次性',
  interval: '固定间隔',
  cron: 'Cron',
}

const timezoneOptions = [
  { label: '北京时间 (Asia/Shanghai)', value: 'Asia/Shanghai' },
  { label: '东京 (Asia/Tokyo)', value: 'Asia/Tokyo' },
  { label: '新加坡 (Asia/Singapore)', value: 'Asia/Singapore' },
  { label: '伦敦 (Europe/London)', value: 'Europe/London' },
  { label: '柏林 (Europe/Berlin)', value: 'Europe/Berlin' },
  { label: '纽约 (America/New_York)', value: 'America/New_York' },
  { label: '洛杉矶 (America/Los_Angeles)', value: 'America/Los_Angeles' },
  { label: 'UTC', value: 'UTC' },
]

function createForm() {
  return {
    id: '',
    name: '',
    kind: 'cron' as TaskKind,
    runAt: null as number | null,
    everyMinutes: 60,
    schedule: '',
    timezone: 'Asia/Shanghai',
    source: 'text' as TaskSource,
    text: '',
    agentId: null as string | null,
    prompt: '',
    enabled: true,
  }
}

const form = ref(createForm())

const agentOptions = ref<{ label: string; value: string }[]>([])

function buildTaskPayload() {
  const f = form.value
  const payload: Record<string, unknown> = {
    id: f.id.trim(),
    name: f.name.trim(),
    enabled: f.enabled,
    kind: f.kind,
    source: f.source,
  }
  if (f.kind === 'once') payload.runAt = f.runAt
  if (f.kind === 'interval') payload.everyMinutes = f.everyMinutes
  if (f.kind === 'cron') {
    payload.schedule = f.schedule.trim()
    payload.timezone = f.timezone
  }
  if (f.source === 'text') payload.text = f.text
  else {
    payload.agentId = f.agentId ?? ''
    payload.prompt = f.prompt
  }
  return payload
}

function describeSchedule(task: ScheduledTask): string {
  if (task.kind === 'once') return task.runAt ? formatTime(task.runAt) : '-'
  if (task.kind === 'interval') return `每 ${task.everyMinutes ?? 1} 分钟`
  return `${task.schedule ?? '-'}（${task.timezone ?? 'Asia/Shanghai'}）`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function describeContent(task: ScheduledTask): string {
  if (task.source === 'text') return task.text || '-'
  const agent = agents.value.find((a) => a.id === task.agentId)
  return `问 Agent ${(agent?.name) || task.agentId || '-'}：${task.prompt || '-'}`
}

const busyIds = ref(new Set<string>())

const taskColumns: DataTableColumns<ScheduledTask> = [
  {
    title: '名称',
    key: 'name',
    width: 170,
    render: (row: ScheduledTask) =>
      h('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [
        h('span', { style: 'font-weight:600' }, row.name),
        h(NText, { depth: 3, style: 'font-size:12px' }, () => row.id),
      ]),
  },
  {
    title: '类型',
    key: 'kind',
    width: 90,
    render: (row: ScheduledTask) =>
      h(NTag, { size: 'small', round: true, type: row.kind === 'once' ? 'warning' : 'info' }, () => kindLabel[row.kind]),
  },
  { title: '调度', key: 'schedule', width: 210, render: (row: ScheduledTask) => describeSchedule(row) },
  { title: '内容', key: 'content', width: 220, ellipsis: { tooltip: true }, render: (row: ScheduledTask) => describeContent(row) },
  {
    title: '下次执行',
    key: 'nextRunAt',
    width: 170,
    render: (row: ScheduledTask) =>
      row.enabled && row.nextRunAt
        ? h(NTime, { time: row.nextRunAt, type: 'datetime' })
        : h(NText, { depth: 3 }, () => '-'),
  },
  {
    title: '上次结果',
    key: 'lastStatus',
    width: 150,
    render: (row: ScheduledTask) => {
      if (!row.lastStatus) return h(NText, { depth: 3 }, () => '未执行')
      const type = row.lastStatus === 'success' ? 'success' : row.lastStatus === 'failed' ? 'error' : 'warning'
      const label = row.lastStatus === 'success' ? '成功' : row.lastStatus === 'failed' ? '失败' : '已跳过'
      const children = [h(NTag, { size: 'small', round: true, type }, () => label)]
      if (row.lastRunAt) {
        children.push(h(NText, { depth: 3, style: 'font-size:12px' }, () => formatTime(row.lastRunAt!)))
      }
      return h(NSpace, { size: 4, align: 'center' }, () => children)
    },
  },
  {
    title: '启用',
    key: 'enabled',
    width: 70,
    render: (row: ScheduledTask) =>
      h(NSwitch, {
        value: row.enabled,
        loading: busyIds.value.has(`toggle:${row.id}`),
        'onUpdate:value': () => handleToggle(row),
      }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    render: (row: ScheduledTask) =>
      h(NSpace, { size: 4 }, () => [
        h(NButton, { size: 'tiny', onClick: () => handleRunNow(row) }, () => '试跑'),
        h(NButton, { size: 'tiny', onClick: () => openEdit(row) }, () => '编辑'),
        h(NButton, { size: 'tiny', type: 'error', quaternary: true, onClick: () => confirmDelete(row) }, () => '删除'),
      ]),
  },
]

function setBusy(key: string, busy: boolean) {
  const next = new Set(busyIds.value)
  if (busy) next.add(key)
  else next.delete(key)
  busyIds.value = next
}

async function loadTasks() {
  loading.value = true
  try {
    tasks.value = await api.get<ScheduledTask[]>('/api/scheduled-tasks')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    loading.value = false
  }
}

async function loadAgents() {
  loadingAgents.value = true
  try {
    const list = await api.get<AgentOption[]>('/api/agents')
    agents.value = list.map((a) => ({ id: a.id, name: a.name || a.id }))
    agentOptions.value = agents.value.map((a) => ({ label: a.name, value: a.id }))
  } catch {
    agentOptions.value = []
  } finally {
    loadingAgents.value = false
  }
}

function openCreate() {
  editingId.value = null
  form.value = createForm()
  previewRunAt.value = null
  previewError.value = ''
  showModal.value = true
}

function openEdit(task: ScheduledTask) {
  editingId.value = task.id
  form.value = {
    id: task.id,
    name: task.name,
    kind: task.kind,
    runAt: task.runAt ?? null,
    everyMinutes: task.everyMinutes ?? 60,
    schedule: task.schedule ?? '',
    timezone: task.timezone ?? 'Asia/Shanghai',
    source: task.source,
    text: task.text ?? '',
    agentId: task.agentId ?? null,
    prompt: task.prompt ?? '',
    enabled: task.enabled,
  }
  previewError.value = ''
  if (task.kind === 'cron') previewRunAt.value = task.nextRunAt ?? null
  showModal.value = true
}

async function handleSave() {
  const f = form.value
  if (!f.name.trim()) { message.warning('请填写任务名称'); return }
  if (!f.id.trim()) { message.warning('请填写任务 ID'); return }
  if (f.kind === 'once' && !f.runAt) { message.warning('请选择执行时间'); return }

  saving.value = true
  try {
    const payload = buildTaskPayload()
    if (editingId.value) {
      await api.put<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(editingId.value)}`, payload)
      message.success('任务已保存')
    } else {
      await api.post<ScheduledTask>('/api/scheduled-tasks', payload)
      message.success('任务已创建')
    }
    showModal.value = false
    await loadTasks()
  } catch (e: any) {
    message.error(e.message)
  } finally {
    saving.value = false
  }
}

async function handleToggle(task: ScheduledTask) {
  setBusy(`toggle:${task.id}`, true)
  try {
    await api.post<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(task.id)}/toggle`, {
      enabled: !task.enabled,
    })
    message.success(task.enabled ? '已停用' : '已启用')
    await loadTasks()
  } catch (e: any) {
    message.error(e.message)
    await loadTasks()
  } finally {
    setBusy(`toggle:${task.id}`, false)
  }
}

async function handleRunNow(task: ScheduledTask) {
  setBusy(`run:${task.id}`, true)
  try {
    await api.post<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(task.id)}/run`, {})
    message.success('已推送到微信')
    await loadTasks()
  } catch (e: any) {
    message.error(`推送失败：${e.message}`)
    await loadTasks()
  } finally {
    setBusy(`run:${task.id}`, false)
  }
}

function confirmDelete(task: ScheduledTask) {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除定时任务「${task.name}」吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.del(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`)
        message.success('已删除')
        await loadTasks()
      } catch (e: any) {
        message.error(e.message)
      }
    },
  })
}

const previewText = computed(() => {
  if (previewError.value || previewRunAt.value === null) return ''
  return formatTime(previewRunAt.value)
})

function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(async () => {
    const f = form.value
    if (f.kind !== 'cron' || !f.schedule.trim()) {
      previewRunAt.value = null
      previewError.value = ''
      return
    }
    try {
      const params = new URLSearchParams({ schedule: f.schedule.trim(), timezone: f.timezone })
      const res = await api.get<{ nextRunAt: number }>(`/api/scheduled-tasks/preview-next?${params.toString()}`)
      previewRunAt.value = res.nextRunAt
      previewError.value = ''
    } catch (e: any) {
      previewRunAt.value = null
      previewError.value = e.message
    }
  }, 400)
}

onMounted(() => {
  loadTasks()
  loadAgents()
})

onUnmounted(() => {
  if (previewTimer) clearTimeout(previewTimer)
})
</script>
