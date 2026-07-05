<template>
  <div>
    <!-- 添加/编辑 Agent 表单 -->
    <n-card :title="editingId ? '编辑 Agent' : '添加 Agent'" style="margin-bottom: 20px">
      <n-form ref="formRef" :model="form" :rules="formRules" label-placement="left" label-width="100">
        <n-grid :cols="2" :x-gap="16">
          <n-form-item-gi label="ID" path="id">
            <n-input v-model:value="form.id" placeholder="例如 openclaw-main" :disabled="!!editingId" />
          </n-form-item-gi>
          <n-form-item-gi label="名称" path="name">
            <n-input v-model:value="form.name" placeholder="例如 OpenClaw 主实例" />
          </n-form-item-gi>
          <n-form-item-gi label="切换命令" path="command">
            <n-input v-model:value="form.command" placeholder="例如 openclaw (用户发送 #openclaw)" />
          </n-form-item-gi>
          <n-form-item-gi label="类型" path="type">
            <n-select v-model:value="form.type" :options="typeOptions" />
          </n-form-item-gi>
        </n-grid>
        <n-form-item label="描述" path="description">
          <n-input v-model:value="form.description" placeholder="简短描述" />
        </n-form-item>

        <!-- HTTP 字段 -->
        <template v-if="form.type === 'http'">
          <n-grid :cols="2" :x-gap="16">
            <n-form-item-gi label="HTTP 端点" path="endpoint">
              <n-input v-model:value="form.endpoint" placeholder="如 https://api.openai.com/v1" />
            </n-form-item-gi>
            <n-form-item-gi label="超时 (ms)" path="timeout">
              <n-input-number v-model:value="form.timeout" :min="1000" :step="1000" style="width: 100%" />
            </n-form-item-gi>
            <n-form-item-gi label="API Key" path="apiKey">
              <n-input v-model:value="form.apiKey" type="password" show-password-on="click" placeholder="可选" />
            </n-form-item-gi>
            <n-form-item-gi label="模型" path="model">
              <n-input v-model:value="form.model" placeholder="例如 gpt-4o" />
            </n-form-item-gi>
          </n-grid>
          <n-form-item label="请求格式" path="format">
            <n-select v-model:value="form.format" :options="formatOptions" clearable />
          </n-form-item>
        </template>

        <!-- CLI 字段 -->
        <template v-if="form.type === 'cli'">
          <n-grid :cols="2" :x-gap="16">
            <n-form-item-gi label="CLI 命令" path="cliCommand">
              <n-input v-model:value="form.cliCommand" placeholder="例如 claude" />
            </n-form-item-gi>
            <n-form-item-gi label="工作目录" path="cliWorkDir">
              <n-input v-model:value="form.cliWorkDir" placeholder="例如 /workspace" />
            </n-form-item-gi>
            <n-form-item-gi label="参数" path="cliArgs">
              <n-input v-model:value="cliArgsText" placeholder="逗号分隔，如 -p, --output-format, text" />
            </n-form-item-gi>
            <n-form-item-gi label="模式" path="cliMode">
              <n-select v-model:value="form.cliMode" :options="cliModeOptions" />
            </n-form-item-gi>
          </n-grid>
          <n-form-item label="超时 (ms)" path="timeout">
            <n-input-number v-model:value="form.timeout" :min="1000" :step="1000" style="width: 100%" />
          </n-form-item>
        </template>

        <n-space>
          <n-button type="primary" @click="handleSubmit">{{ editingId ? '保存修改' : '添加 Agent' }}</n-button>
          <n-button v-if="editingId" @click="cancelEdit">取消</n-button>
        </n-space>
      </n-form>
    </n-card>

    <!-- Agent 列表 -->
    <n-card title="已注册 Agent">
      <n-data-table
        :columns="columns"
        :data="agents"
        :bordered="false"
        :row-key="(row: Agent) => row.id"
      />
      <n-empty v-if="agents.length === 0" description="暂无 Agent" style="padding: 40px 0" />
    </n-card>

    <!-- 测试发送 -->
    <n-card title="测试发送" style="margin-top: 20px">
      <n-space vertical>
        <n-grid :cols="2" :x-gap="16">
          <n-form-item-gi label="选择 Agent">
            <n-select v-model:value="testAgentId" :options="agentSelectOptions" placeholder="-- 请选择 --" />
          </n-form-item-gi>
          <n-form-item-gi>
            <n-button type="primary" :loading="testLoading" @click="handleTest" style="margin-top: 22px; width: 100%">
              发送测试
            </n-button>
          </n-form-item-gi>
        </n-grid>
        <n-input
          v-model:value="testMessage"
          type="textarea"
          placeholder="输入测试消息..."
          :rows="3"
        />
        <n-card v-if="testResult" size="small" embedded>
          <n-space vertical>
            <span style="white-space: pre-wrap">{{ testResult.text }}</span>
            <span style="color: var(--n-text-color-3); font-size: 12px">耗时: {{ testResult.elapsed }}ms</span>
          </n-space>
        </n-card>
      </n-space>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { useMessage, useDialog, NButton, NSpace, NTag } from 'naive-ui'
