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

        <!-- WS Remote 字段（插件接入） -->
        <template v-if="form.type === 'ws-remote'">
          <n-grid :cols="2" :x-gap="16">
            <n-form-item-gi label="Agent Token" path="apiKey">
              <n-input-group>
                <n-input v-model:value="form.apiKey" type="password" show-password-on="click" placeholder="点击右侧按钮自动生成" style="flex:1" />
                <n-button type="primary" @click="handleGenerateToken" :loading="tokenGenerating" :disabled="!form.id" style="margin-left:8px">
                  生成 Token
                </n-button>
              </n-input-group>
            </n-form-item-gi>
            <n-form-item-gi label="超时 (ms)" path="timeout">
              <n-input-number v-model:value="form.timeout" :min="5000" :step="5000" style="width: 100%" />
            </n-form-item-gi>
          </n-grid>
          <n-alert v-if="!form.id" type="warning" style="margin-bottom: 12px">
            请先填写 Agent ID，再生成 Token。
          </n-alert>
          <n-alert v-if="wsInstallCmd" type="success" style="margin-bottom: 12px" title="✅ 安装命令（复制到 Agent 端执行）">
            <n-code :code="wsInstallCmd" language="bash" word-break style="margin-top: 4px" />
            <n-button size="small" type="primary" style="margin-top: 8px" @click="copyInstallCmd">
              📋 复制安装命令
            </n-button>
          </n-alert>
          <n-alert v-else type="info" style="margin-bottom: 12px">
            WS Remote 类型：Agent 通过插件主动连接 Bridge，无需起 HTTP 服务。填写 ID 后点击「生成 Token」，获取安装命令。
          </n-alert>
          <n-form-item v-if="wsInstallCmd" label="模板">
            <n-select v-model:value="wsPluginTemplate" :options="wsPluginTemplateOptions" style="max-width: 300px" @update:value="regenerateInstallCmd" />
          </n-form-item>
        </template>

        <!-- WS 字段 -->
        <template v-if="form.type === 'ws'">
          <n-grid :cols="2" :x-gap="16">
            <n-form-item-gi label="WS 端点" path="wsUrl">
              <n-input v-model:value="form.wsUrl" placeholder="ws://host:port/ws 或 wss://..." />
            </n-form-item-gi>
            <n-form-item-gi label="API Key" path="apiKey">
              <n-input v-model:value="form.apiKey" type="password" show-password-on="click" placeholder="可选" />
            </n-form-item-gi>
            <n-form-item-gi label="模型" path="model">
              <n-input v-model:value="form.model" placeholder="可选" />
            </n-form-item-gi>
            <n-form-item-gi label="超时 (ms)" path="timeout">
              <n-input-number v-model:value="form.timeout" :min="1000" :step="1000" style="width: 100%" />
            </n-form-item-gi>
            <n-form-item-gi label="重连间隔 (ms)" path="wsReconnectInterval">
              <n-input-number v-model:value="form.wsReconnectInterval" :min="500" :step="500" placeholder="默认 3000" style="width: 100%" />
            </n-form-item-gi>
            <n-form-item-gi label="心跳间隔 (ms)" path="wsHeartbeatInterval">
              <n-input-number v-model:value="form.wsHeartbeatInterval" :min="5000" :step="5000" placeholder="默认 30000" style="width: 100%" />
            </n-form-item-gi>
            <n-form-item-gi label="最大重连次数" path="wsMaxReconnectAttempts">
              <n-input-number v-model:value="form.wsMaxReconnectAttempts" :min="0" :step="1" placeholder="默认无限" style="width: 100%" />
            </n-form-item-gi>
          </n-grid>
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

    <!-- Token 查看弹窗 -->
    <n-modal v-model:show="tokenModalVisible" preset="card" title="Agent Token" style="max-width: 600px" :mask-closable="true" @update:show="(v: boolean) => { if (!v) tokenModalAgent = null }">
      <n-spin :show="tokenModalLoading">
        <template v-if="tokenModalAgent && tokenModalValue">
          <n-descriptions :column="1" label-placement="left" size="small" bordered>
            <n-descriptions-item label="Agent ID">
              <n-code>{{ tokenModalAgent.id }}</n-code>
            </n-descriptions-item>
            <n-descriptions-item label="Token">
              <n-input-group>
                <n-input :value="tokenModalValue" readonly />
                <n-button type="primary" @click="copyTokenToClipboard">
                  📋
                </n-button>
              </n-input-group>
            </n-descriptions-item>
            <n-descriptions-item label="Bridge 地址">
              <n-code>{{ bridgeWsUrl }}</n-code>
            </n-descriptions-item>
          </n-descriptions>
          <n-button type="primary" block style="margin-top: 16px" @click="copyTokenModalCmd">
            📋 复制完整安装命令
          </n-button>
        </template>
        <n-empty v-else-if="!tokenModalLoading" description="未找到 Token，请先生成" />
      </n-spin>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, h } from 'vue'
