# WeClawBot Bridge

微信 ↔ AI Agent 桥接网关 — 单 Bot 多 Agent 命令切换，支持 HTTP / CLI / WS Remote 多模式，自带 Vue 3 管理面板。

## ✨ 功能特性

- **一个 Bot，多种 Agent**：微信用 `#命令` 切换 HTTP、CLI、WS Remote Agent；每个 Agent 保留独立对话历史。
- **插件接入**：Hermes、OpenClaw、QwenPaw 通过专用 Channel 接入；Claude Code、OpenCode、Codex CLI 也可通过 WS SDK 接入。Bridge 自动生成 Token 与对应安装指引。
- **OpenAI 兼容 API**：`POST /v1/chat/completions` 以 `model` = Agent ID 路由到指定 Agent，支持 `GET /v1/models` 与 SSE 响应。
- **管理与运维**：内置 Agent、会话、Bot 登录、通知、定时任务和 API 参考面板；支持二维码自动刷新、Webhook、结构化日志与 Prometheus 指标。
- **定时推送**：一次性提醒、固定间隔与 cron 三种调度，内容可以是固定文本，也可以到点先调用 Agent、推送它的回复；默认北京时间，重启后不重复补推。
- **安全与可靠性**：密码/API Key 认证、CSRF 防护、可选加密存储、WS 自动重连，以及轮询健康恢复。

## 🚀 快速开始

### 1. 安装依赖

```bash
# 后端
npm install

# 前端
cd frontend && npm install && cd ..
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env。公网部署必须设置 API_KEY 和 ENCRYPTION_KEY。
```

### 3. 构建并启动

```bash
# 构建前端 + 后端
cd frontend && npm run build && cd ..   # 前端产物输出到 public/
npm run build                           # 后端产物输出到 dist/

# 启动
node dist/index.js
```

或开发模式：

```bash
PORT=5000 npm run dev
```

启动后访问 `http://localhost:3000` 进入管理面板。未设置 `API_KEY` 时，首次密码只能从 Bridge 所在主机设置；公网部署请在启动前设置 `API_KEY`。

### 4. 登录微信 Bot

管理面板 → **Bot 控制** 页面，点击「手动刷新二维码」，用微信扫码登录。二维码过期后会自动刷新。

### 添加 Agent

管理面板 → **Agent 管理** → 填写配置后点「添加 Agent」：

选择类型后填写所需配置：HTTP Agent 支持 OpenAI 兼容端点，CLI Agent 可运行本地命令行工具，WS Remote 用于插件主动连接。

**WS Remote Agent（插件接入）：**

1. 类型选择 **WS Remote (插件接入)**，填写 ID、名称和切换命令；
2. 从“接入方式”选择专用 Channel 插件（**Hermes / OpenClaw / QwenPaw**），或通用 SDK（**Claude Code / OpenCode / Codex CLI**）；
3. 点击「生成 Token」，复制当前接入方式对应的安装命令；
4. 在 Agent 端执行安装命令并重启对应服务。列表中的「Token」按钮可随时查看 Token 与重新复制对应命令。

### 接入 Hermes / OpenClaw / QwenPaw

WS Remote 通过各平台的专用 Channel 插件连接 Bridge：