import { api } from '../composables/api'
import type { FormInst, DataTableColumns } from 'naive-ui'

interface Agent {
  id: string
  name: string
  command: string
  type: 'http' | 'cli'
  description: string
  endpoint?: string
  timeout: number
  apiKey?: string
  model?: string
  format?: string
  cliCommand?: string
  cliArgs?: string[]
  cliWorkDir?: string
  cliMode?: string
}

const message = useMessage()
const dialog = useDialog()
const formRef = ref<FormInst | null>(null)
const agents = ref<Agent[]>([])
const editingId = ref<string | null>(null)

const defaultForm = (): Agent => ({
  id: '',
  name: '',
  command: '',
  type: 'http',
  description: '',
  endpoint: '',
  timeout: 30000,
  apiKey: '',
  model: '',
  format: undefined,
  cliCommand: '',
  cliArgs: [],
  cliWorkDir: '',
  cliMode: 'oneshot',
})

const form = ref<Agent>(defaultForm())
const cliArgsText = ref('')

const typeOptions = [
  { label: 'HTTP', value: 'http' },
  { label: 'CLI', value: 'cli' },
]
const formatOptions = [
  { label: 'Native', value: 'native' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'QwenPaw', value: 'qwenpaw' },
]
const cliModeOptions = [
  { label: 'OneShot', value: 'oneshot' },
  { label: 'Persistent', value: 'persistent' },
]

const formRules = {
  id: { required: true, message: '请输入 ID', trigger: 'blur' },
  name: { required: true, message: '请输入名称', trigger: 'blur' },
  command: { required: true, message: '请输入切换命令', trigger: 'blur' },
}

const columns: DataTableColumns<Agent> = [
  { title: 'ID', key: 'id', width: 140, render: (row) => h('code', { style: 'font-size:13px' }, row.id) },
  { title: '名称', key: 'name', width: 160 },
  { title: '命令', key: 'command', width: 120, render: (row) => h('code', {}, `/${row.command}`) },
  {
    title: '类型', key: 'type', width: 80,
    render: (row) => h(NTag, { type: row.type === 'http' ? 'info' : 'warning', size: 'small', round: true }, () => row.type.toUpperCase()),
  },
  { title: '描述', key: 'description', ellipsis: { tooltip: true } },
  {
    title: '操作', key: 'actions', width: 160,
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => startEdit(row) }, () => '编辑'),
        h(NButton, { size: 'small', quaternary: true, type: 'error', onClick: () => confirmDelete(row) }, () => '删除'),
      ]),
  },
]

const agentSelectOptions = computed(() =>
  agents.value.map((a) => ({ label: `${a.name} (${a.id})`, value: a.id })),
)

const testAgentId = ref('')
const testMessage = ref('')
const testLoading = ref(false)
const testResult = ref<{ text: string; elapsed: number } | null>(null)

async function loadAgents() {
  try {
    agents.value = await api.get<Agent[]>('/api/agents')
  } catch (e: any) {
    message.error(e.message)
  }
}

function startEdit(agent: Agent) {
  editingId.value = agent.id
  form.value = { ...agent }
  cliArgsText.value = (agent.cliArgs || []).join(', ')
}

function cancelEdit() {
  editingId.value = null
  form.value = defaultForm()
  cliArgsText.value = ''
}

async function handleSubmit() {
  try {
    await formRef.value?.validate()
  } catch { return }

  const payload = { ...form.value }
  if (payload.type === 'cli') {
    payload.cliArgs = cliArgsText.value ? cliArgsText.value.split(',').map((s) => s.trim()) : []
  }
  // 空字符串的可选字段转为 undefined，避免后端把 '' 当有效值
  for (const key of ['endpoint', 'apiKey', 'model', 'format', 'cliCommand', 'cliWorkDir', 'cliMode'] as const) {
    if ((payload as any)[key] === '') (payload as any)[key] = undefined
  }

  try {
    if (editingId.value) {
      await api.put(`/api/agents/${editingId.value}`, payload)
      message.success('Agent 已更新')
    } else {
      await api.post('/api/agents', payload)
      message.success('Agent 已添加')
    }
    cancelEdit()
    await loadAgents()
  } catch (e: any) {
    message.error(e.message)
  }
}

function confirmDelete(agent: Agent) {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除 Agent "${agent.name}" 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.del(`/api/agents/${agent.id}`)
        message.success('已删除')
        await loadAgents()
      } catch (e: any) {
        message.error(e.message)
      }
    },
  })
}

async function handleTest() {
  if (!testAgentId.value || !testMessage.value) {
    message.warning('请选择 Agent 并输入测试消息')
    return
  }
  testLoading.value = true
  testResult.value = null
  try {
    testResult.value = await api.post<{ text: string; elapsed: number }>(
      `/api/agents/${testAgentId.value}/test`,
      { text: testMessage.value },
    )
  } catch (e: any) {
    message.error(e.message)
  } finally {
    testLoading.value = false
  }
}

onMounted(loadAgents)
</script>