import { useMessage, useDialog, NButton, NSpace, NTag } from 'naive-ui'
import { api } from '../composables/api'
import type { FormInst, DataTableColumns } from 'naive-ui'

interface Agent {
  id: string
  name: string
  command: string
  type: 'http' | 'cli' | 'ws' | 'ws-remote'
  description: string
  endpoint?: string
  timeout: number
  headers?: Record<string, string>
  cliEnv?: Record<string, string>
  apiKey?: string
  model?: string
  format?: string
  streaming?: boolean
  responsePath?: string
  systemPrompt?: string
  maxHistory?: number
  cliCommand?: string
  cliArgs?: string[]
  cliWorkDir?: string
  cliMode?: string
  cliSentinel?: string
  wsUrl?: string
  wsReconnectInterval?: number
  wsHeartbeatInterval?: number
  wsMaxReconnectAttempts?: number
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
  { label: 'WebSocket', value: 'ws' },
  { label: 'WS Remote (插件接入)', value: 'ws-remote' },
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
  {
    title: '状态', key: 'status', width: 80,
    render: (row) => {
      if (row.type !== 'ws-remote') return h('span', { style: 'color:#999' }, '—')
      const online = !!wsOnlineMap.value[row.id]
      return h(NTag, {
        type: online ? 'success' : 'error',
        size: 'small',
        round: true,
        bordered: false,
      }, () => online ? '在线' : '离线')
    },
  },
  { title: '描述', key: 'description', ellipsis: { tooltip: true } },
  {
    title: '操作', key: 'actions', width: 220,
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        row.type === 'ws-remote'
          ? h(NButton, { size: 'small', quaternary: true, type: 'info', onClick: () => showTokenModal(row) }, () => 'Token')
          : null,
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

// WS Remote: token 生成 & 安装命令
const tokenGenerating = ref(false)
const wsInstallCmd = ref('')
const wsPluginTemplate = ref('aibackend')
const wsLastToken = ref('')
const wsLastAgentId = ref('')

const wsPluginTemplateOptions = [
  { label: 'AI Backend（零代码）', value: 'aibackend' },
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'Codex', value: 'codex' },
]

// WS Remote: 查看已有 Token
const tokenModalAgent = ref<Agent | null>(null)
const tokenModalVisible = ref(false)
const tokenModalLoading = ref(false)
const tokenModalValue = ref('')

const bridgeWsUrl = computed(() =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent`
)

function copyTokenToClipboard() {
  navigator.clipboard.writeText(tokenModalValue.value).then(
    () => message.success('Token 已复制'),
    () => message.error('复制失败'),
  )
}

function buildInstallCmd(agentId: string, token: string, name?: string, command?: string, template?: string): string {
  const bridgeUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent`
  const agentName = name || agentId
  const agentCmd = command || agentId

  if (template === 'claude-code') {
    return [
      `npm install weclawbot-agent-plugin`,
      ``,
      `// agent-claude.js — 保存此文件后 node agent-claude.js 启动`,
      `const { WeClawBotAgent } = require('weclawbot-agent-plugin')`,
      `const { execFileSync } = require('child_process')`,
      ``,
      `const agent = new WeClawBotAgent({`,
      `  bridgeUrl: '${bridgeUrl}',`,
      `  agentId: '${agentId}',`,
      `  token: '${token}',`,
      `  name: '${agentName}',`,
      `  command: '${agentCmd}',`,
      `}, (s) => console.log('状态:', s))`,
      ``,
      `agent.onMessage((msg) => {`,
      `  const out = execFileSync('claude',`,
      `    ['-p', msg.text, '--output-format', 'text'],`,
      `    { timeout: 120000, maxBuffer: 10*1024*1024 })`,
      `  return { text: out.toString().trim() || '(无输出)' }`,
      `})`,
      ``,
      `agent.connect()`,
    ].join('\n')
  }

  if (template === 'opencode') {
    return [
      `npm install weclawbot-agent-plugin`,
      ``,
      `// agent-opencode.js — 保存此文件后 node agent-opencode.js 启动`,
      `const { WeClawBotAgent } = require('weclawbot-agent-plugin')`,
      `const { execFileSync } = require('child_process')`,
      ``,
      `const agent = new WeClawBotAgent({`,
      `  bridgeUrl: '${bridgeUrl}',`,
      `  agentId: '${agentId}',`,
      `  token: '${token}',`,
      `  name: '${agentName}',`,
      `  command: '${agentCmd}',`,
      `}, (s) => console.log('状态:', s))`,
      ``,
      `agent.onMessage((msg) => {`,
      `  const out = execFileSync('opencode',`,
      `    ['run', msg.text],`,
      `    { timeout: 300000, maxBuffer: 10*1024*1024, cwd: '/root' })`,
      `  return { text: out.toString().trim() || '(无输出)' }`,
      `})`,
      ``,
      `agent.connect()`,
    ].join('\n')
  }

  if (template === 'codex') {
    return [
      `npm install weclawbot-agent-plugin`,
      ``,
      `// agent-codex.js — 保存此文件后 node agent-codex.js 启动`,
      `const { WeClawBotAgent } = require('weclawbot-agent-plugin')`,
      `const { execFileSync } = require('child_process')`,
      ``,
      `const agent = new WeClawBotAgent({`,
      `  bridgeUrl: '${bridgeUrl}',`,
      `  agentId: '${agentId}',`,
      `  token: '${token}',`,
      `  name: '${agentName}',`,
      `  command: '${agentCmd}',`,
      `}, (s) => console.log('状态:', s))`,
      ``,
      `agent.onMessage((msg) => {`,
      `  const out = execFileSync('codex',`,
      `    ['exec', msg.text],`,
      `    { timeout: 300000, maxBuffer: 10*1024*1024 })`,
      `  return { text: out.toString().trim() || '(无输出)' }`,
      `})`,
      ``,
      `agent.connect()`,
    ].join('\n')
  }

  // default: aibackend
  return [
    `npm install weclawbot-agent-plugin`,
    ``,
    `node -e "`,
    `const { WeClawBotAgent } = require('weclawbot-agent-plugin');`,
    `const agent = new WeClawBotAgent({`,
    `  bridgeUrl: '${bridgeUrl}',`,
    `  agentId: '${agentId}',`,
    `  token: '${token}',`,
    `  name: '${agentName}',`,
    `  command: '${agentCmd}',`,
    `  aiBackend: {`,
    `    url: 'http://127.0.0.1:8642/v1',`,
    `    apiKey: 'your-api-key',`,
    `    format: 'openai',`,
    `  },`,
    `}, (status) => console.log('状态:', status));`,
    `agent.connect();`,
    `"`,
  ].join('\n')
}

function regenerateInstallCmd() {
  if (wsLastAgentId.value && wsLastToken.value) {
    wsInstallCmd.value = buildInstallCmd(
      wsLastAgentId.value, wsLastToken.value,
      form.value.name, form.value.command,
      wsPluginTemplate.value
    )
  }
}

async function showTokenModal(agent: Agent) {
  tokenModalAgent.value = agent
  tokenModalVisible.value = true
  tokenModalValue.value = ''
  tokenModalLoading.value = true
  try {
    const res = await api.get<{ agentId: string; token: string }>(`/api/ws-agents/${agent.id}/token`)
    tokenModalValue.value = res.token
  } catch {
    tokenModalValue.value = ''
  } finally {
    tokenModalLoading.value = false
  }
}

function copyTokenModalCmd() {
  if (!tokenModalAgent.value || !tokenModalValue.value) return
  const cmd = buildInstallCmd(tokenModalAgent.value.id, tokenModalValue.value)
  navigator.clipboard.writeText(cmd).then(
    () => message.success('安装命令已复制'),
    () => message.error('复制失败'),
  )
}

async function handleGenerateToken() {
  if (!form.value.id) {
    message.warning('请先填写 Agent ID')
    return
  }
  tokenGenerating.value = true
  try {
    const agentId = form.value.id
    const res = await api.post<{ agentId: string; token: string }>(`/api/ws-agents/${agentId}/token`)
    form.value.apiKey = res.token
    wsLastAgentId.value = agentId
    wsLastToken.value = res.token
    wsInstallCmd.value = buildInstallCmd(agentId, res.token, form.value.name, form.value.command, wsPluginTemplate.value)
    message.success('Token 已生成，复制下方命令到 Agent 端即可接入')
  } catch (e: any) {
    message.error(e.message || 'Token 生成失败')
  } finally {
    tokenGenerating.value = false
  }
}

function copyInstallCmd() {
  navigator.clipboard.writeText(wsInstallCmd.value).then(
    () => message.success('已复制到剪贴板'),
    () => message.error('复制失败，请手动选中复制'),
  )
}

async function loadAgents() {
  try {
    agents.value = await api.get<Agent[]>('/api/agents')
    // 同时加载 WS Remote 在线状态
    await loadWsOnline()
  } catch (e: any) {
    message.error(e.message)
  }
}

// WS Remote 在线状态
const wsOnlineMap = ref<Record<string, { connectedAt: number; lastActivity: number }>>({})

async function loadWsOnline() {
  try {
    const res = await api.get<{ agents: Array<{ agentId: string; connectedAt: number; lastActivity: number }> }>('/api/ws-agents')
    const map: Record<string, { connectedAt: number; lastActivity: number }> = {}
    for (const a of res.agents) {
      map[a.agentId] = { connectedAt: a.connectedAt, lastActivity: a.lastActivity }
    }
    wsOnlineMap.value = map
  } catch {
    // 忽略，可能未启用
  }
}

// 定时刷新在线状态
let wsOnlineTimer: ReturnType<typeof setInterval> | null = null

function startEdit(agent: Agent) {
  editingId.value = agent.id
  form.value = { ...agent }
  cliArgsText.value = (agent.cliArgs || []).join(', ')
}

function cancelEdit() {
  editingId.value = null
  form.value = defaultForm()
  cliArgsText.value = ''
  wsInstallCmd.value = ''
  wsLastToken.value = ''
  wsLastAgentId.value = ''
  wsPluginTemplate.value = 'aibackend'
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
  for (const key of ['endpoint', 'apiKey', 'model', 'format', 'cliCommand', 'cliWorkDir', 'cliMode', 'wsUrl'] as const) {
    if ((payload as any)[key] === '') (payload as any)[key] = undefined
  }

  try {
    if (editingId.value) {
      await api.put(`/api/agents/${editingId.value}`, payload)
      message.success('Agent 已更新')
    } else {
      await api.post('/api/agents', payload)
      // ws-remote 类型：自动生成 token（仅当未手动生成时）
      if (payload.type === 'ws-remote' && payload.id) {
        const alreadyHasToken = form.value.apiKey && form.value.apiKey.startsWith('wsk_')
        if (!alreadyHasToken) {
          // 没有 token 或 token 未变 → 自动生成
          try {
            const res = await api.post<{ agentId: string; token: string }>(`/api/ws-agents/${payload.id}/token`)
            form.value.apiKey = res.token
            wsLastAgentId.value = payload.id
            wsLastToken.value = res.token
            wsInstallCmd.value = buildInstallCmd(payload.id, res.token, payload.name, payload.command, wsPluginTemplate.value)
            message.success('Agent 已添加，Token 已自动生成！复制下方命令到 Agent 端即可接入')
          } catch {
            message.success('Agent 已添加，但 Token 自动生成失败，请手动点击「生成 Token」')
          }
        } else {
          message.success('Agent 已添加')
        }
      } else {
        message.success('Agent 已添加')
      }
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

onMounted(() => {
  loadAgents()
  wsOnlineTimer = setInterval(loadWsOnline, 5000)
})
onUnmounted(() => {
  if (wsOnlineTimer) clearInterval(wsOnlineTimer)
})
</script>
