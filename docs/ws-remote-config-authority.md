# ws-remote Agent 连接不再覆盖面板配置

## 背景

WeClawBot-Bridge 把一个微信账号接到多个「Agent」后端。Agent 有几种类型：`http`、`cli`、`ws`，以及本文关注的 **`ws-remote`**。

`ws-remote` 的特点是**由 Agent 主动连接 Bridge**，而不是 Bridge 去连 Agent：

```text
微信 → Bridge ──(WS Server: /ws/agent)── Agent 客户端（如 QwenPaw 插件）
```

连接握手的协议在 `src/ws-agent-server.ts` 顶部有完整描述，简化后是：

1. Agent 连上后先发 `{type:'auth', token, agentId, name?, command?, description?, model?}`。
2. Bridge 校验 `token` → 回 `{type:'auth_ok'}` 或 `{type:'auth_fail'}`。
3. 认证成功后 Bridge 触发 `onAgentConnect(agentId, info)` 回调（定义在 `src/index.ts` 的 `main()` 里）。

`onAgentConnect` 做的事，是把这个 `agentId` **动态注册**进 `AgentRegistry`（`type: 'ws-remote'`）。注册进去的 `command` 字段很关键：它是微信端切换 Agent 的命令 key。`CommandHandler.updateAgents()`（`src/command-handler.ts`）会用它建一张 `command → agent` 的表：

```ts
for (const agent of this.agents) {
  const normalized = agent.command.toLowerCase()
  if (this.agentCommands.has(normalized)) continue  // 先注册者胜，重复命令的后者不可达
  this.agentCommands.set(normalized, agent)
}
```

> **关键点**：如果两个 Agent 的 `command` 相同，只有第一个能被 `#command` 选中，第二个永远无法路由。

除了握手动态注册，Agent 也可以在 Bridge 管理面板里**预先配置**（`PUT /api/agents/:id`，持久化到 storage），面板里能给每个 Agent 指定独立的名称、切换命令、超时等。

## 直觉

问题出在「面板配置」和「连接握手」谁说了算。改动前，`onAgentConnect` 让**握手值优先**：

```ts
name: info.name || existing?.name || agentId,
command: info.command || existing?.command || agentId,   // ← info.* 在前，覆盖面板配置
```

于是每次 Agent 一连接，就把面板里配好的 `name`/`command`/`description` **重置**成握手带来的值。

QwenPaw 插件的握手默认 `command="qwenpaw"`。设想你想接两个 QwenPaw 实例：

| 面板配置 | agentId | command（面板） | 连接后 command（改动前） |
|---|---|---|---|
| 实例 A | `qwenpaw-a` | `qa` | **被改成 `qwenpaw`** |
| 实例 B | `qwenpaw-b` | `qb` | **被改成 `qwenpaw`** |

两个都变成 `qwenpaw` → 命令表冲突 → 你只能切到其中一个，另一个彻底接不进来。

改动后，**面板/存储配置是权威**：对已存在的 Agent，握手不再覆盖它的 `name`/`command`/`description`/`model`；握手值只用于给「首次动态接入、面板里还没有」的全新 Agent 做种子。上表里 A 保持 `qa`、B 保持 `qb`，互不干扰。

## 代码

改动集中在两处，逻辑抽成一个纯函数便于单测（沿用仓库既有的 `src/ws-token.ts` 纯函数 + 测试的风格）。

**新增 `src/ws-agent-registration.ts`** —— 合并规则的唯一出处：

```ts
export function buildWsRemoteAgentConfig(
  agentId: string,
  info: WsAgentConnectInfo,
  existing?: AgentConfig,
): AgentConfig {
  return {
    ...existing,
    id: agentId,
    name: existing?.name || info.name || agentId,               // existing 优先
    command: existing?.command || info.command || agentId,       // existing 优先
    type: 'ws-remote',
    description:
      existing?.description || info.description || `WebSocket 远程 Agent (${info.name || agentId})`,
    timeout: existing?.timeout ?? 60000,
    model: existing?.model ?? info.model,
  }
}
```

**`src/index.ts` 的 `onAgentConnect`** —— 改为调用该函数：

```ts
const existing = agentRegistry.get(agentId)
agentRegistry.register(buildWsRemoteAgentConfig(agentId, info, existing))
commandHandler.updateAgents(agentRegistry.listAll())
```

**新增 `src/ws-agent-registration.test.ts`** —— 覆盖：已存在时不被握手覆盖、两实例命令不冲突、全新 Agent 用握手种子、空字段回退到 `agentId`、`model` 以面板为准。

## 验证

- 新单测：`npx vitest run src/ws-agent-registration.test.ts` → 5 passed。
- 全量测试：`npx vitest run` → **52 passed**（11 个测试文件）。
- 类型检查：`npx tsc --noEmit` → 无错误。

