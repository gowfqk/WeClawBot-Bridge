# weclawbot-agent-plugin

[![npm version](https://img.shields.io/npm/v/weclawbot-agent-plugin.svg)](https://www.npmjs.com/package/weclawbot-agent-plugin)
[![CI](https://github.com/nicepkg/weclawbot-bridge/actions/workflows/publish-agent-plugin.yml/badge.svg)](https://github.com/nicepkg/weclawbot-bridge/actions/workflows/publish-agent-plugin.yml)

WeClawBot Agent 插件 SDK — 让 AI Agent 主动连接 WeClawBot-Bridge，无需起 HTTP 服务。

## 架构

```
┌─────────────┐    WebSocket     ┌──────────────────────┐
│  AI Agent   │ ────connect────► │  WeClawBot-Bridge    │
│  (插件端)   │ ◄────chat────── │  (WS Server)         │
│             │ ────reply──────► │       │              │
└─────────────┘                  │       ▼              │
                                  │    WeChat Bot       │
                                  └──────────────────────┘
```

Agent **不需要**起 HTTP 服务，装上插件就主动连 Bridge。

## 安装

```bash
npm install weclawbot-agent-plugin
```

## 快速开始

### 方式一：零代码（aiBackend 配置）

**推荐**：如果你对接的是标准 AI API（Hermes、OpenClaw、QwenPaw 等），无需写任何代码，直接配置 `aiBackend` 即可：

```typescript
import { WeClawBotAgent } from 'weclawbot-agent-plugin'

const agent = new WeClawBotAgent({
  bridgeUrl: 'ws://bridge-host:3000/ws/agent',
  agentId: 'my-agent',
  token: 'wsk_my-agent_xxx',
  name: 'Hermes Agent',
  command: 'hermes',
  aiBackend: {
    url: 'https://your-ai-api.com',     // AI 服务地址
    apiKey: 'sk-xxx',                    // API Key
    format: 'openai',                    // openai | qwenpaw | native
    model: 'gpt-4',                      // 可选：模型名
    systemPrompt: 'You are helpful.',    // 可选：system prompt（仅 openai）
  },
}, (status) => {
  console.log('状态:', status)
})

// 无需 onMessage handler！
agent.connect()
```

### 方式二：自定义处理（onMessage）

如果你需要自定义消息处理逻辑（如调用本地模型、多 Agent 路由等）：

### 1. 在 Bridge 管理面板创建 WS Remote Agent

管理面板 → **Agent 管理** → 添加 `WS Remote (插件接入)` 类型 Agent → 点击「生成 Token」→ 复制安装命令。

或手动生成 Token：

```bash
curl -X POST http://bridge-host:3000/api/ws-agents/my-agent/token \
  -H "Cookie: wcbot_session=<session>"
# → { "agentId": "my-agent", "token": "wsk_my-agent_xxx" }
```

### 2. Agent 端使用插件

```typescript
import { WeClawBotAgent } from 'weclawbot-agent-plugin'

const agent = new WeClawBotAgent({
  bridgeUrl: 'ws://bridge-host:3000/ws/agent',  // 或 wss://
  agentId: 'my-agent',
  token: 'wsk_my-agent_xxx',
  name: 'Claude Agent',
  command: 'claude',
}, (status) => {
  console.log('状态:', status)  // disconnected | connecting | connected | reconnecting | failed
})

// 注册消息处理
agent.onMessage(async (msg) => {
  console.log(`收到: ${msg.text}`)
  console.log(`用户: ${msg.userId}`)
  console.log(`历史: ${msg.history.length} 条`)

  // 调用你的 AI
  const reply = await yourAI.chat(msg.text, msg.history)

  return { text: reply }
})

// 连接 Bridge
agent.connect()
```

### 3. 微信中使用

用户在微信发 `#claude` 切换到该 Agent，之后所有消息都路由到你的 AI。

### 方式三：CLI 工具接入（Claude Code / OpenCode / Codex）

如果你想把本地 CLI 工具（Claude Code、OpenCode、Codex）接入微信，使用 `onMessage` 模式 spawn 命令行：

**Claude Code：**
```typescript
import { WeClawBotAgent } from 'weclawbot-agent-plugin'
import { execFile } from 'child_process'
import { promisify } from 'util'

const agent = new WeClawBotAgent({
  bridgeUrl: 'wss://bridge/ws/agent',
  agentId: 'claude-code', token: 'wsk_xxx',
  name: 'Claude Code', command: 'cc',
})

agent.onMessage(async (msg) => {
  const { stdout } = await promisify(execFile)(
    'claude', ['-p', msg.text, '--output-format', 'text'],
    { timeout: 120000 }
  )
  return { text: stdout.trim() }
})

agent.connect()
```

**OpenCode：** 把上面 `claude` 改成 `opencode`，参数改为 `['run', msg.text]`

**Codex：** 把上面 `claude` 改成 `codex`，参数改为 `['exec', msg.text]`，超时建议 300000。

> 管理面板生成 Token 时可选择模板，自动生成对应脚本。

## API

### `new WeClawBotAgent(config, onStatusChange?)`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `config.bridgeUrl` | `string` | ✅ | Bridge WS 端点，如 `ws://host:3000/ws/agent` 或 `wss://host/ws/agent` |
| `config.agentId` | `string` | ✅ | Agent ID（与管理面板一致） |
| `config.token` | `string` | ✅ | 认证 Token（管理面板生成，持久化不丢失） |
| `config.name` | `string` | | 显示名称 |
| `config.command` | `string` | | 微信切换命令（用户发 `#command` 切换） |
| `config.description` | `string` | | Agent 描述 |
| `config.model` | `string` | | 模型标识 |
| `config.reconnectInterval` | `number` | | 重连基础间隔 ms（默认 3000，指数退避） |
| `config.heartbeatInterval` | `number` | | 心跳间隔 ms（默认 25000） |
| `config.maxReconnectAttempts` | `number` | | 最大重连次数（默认无限） |
| `onStatusChange` | `(status: AgentStatus) => void` | | 状态变更回调 |

### `agent.onMessage(handler)`

注册消息处理函数。

```typescript
agent.onMessage(async (msg: IncomingMessage) => {
  // msg.id       - 请求 ID
  // msg.text     - 用户消息文本
  // msg.type     - 消息类型 ('text')
  // msg.userId   - 微信用户 ID
  // msg.agentId  - Agent ID
  // msg.history  - 对话历史 [{role, content}]

  return { text: '回复内容' }
})
```

### `agent.connect()`

连接到 Bridge。自动处理认证、心跳、断线重连（指数退避）。

### `agent.disconnect()`

主动断开连接，停止重连。

### `agent.push(text, userId?)`

主动推送消息给 Bridge（如通知微信用户）。

```typescript
await agent.push('任务完成 ✅', 'wxid_xxx')
```

### `agent.getStatus()`

获取当前连接状态：`disconnected | connecting | connected | reconnecting | failed`

## 特性

- **自动重连**：指数退避策略，默认 3s → 6s → 12s → ...，最大间隔 60s
- **心跳保活**：默认 25s 间隔，防止连接被中间层关闭
- **Token 持久化**：Bridge 重启后 Token 不丢失，插件自动重连即可恢复
- **TypeScript 支持**：完整类型定义，`dist/index.d.ts` 自动加载

## 协议

WebSocket 消息均为 JSON：

| 方向 | type | 说明 |
|------|------|------|
| Agent → Bridge | `auth` | 认证 `{type:'auth', token, agentId, name?, command?}` |
| Bridge → Agent | `auth_ok` | 认证成功 `{type:'auth_ok', agentId}` |
| Bridge → Agent | `auth_fail` | 认证失败 `{type:'auth_fail', reason}` |
| Bridge → Agent | `chat` | 聊天请求 `{type:'chat', id, payload}` |
| Agent → Bridge | `chat` | 聊天回复 `{type:'chat', id, text}` |
| Agent → Bridge | `push` | 主动推送 `{type:'push', text, userId?}` |
| 双方 | `ping/pong` | 心跳 |

## 发布

通过 GitHub Actions 自动发布到 npm：

```bash
# 1. 更新 agent-plugin/package.json 的 version
# 2. 提交并打 tag
git tag agent-plugin-v1.0.1
git push origin main --tags
```

需要在 GitHub repo Settings → Secrets 中配置 `NPM_TOKEN`。

## License

MIT
