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
          <n-form-item label="接入方式">
            <n-select v-model:value="wsIntegration" :options="wsIntegrationOptions" style="max-width: 300px" />
          </n-form-item>
          <n-alert type="info" style="margin-bottom: 12px" :title="integrationGuide.title">
            <div style="line-height: 1.8">
              {{ integrationGuide.summary }}
              <ol style="margin: 8px 0 0; padding-left: 20px">
                <li v-for="step in integrationGuide.steps" :key="step">{{ step }}</li>
              </ol>
              <n-code :code="formIntegrationInstallCmd" language="bash" word-break style="display: block; margin-top: 10px" />
              <n-button size="small" type="primary" style="margin-top: 8px" @click="copyIntegrationInstallCmd(formIntegrationInstallCmd)">
                📋 复制 {{ integrationGuide.product }} 安装命令
              </n-button>
              <div style="margin-top: 8px">
                Bridge 地址：<n-code>{{ bridgeWsUrl }}</n-code><br>
                Agent ID：<n-code>{{ form.id || '填写 Agent ID 后显示' }}</n-code><br>
                Token：<n-code>{{ form.apiKey || '生成 Token 后填入对应客户端' }}</n-code>
              </div>
            </div>
          </n-alert>
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
          <n-form-item label="接入方式" style="margin-top: 16px">
            <n-select v-model:value="tokenModalIntegration" :options="wsIntegrationOptions" style="max-width: 300px" />
          </n-form-item>
          <n-code :code="tokenModalInstallCmd" language="bash" word-break style="display: block" />
          <n-button type="primary" block style="margin-top: 8px" @click="copyIntegrationInstallCmd(tokenModalInstallCmd)">
            📋 复制 {{ tokenModalGuide.product }} 安装命令
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
  { title: '命令', key: 'command', width: 120, render: (row) => h('code', {}, `#${row.command}`) },
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

// WS Remote: token 生成与接入指引（仅用于前端展示，不写入 Agent 配置）
const tokenGenerating = ref(false)
type WsIntegration = 'hermes' | 'openclaw' | 'qwenpaw'
const wsIntegration = ref<WsIntegration>('hermes')

const wsIntegrationOptions = [
  { label: 'Hermes', value: 'hermes' },
  { label: 'OpenClaw', value: 'openclaw' },
  { label: 'QwenPaw', value: 'qwenpaw' },
]

type IntegrationGuide = { product: string; title: string; summary: string; steps: string[] }

function getIntegrationGuide(integration: WsIntegration): IntegrationGuide {
  const guides: Record<WsIntegration, IntegrationGuide> = {
    hermes: {
      product: 'Hermes',
      title: 'Hermes 接入指引',
      summary: '在 Hermes Gateway 中安装并启用 WeClawBot Channel Adapter。',
      steps: [
        '执行下方命令安装 Hermes 插件，并写入 Bridge 连接配置。',
        '重启 hermes-gateway.service，日志出现 authenticated to Bridge 即完成接入。',
      ],
    },
    openclaw: {
      product: 'OpenClaw',
      title: 'OpenClaw 接入指引',
      summary: '安装并启用 openclaw-weclawbot-channel 插件。',
      steps: [
        '执行下方命令安装、构建并启用 OpenClaw 插件。',
        '重启 OpenClaw Gateway，日志出现 authenticated as agent 即完成接入。',
      ],
    },
    qwenpaw: {
      product: 'QwenPaw',
      title: 'QwenPaw 接入指引',
      summary: '在 QwenPaw 中安装 qwenpaw-weclawbot-channel 插件。',
      steps: [
        '执行下方命令安装插件，然后启动 QwenPaw。',
        '在 QwenPaw 控制台“频道管理”添加 WeClawBot Bridge 频道，填写下方连接信息。',
        'Agent Name 与 Command Alias 留空，以 Bridge 面板配置为准。',
      ],
    },
  }
  return guides[integration]
}

function buildIntegrationInstallCmd(integration: WsIntegration, agentId: string, token: string): string {
  const bridgeUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent`
  const id = agentId || '<Agent ID>'
  const wsToken = token || '<Token>'

  if (integration === 'hermes') {
    return [
      'git clone https://github.com/gowfqk/hermes-weclawbot-channel.git',
      'mkdir -p ~/.hermes/plugins/weclawbot',
      'cp hermes-weclawbot-channel/plugin.yaml ~/.hermes/plugins/weclawbot/',
      'cp hermes-weclawbot-channel/src/adapter.py ~/.hermes/plugins/weclawbot/__init__.py',
      'hermes plugins enable weclawbot',
      `WECLAWBOT_TOKEN='${wsToken}' WECLAWBOT_BRIDGE_URL='${bridgeUrl}' WECLAWBOT_AGENT_ID='${id}' hermes gateway restart`,
    ].join('\n')
  }

  if (integration === 'openclaw') {
    return [
      'git clone https://github.com/gowfqk/openclaw-weclawbot-channel.git',
      'cd openclaw-weclawbot-channel && npm install && npm run build',
      'openclaw plugins install --link "$(pwd)"',
      'openclaw config set plugins.entries.weclawbot.enabled true',
      `WECLAWBOT_TOKEN='${wsToken}' WECLAWBOT_BRIDGE_URL='${bridgeUrl}' WECLAWBOT_AGENT_ID='${id}' openclaw gateway restart`,
    ].join('\n')
  }

  return [
    'git clone https://github.com/gowfqk/qwenpaw-weclawbot-channel.git',
    'qwenpaw plugin install ./qwenpaw-weclawbot-channel',
    'qwenpaw app',
    '',
    '# 然后在 QwenPaw 控制台“频道管理”添加 WeClawBot Bridge 频道：',
    `# Bridge URL: ${bridgeUrl}`,
    `# Agent ID: ${id}`,
    `# WS Token: ${wsToken}`,
  ].join('\n')
}

const integrationGuide = computed(() => getIntegrationGuide(wsIntegration.value))
const formIntegrationInstallCmd = computed(() =>
  buildIntegrationInstallCmd(wsIntegration.value, form.value.id, form.value.apiKey || ''),
)

// WS Remote: 查看已有 Token
const tokenModalAgent = ref<Agent | null>(null)
const tokenModalVisible = ref(false)
const tokenModalLoading = ref(false)
const tokenModalValue = ref('')
const tokenModalIntegration = ref<WsIntegration>('hermes')
const tokenModalGuide = computed(() => getIntegrationGuide(tokenModalIntegration.value))
const tokenModalInstallCmd = computed(() =>
  buildIntegrationInstallCmd(
    tokenModalIntegration.value,
    tokenModalAgent.value?.id || '',
    tokenModalValue.value,
  ),
)

const bridgeWsUrl = computed(() =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/agent`
)

function copyTokenToClipboard() {
  navigator.clipboard.writeText(tokenModalValue.value).then(
    () => message.success('Token 已复制'),
    () => message.error('复制失败'),
  )
}

function copyIntegrationInstallCmd(command: string) {
  navigator.clipboard.writeText(command).then(
    () => message.success('安装命令已复制'),
    () => message.error('复制失败，请手动选中复制'),
  )
}


async function showTokenModal(agent: Agent) {
  tokenModalAgent.value = agent
  tokenModalIntegration.value = 'hermes'
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
    message.success('Token 已生成，请按下方接入指引配置 Agent 端')
  } catch (e: any) {
    message.error(e.message || 'Token 生成失败')
  } finally {
    tokenGenerating.value = false
  }
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
  wsIntegration.value = 'hermes'
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
            message.success('Agent 已添加，Token 已自动生成！请按下方接入指引配置 Agent 端')
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
