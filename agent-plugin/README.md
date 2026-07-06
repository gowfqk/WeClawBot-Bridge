# weclawbot-agent-plugin

WeClawBot Agent 插件 SDK — 让 AI Agent 主动连接 WeClawBot-Bridge。

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

### 1. 在 Bridge 管理面板创建 WS Remote Agent

在管理面板添加一个 `WS Remote (插件接入)` 类型的 Agent，记下 `Agent ID`。

### 2. 生成 Token

```bash
curl -X POST http://bridge-host:3000/api/ws-agents/my-agent/token \
  -H "Authorization: Bearer <admin-token>"
# → { "agentId": "my-agent", "token": "wsk_my-agent_xxx" }
```

### 3. Agent 端使用插件

```typescript
import { WeClawBotAgent } from 'weclawbot-agent-plugin'

const agent = new WeClawBotAgent({
  bridgeUrl: 'ws://bridge-host:3000/ws/agent',
  agentId: 'my-agent',
  token: 'wsk_my-agent_xxx',
  name: 'Claude Agent',
  command: 'claude',
})

// 注册消息处理
agent.onMessage(async (msg) => {
  console.log(`收到消息: ${msg.text}`)
  console.log(`用户: ${msg.userId}`)
  console.log(`历史: ${msg.history.length} 条`)

  // 调用你的 AI
  const reply = await yourAI.chat(msg.text, msg.history)

  return { text: reply }
})

// 连接
agent.connect()
```

## API

### `new WeClawBotAgent(config, onStatusChange?)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `config.bridgeUrl` | `string` | Bridge WS 端点，如 `ws://host:3000/ws/agent` |
| `config.agentId` | `string` | Agent ID（与管理面板一致） |
| `config.token` | `string` | 认证 Token |
| `config.name` | `string?` | 显示名称 |
| `config.command` | `string?` | 微信切换命令 |
| `config.reconnectInterval` | `number?` | 重连间隔 ms（默认 3000） |
| `config.heartbeatInterval` | `number?` | 心跳间隔 ms（默认 25000） |
| `config.maxReconnectAttempts` | `number?` | 最大重连次数（默认无限） |

### `agent.onMessage(handler)`

注册消息处理函数。`handler` 接收 `IncomingMessage`，返回 `OutgoingReply`。

### `agent.connect()`

连接到 Bridge。

### `agent.disconnect()`

断开连接。

### `agent.push(text, userId?)`

主动推送消息给 Bridge（如通知微信用户）。

### `agent.getStatus()`

获取当前状态：`disconnected | connecting | connected | reconnecting | failed`

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

## License

MIT