手动质量验收（多实例路由）：

1. 面板创建两个 `ws-remote` Agent：`qwenpaw-a`（命令 `qa`）、`qwenpaw-b`（命令 `qb`），各自生成 Token。
2. 启两个 QwenPaw 实例，插件分别填 `Agent ID = qwenpaw-a / qwenpaw-b` 和对应 Token，`Agent Name`/`Command Alias` 留空。
3. 两个实例都连上后，微信发 `#agents`，确认 `qa`、`qb` 都在且名称正确。
4. 分别 `#qa`、`#qb` 切换并发消息，确认路由到各自实例，且切换后命令**不再被改回** `qwenpaw`。

## 替代方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 只改插件：握手不发 `name`/`command` | 不动 Bridge | 治不了根：`authenticate()` 会把空 `name`/`command` 回填成 `agentId` 再传给 `onAgentConnect`，面板配置仍被覆盖 |
| 在 `authenticate()` 里就保留 `existing` | 覆盖点更靠前 | 职责错位：WS Server 的认证层不应依赖 `AgentRegistry`，会把连接层和配置层耦合起来 |

本 PR 采用「在 `onAgentConnect` 处让 existing 优先」，改动最小、职责清晰，且与插件侧「默认不上报 name/command」的清理相互配合形成双保险。

## 建议与之交谈的人员

- **gowfqk / Zhang Deshuai**（`guowenqing43@gmail.com`）—— `src/index.ts` 与 `src/ws-agent-server.ts` 的主要作者，最了解 ws-remote 动态注册、心跳与 token 持久化的设计取舍。改动触及注册优先级，建议请其确认「面板权威」这一取向是否符合预期。

## 测验

<details>
<summary>1. 为什么两个 command 相同的 Agent 会导致其中一个不可达？</summary>

- **A. Bridge 只允许注册一个 ws-remote Agent** — 错。可注册多个，键是 `agentId`，互不冲突。
- **B. `CommandHandler.updateAgents` 用 command 建映射，遇到重复命令会 `continue` 跳过后者** — ✅ 正确。命令表 key 是小写 command，先注册者占位，后者被跳过，无法通过 `#command` 选中。
- **C. 微信不支持相同命令** — 错。这是 Bridge 内部映射逻辑，与微信无关。
- **D. Token 会冲突** — 错。Token 按 `agentId` 独立管理，与 command 无关。
</details>

<details>
<summary>2. 改动前，为什么面板配置的 command 会被重置？</summary>

- **A. `onAgentConnect` 里 `command: info.command || existing?.command` 让握手值优先** — ✅ 正确。只要握手带了非空 command（插件默认 `qwenpaw`），就覆盖面板的 `existing.command`。
- **B. storage 每次连接会清空** — 错。storage 未被清空，问题在内存注册的优先级。
- **C. 心跳超时导致重置** — 错。与心跳无关。
- **D. `updateAgents` 会重写 command** — 错。它只读取 command 建表，不修改。
</details>

<details>
<summary>3. 为什么「只改插件、不发 name/command」不能根治问题？</summary>

- **A. 插件无法控制握手内容** — 错。插件完全可以发空字段。
- **B. `authenticate()` 会把空 `name`/`command` 回填为 `agentId` 再传给 `onAgentConnect`，仍会覆盖 existing** — ✅ 正确。`conn.name = name || agentId`、`conn.command = command || agentId`，因此传给回调的值永远非空。
- **C. 空字段会导致认证失败** — 错。认证只校验 `token` 和 `agentId`。
- **D. 插件的默认值改不了** — 错。本 PR 的姊妹改动正是改了插件默认值。
</details>

<details>
<summary>4. `buildWsRemoteAgentConfig` 对一个「面板里还不存在」的全新 Agent 如何取值？</summary>

- **A. 一律用 `agentId`** — 错。只有握手值也为空时才回退到 `agentId`。
- **B. `existing` 为 `undefined`，于是用 `info.*`（握手值）作为种子，握手也空时才回退 `agentId`** — ✅ 正确。例如 `name: undefined || info.name || agentId`。
- **C. 抛错，要求先在面板配置** — 错。仍支持动态接入。
- **D. 全部留空** — 错。`AgentConfig` 的必填字段都会被赋值。
</details>

<details>
<summary>5. 为什么把合并逻辑抽成独立的纯函数 `buildWsRemoteAgentConfig`？</summary>

- **A. 性能更好** — 错。与性能无关。
- **B. `onAgentConnect` 是 `main()` 内的闭包回调，难以直接单测；抽成纯函数后可脱离网络/注册表独立测试，且与仓库既有 `ws-token.ts` 风格一致** — ✅ 正确。
- **C. TypeScript 要求回调必须是纯函数** — 错。无此要求。
- **D. 为了绕过类型检查** — 错。类型检查照常通过。
</details>