| 平台 | Channel 插件 |
|---|---|
| Hermes | [hermes-weclawbot-channel](https://github.com/gowfqk/hermes-weclawbot-channel) |
| OpenClaw | [openclaw-weclawbot-channel](https://github.com/gowfqk/openclaw-weclawbot-channel) |
| QwenPaw | [qwenpaw-weclawbot-channel](https://github.com/gowfqk/qwenpaw-weclawbot-channel) |

三个后端可**并行运行**；每个实例使用独立的 Agent ID 与 Token，微信内通过 `#<命令>` 切换：

```text
#hermes    → Hermes
#openclaw  → OpenClaw
#qwenpaw   → QwenPaw
```

### 微信中使用

| 命令 | 功能 |
|------|------|
| `#help` / `#h` | 显示帮助 |
| `#agents` / `#a` | 列出所有 Agent |
| `#status` | 查看所有 Agent 的在线状态 |
| `#clear` | 清空当前 Agent 的会话历史 |
| `#<命令>` | 切换到对应 Agent（会话历史保留） |
| 直接发消息 | 与当前 Agent 对话 |

## 🐳 Docker 部署

```bash
# 构建镜像（多阶段：前端 + 后端）
docker build -t weclawbot-bridge .

# 运行
docker run -d \
  -p 3000:3000 \
  -v weclawbot-data:/data \
  -e STORAGE_DIR=/data \
  -e API_KEY=your-password \
  -e ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  --name weclawbot \
  weclawbot-bridge
```

访问 `http://localhost:3000` 进入管理面板。

## 🔧 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `API_KEY` | 管理面板密码；公网部署时必填 | 本机首次访问时设置 |
| `ENCRYPTION_KEY` | 加密所有持久化凭证、Agent 配置、会话和通知数据的 32 字节十六进制密钥 | 无 |
| `STORAGE_DIR` | 数据存储目录 | `.wechatbot-gateway` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `SESSION_MAX_ROUNDS` | 会话最大轮次，`0` = 不限制 | `0` |
| `SESSION_EXPIRE_MS` | 会话过期时间（毫秒），`0` = 永不过期 | `0` |
| `ALLOWED_ORIGINS` | CORS 允许的源（逗号分隔） | `http://localhost:3000` |
| `WEBHOOK_SECRET` | Webhook 密钥，设置后需 `X-Webhook-Secret` 头认证 | 无（回退到 Bearer Token） |

> 升级提示：启用 `ENCRYPTION_KEY` 后，Bridge 会在读取旧的结构化存储记录时迁移它们。确认服务正常运行后，删除旧的 `$STORAGE_DIR/agents.json`（或默认的 `config/agents.json`）副本，避免历史明文 API Key 留在磁盘上。

## 📡 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/metrics` | Prometheus 指标 |
| GET | `/v1/models` | OpenAI 兼容：列出可调用的 Agent 模型 ID |
| POST | `/v1/chat/completions` | OpenAI 兼容：以 `model`（Agent ID）调用指定 Agent |
| POST | `/api/auth/login` | 管理面板登录 |
| GET | `/api/auth/status` | 检查登录状态 |
| POST | `/api/auth/setup` | 首次设置密码 |
| POST | `/api/auth/change-password` | 修改管理密码 |
| POST | `/api/bot/login` | 获取 Bot 登录二维码 |
| GET | `/api/bot/status` | Bot 在线状态及二维码 URL |
| GET | `/api/agents` | 列出所有 Agent |
| POST | `/api/agents` | 注册新 Agent |
| PUT | `/api/agents/:id` | 更新 Agent |
| DELETE | `/api/agents/:id` | 删除 Agent |
| POST | `/api/agents/:id/test` | 测试 Agent 调用 |
| GET | `/api/ws-agents` | 列出在线 WS Remote Agent |
| POST | `/api/ws-agents/:id/token` | 生成/刷新 Agent Token（Hermes/OpenClaw 等 Gateway 接入用） |
| GET | `/api/ws-agents/:id/token` | 查看已有 Token |
| GET | `/api/sessions` | 列出所有会话 |
| GET | `/api/sessions/detail` | 查看会话详情（含对话历史） |
| DELETE | `/api/sessions/clear` | 删除指定会话或清空全部 |
| GET | `/api/sessions/config` | 获取会话配置 |
| PUT | `/api/sessions/config` | 更新会话配置（轮次/过期时间） |
| POST | `/api/notify` | 发送通知消息 |
| GET | `/api/notify/log` | 出站发送记录（通知 / 定时任务 / 对话回复，含失败原因） |
| GET | `/api/scheduled-tasks` | 列出定时任务（含下次执行时间） |
| POST | `/api/scheduled-tasks` | 新建定时任务 |
| PUT | `/api/scheduled-tasks/:id` | 更新定时任务 |
| DELETE | `/api/scheduled-tasks/:id` | 删除定时任务 |
| POST | `/api/scheduled-tasks/:id/toggle` | 启用/停用（body 省略 `enabled` 时取反） |
| POST | `/api/scheduled-tasks/:id/run` | 立即试跑一次（一次性任务会被置为已执行） |
| GET | `/api/scheduled-tasks/preview-next` | 预览 cron+时区的下次触发时刻（`?schedule=0 9 * * *&timezone=Asia/Shanghai`） |
| POST | `/api/webhook` | Webhook 推送（userId 可选） |
| GET | `/api/session-alert` | session 过期提醒：开关、掉线记录、当前掉线/待发状态 |
| PUT | `/api/session-alert` | 更新开关与 webhook（`{"recordEnabled":true,"pushEnabled":false,"webhookEnabled":true,"webhookUrl":"https://…","webhookFormat":"json"}`，可只传一项） |

### OpenAI 兼容调用

Bridge 提供标准 OpenAI Chat Completions 接口。`model` 不是底层模型名，而是管理面板中配置的 **Agent ID**；因此可用同一个 OpenAI 客户端调用 HTTP、CLI、WS Remote 等不同 Agent。

认证使用 Bridge 的 `API_KEY`（或管理密码），通过 `Authorization: Bearer` 传入；不要使用管理面板登录后得到的临时会话 Token。

```bash
# 查看可用 Agent ID（可作为 model 使用）
curl https://your-domain/v1/models \
  -H "Authorization: Bearer $API_KEY"

# 调用 ID 为 hermes 的 Agent
curl https://your-domain/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hermes",
    "messages": [
      {"role": "user", "content": "你好"}
    ]
  }'
```

当前 `/v1` 为**无状态**接口：客户端每次应传入完整 `messages` 历史，Bridge 不保存 OpenAI API 对话历史。支持文本 `user`、`assistant`、`system`、`developer` 消息；后两者会以带标签的文本指引转发给 Agent，非底层模型的原生 system role。工具调用和多模态内容暂不支持。可选 `user` 仅作为传给 Agent 的匿名调用方标识。

支持 `stream: true`，返回 OpenAI SSE 格式的**单块完成响应**（不是逐 token 转发）。Agent 离线、下游限流、超时或调用失败会返回对应的 OpenAI 格式 `503`、`429`、`504` 或 `502` 错误。

### Webhook 使用示例

> **认证说明**：Webhook 端点需要认证。支持两种方式：
> - **Webhook Secret**：设置环境变量 `WEBHOOK_SECRET` 后，请求需携带 `X-Webhook-Secret` 头（推荐用于 CI/CD）
> - **Bearer Token**：未设置 `WEBHOOK_SECRET` 时，使用管理面板的会话 Token 认证

```bash
# 使用 Webhook Secret 认证（推荐）
curl -X POST https://your-domain/api/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-webhook-secret" \
  -d '{"content":{"text":"部署完成 ✅"}}'

# 使用 Bearer Token 认证
curl -X POST https://your-domain/api/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session-token>" \
  -d '{"content":{"text":"部署完成 ✅"}}'

# Markdown 格式（微信支持渲染）
curl -X POST https://your-domain/api/webhook \
  -H "Content-Type: application/json" \
  -d '{"content":{"text":"**部署报告**\n| 项目 | 状态 |\n|------|------|\n| 前端 | ✅ |\n| 后端 | ✅ |"}}'

# 简写格式
curl -X POST https://your-domain/api/webhook \
  -H "Content-Type: application/json" \
  -d '{"text":"部署完成 ✅"}'

# 指定接收人
curl -X POST https://your-domain/api/webhook \
  -H "Content-Type: application/json" \
  -d '{"userId": "wxid_xxx", "content":{"text":"部署完成 ✅"}}'
```

### GitHub Actions 集成

在仓库 Secrets 中添加 `WECLAW_WEBHOOK_URL` 和 `WECLAW_WEBHOOK_SECRET`：

```yaml
- name: 微信通知
  run: |
    curl -s -X POST ${{ secrets.WECLAW_WEBHOOK_URL }} \
      -H "Content-Type: application/json" \
      -H "X-Webhook-Secret: ${{ secrets.WECLAW_WEBHOOK_SECRET }}" \
      -d "{\"content\":{\"text\":\"✅ [${{ github.repository }}] 部署成功\"}}"
```

## 💬 会话管理

会话按「用户 × Agent」独立维护，支持在 Web 面板中管理：

- **配置**：设置最大对话轮次和过期时间（可设为永不过期），配置持久化保存
- **列表**：查看所有活跃会话，显示消息数、最后活跃时间、过期状态
- **详情**：查看完整对话历史，区分用户/助手消息及时间戳
- **操作**：逐条删除或一键清空全部会话

默认配置：对话轮次不限制，会话永不过期。

## ⏰ 定时任务

面板「定时任务」页（`/scheduled`）用于到点主动推送到微信，与「通知管理」里的通知规则彼此独立、互不影响。

**三种调度方式**

| 类型 | 配置项 | 说明 |
|------|--------|------|
| 一次性 | 执行时间 | 到点推送一次后自动停用；改时间可重新触发 |
| 固定间隔 | 间隔分钟数（1 分钟 ~ 7 天） | 从上次执行时刻往后推，首次从创建时刻起算 |
| Cron | 5 或 6 段表达式 + 时区 | 默认时区 **Asia/Shanghai**，容器是 UTC 也不受影响 |

**两种内容来源**

- **固定文本**：到点原样推送。
- **先问 Agent**：到点用任务自己的提示词调用所选 Agent，把它的回复推送过来。每次调用都走独立会话、不携带任何历史，既不打扰你与 Agent 的微信对话，也不会把昨天的内容滚进今天的提问。

**行为细节**

- 单个 tick 循环（默认 20 秒）统一驱动所有任务，每个任务持久化自己的 `nextRunAt`，因此重启后不需要重建定时器，面板也能直接显示「下次执行时间」。
- 服务停机、容器重启导致错过的执行点，只在 **15 分钟宽限期**内补跑；更久以前的一律标记为「已跳过」并顺延到下一个点，避免恢复时集中轰炸微信。
- 校验严格：非法 cron 表达式、无法识别的时区、未来一年内不会触发的表达式、指向已删除 Agent 的任务，都会在保存时被拒绝并给出中文原因。
- 失败与跳过的原因记录在任务本身上（列表「上次结果」一列），微信 Bot 离线时也不会静默丢消息。
- 「试跑」按钮立即执行一次并推送，用于验证 Agent 与文案；除一次性任务外不会改动原排期。

curl 示例（这些接口属于管理面板，使用登录后写入的 HttpOnly Cookie 认证；`API_KEY` 只用于 `/v1` 与 Webhook）：

```bash
# 先登录拿 cookie
curl -s -X POST https://your-domain/api/auth/login \
  -H "Content-Type: application/json" \
  -c /tmp/weclaw.jar \
  -d '{"password":"你的管理密码"}'

# 每个工作日北京时间 09:00，先问 Agent 再推送它的回复
curl -s -X POST https://your-domain/api/scheduled-tasks \
  -b /tmp/weclaw.jar \
  -H "Content-Type: application/json" \
  -d '{
    "id": "morning-brief",
    "name": "早报",
    "kind": "cron",
    "schedule": "0 9 * * 1-5",
    "timezone": "Asia/Shanghai",
    "source": "agent",
    "agentId": "hermes",
    "prompt": "给我 5 条今天的科技要闻，每条一句话"
  }'

# 查看某条 cron + 时区的下次触发时刻
curl -s -G https://your-domain/api/scheduled-tasks/preview-next \
  -b /tmp/weclaw.jar \
  --data-urlencode "schedule=0 9 * * 1-5" \
  --data-urlencode "timezone=Asia/Shanghai"
```

## 📮 消息送达与失败排查

微信 iLink Bot 协议只有「服务端是否受理」，**没有送达回执，也没有已读回执**。Bridge 能给出的上限是：调用微信接口有没有成功、失败原因是什么。

- **面板「通知」页 → 发送记录**：三类来源都会记 —— `通知`（规则和 Webhook）、`定时任务`、`对话回复`。记录只存文本摘要和媒体的类型/大小，不存二进制。
- **对话回复失败**：`内容` 是没发出去的回复，没有内容时回退显示 `触发` 字段（用户原文），`错误` 是 SDK 原始报错。
- **指标**：`gateway_send_failures_total{source}`、`gateway_sdk_errors_total{kind}`、`gateway_bot_online`，见 `/api/metrics`。
- **`No context_token cached for user …`**：该用户还没给 bot 发过消息，或 session 过期重登后 SDK 清空了上下文。主动推送（通知/定时任务）在此之前一定失败，需要用户在微信里先发一条消息。
- **Session 过期提醒（Bot 页）**：token/session 过期那一刻微信通道已经断了，微信侧的实时提醒在协议上做不到。Bridge 的做法是：过期/恢复事件先落到面板的掉线记录（含离线时长、期间漏推的主动推送条数），重新扫码恢复后再借用户第一条进来的消息的 context_token 补发一条微信提醒。Bot 页两个开关分别控制「记录事件」和「补发微信」，`GET /api/session-alert` 可查，指标 `gateway_session_expired_total`。
- **掉线事件出站 webhook（第三个开关）**：唯一能实时送达的提醒路径。开启后过期那一刻立即 POST 到外部地址，恢复时再 POST 一次（带离线时长和漏推条数）。两种格式：`json` 给自建接收端（`{"source":"weclawbot-bridge","event":"wechat_session_expired","at":…,"text":"…","clock":"10-31 08:00"}`，恢复事件另有 `offlineMs`/`missedPushes`），`text` 直接是企业微信/钉钉群机器人的 `{"msgtype":"text","text":{"content":"…"}}`。只支持 http/https，失败重试一次；群机器人业务失败也回 HTTP 200，所以响应体里的 `errcode` 非 0 同样记为失败。日志与面板只显示脱敏后的地址（去掉 query，机器人 token 不落日志）。每次推送计入 `gateway_session_webhook_total{status}`，结果也并进掉线记录的 `webhook` 字段。
- **Bot 页「最近 SDK 错误」**：轮询中断、微信侧限流等入站问题看这里；轮询停止期间消息不会送达，健康检查会自动重启。
- **长回复分条**：微信单条文本上限 4000 字，超出后 SDK 会按段落/换行/空格切一刀 —— 这会把 ` ``` ` 代码围栏拦腰截断，后半段的 Markdown 不再渲染。Bridge 先用 `markdown-chunk.ts` 按围栏边界切好再逐条发，每条都是完整代码块（超长围栏会重开围栏并带上原语言标记）。分条中途失败时前面几条已投递、无法撤回，发送记录里留下的是整条原文的摘要。
- **入站是 at-most-once**：SDK 先推进游标再交给处理器，进程在处理中途崩溃会丢掉那一条且不会记录。

## 🏗️ 项目结构

```
WeClawBot-Bridge/
├── src/                    # 后端源码 (Express + TypeScript)
│   ├── server.ts           # Express 服务器、路由、中间件
│   ├── index.ts            # 入口
│   ├── scheduled-task.ts           # 定时任务纯逻辑：校验 + 下次执行时刻
│   ├── scheduled-task-service.ts   # 定时任务调度：tick 循环、推送、补跑宽限
│   ├── outbound-log.ts             # 出站发送记录：通知/定时任务/对话回复的成功与失败
│   ├── markdown-chunk.ts           # 长文本分条：按 ``` 代码块边界切，不切断围栏
│   ├── session-alert.ts            # 掉线提醒纯逻辑：文案、时长、漏推计数、webhook 载荷与地址脱敏
│   ├── session-alert-service.ts    # 掉线事件记录 + 恢复后借首条来消息补发提醒 + 实时 webhook
│   └── ...
├── frontend/               # 前端源码 (Vue 3 + Vite)
│   ├── src/
│   │   ├── views/          # 页面组件 (Agents, Bot, Notify, Scheduled, Sessions, Settings, ApiRef)
│   │   ├── layouts/        # 布局组件 (AppLayout + 侧边栏)
│   │   ├── components/     # 通用组件 (ApiMethod, ApiParams)
│   │   ├── composables/    # API 层 (axios 封装)
│   │   ├── stores/         # Pinia 状态 (auth, theme)
│   │   ├── router/         # Vue Router (7 页面 + 登录守卫)
│   │   └── App.vue         # 根组件 (Naive UI providers)
│   ├── vite.config.ts      # Vite 配置 (自动导入 Naive UI 组件)
│   └── tsconfig.json
├── public/                 # 前端构建产物 (Vite 输出)
├── config/                 # 默认配置
├── Dockerfile              # 多阶段构建 (前端 + 后端)
└── package.json

关联仓库：

- [hermes-weclawbot-channel](https://github.com/gowfqk/hermes-weclawbot-channel) — Hermes Gateway 平台适配器
- [openclaw-weclawbot-channel](https://github.com/gowfqk/openclaw-weclawbot-channel) — OpenClaw Gateway Channel Plugin
- [qwenpaw-weclawbot-channel](https://github.com/gowfqk/qwenpaw-weclawbot-channel) — QwenPaw Channel Plugin
```

## 🛠️ 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js 22 · TypeScript · Express · WebSocket (ws) · Helmet · Pino · Zod · prom-client |
| 前端 | Vue 3 · Vite · Naive UI · Pinia · Vue Router · unplugin-vue-components |
| 部署 | Docker (多阶段构建) · GitHub Actions CI |

## 📄 License

MIT
