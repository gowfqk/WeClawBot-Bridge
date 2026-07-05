# WeClawBot Bridge

微信 ↔ AI Agent 桥接网关 — 单 Bot 多 Agent 命令切换，支持 HTTP / CLI 双模式，自带 Vue 3 管理面板。

## ✨ 功能特性

- **多 Agent 切换**：微信中发 `#命令` 随时切换不同 AI，各自独立维护对话历史，切换不清空上下文
- **OpenAI 兼容**：HTTP Agent 支持 OpenAI 格式（填 base URL 即可），自动补全 `/chat/completions`，支持流式 SSE 输出
- **Vision 支持**：可将微信图片以 base64 `image_url` 方式传给支持视觉的模型
- **CLI Agent**：将本地命令行工具（如 `claude`、Python 脚本）直接接入微信，支持持久会话与哨兵结束符
- **会话管理**：自动维护每用户 × 每 Agent 的对话历史，可配置最大轮次和过期时间；Web 面板支持查看/删除/清空会话，默认永不过期
- **自动刷新二维码**：微信登录二维码过期后自动重新获取，管理面板实时显示刷新状态
- **Webhook**：外部程序（GitHub Actions 等）无需 userId，Bot 在线即可推送消息到微信
- **通知系统**：管理面板一键发送通知，支持文本 / 文件 / 带注释文件
- **详细错误提示**：HTTP 404/401/429/5xx/超时分别返回具体原因，不再笼统报「服务繁忙」
- **管理面板**：Vue 3 + Naive UI 现代化 SPA，深色主题，响应式布局，移动端友好；内置完整 API 参考文档
- **安全认证**：管理面板密码登录保护，支持修改密码；API 路由 CSRF 防护
- **可观测性**：Pino 结构化日志 + Prometheus `/api/metrics` 指标暴露

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
# 编辑 .env，按需修改端口和密钥
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

启动后访问 `http://localhost:3000` 进入管理面板，首次访问需设置管理密码。

### 4. 登录微信 Bot

管理面板 → **Bot 控制** 页面，点击「手动刷新二维码」，用微信扫码登录。二维码过期后会自动刷新。

### 5. 添加 Agent

管理面板 → **Agent 管理** → 填写配置后点「添加 Agent」：

**HTTP Agent（OpenAI 格式）示例：**

| 字段 | 值 |
|------|----|
| 命令 | `gpt` |
| 类型 | http |
| 请求格式 | openai |
| 端点 URL | `https://api.openai.com/v1` |
| API Key | `sk-...` |
| 模型 | `gpt-4o` |

**CLI Agent 示例：**

| 字段 | 值 |
|------|----|
| 命令 | `claude` |
| 类型 | cli |
| CLI 命令 | `claude` |
| 模式 | persistent |

### 6. 微信中使用

| 命令 | 功能 |
|------|------|
| `#help` | 显示帮助 |
| `#agents` | 列出所有 Agent |
| `#status` | 查看 Bot 状态 |
| `#<命令>` | 切换到对应 Agent（会话历史保留） |
| 直接发消息 | 与当前 Agent 对话 |

## 🐳 Docker 部署

```bash
# 构建镜像（多阶段：前端 + 后端）
docker build -t weclawbot-bridge .

# 运行
docker run -d \
  -p 3000:3000 \
  -v weclawbot-data:/app/.wechatbot-gateway \
  -e API_KEY=your-password \
  -e ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  --name weclawbot \
  weclawbot-bridge
```

访问 `http://localhost:3000` 进入管理面板。

## 🖥️ 管理面板

基于 Vue 3 + Vite + Naive UI 的现代化 SPA，深色主题，响应式布局：

| 页面 | 功能 |
|------|------|
| Agent 管理 | 添加/编辑/删除 Agent，在线测试 |
| Bot 控制 | 查看在线状态、扫码登录、刷新二维码 |
| 通知管理 | 一键发送通知消息 |
| 会话管理 | 查看所有会话列表与对话详情，配置过期时间，删除/清空会话 |
| 设置 | 修改管理密码、深色/浅色主题切换 |
| API 参考 | 完整接口文档与示例 |

## 🔧 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `API_KEY` | 管理面板密码 | 首次访问时设置 |
| `ENCRYPTION_KEY` | 凭证加密密钥（32 字节十六进制） | 无 |
| `STORAGE_DIR` | 数据存储目录 | `.wechatbot-gateway` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `SESSION_MAX_ROUNDS` | 会话最大轮次，`0` = 不限制 | `0` |
| `SESSION_EXPIRE_MS` | 会话过期时间（毫秒），`0` = 永不过期 | `0` |
| `ALLOWED_ORIGINS` | CORS 允许的源（逗号分隔） | `http://localhost:3000` |

## 📡 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/metrics` | Prometheus 指标 |
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
| GET | `/api/sessions` | 列出所有会话 |
| GET | `/api/sessions/detail` | 查看会话详情（含对话历史） |
| DELETE | `/api/sessions/clear` | 删除指定会话或清空全部 |
| GET | `/api/sessions/config` | 获取会话配置 |
| PUT | `/api/sessions/config` | 更新会话配置（轮次/过期时间） |
| POST | `/api/notify` | 发送通知消息 |
| POST | `/api/webhook` | Webhook 推送（userId 可选） |

### Webhook 使用示例

```bash
# 无需 userId，Bot 在线即可发送
curl -X POST https://your-domain/api/webhook \
  -H "Content-Type: application/json" \
  -d '{"content":{"text":"部署完成 ✅"}}'

# 指定接收人
curl -X POST https://your-domain/api/webhook \
  -H "Content-Type: application/json" \
  -d '{"userId": "wxid_xxx", "content":{"text":"部署完成 ✅"}}'
```

### GitHub Actions 集成

在仓库 Secrets 中添加 `WECLAW_WEBHOOK_URL` 指向你的 webhook 地址：

```yaml
- name: 微信通知
  run: |
    curl -s -X POST ${{ secrets.WECLAW_WEBHOOK_URL }} \
      -H "Content-Type: application/json" \
      -d "{\"content\":{\"text\":\"✅ [${{ github.repository }}] 部署成功\"}}"
```

## 💬 会话管理

会话按「用户 × Agent」独立维护，支持在 Web 面板中管理：

- **配置**：设置最大对话轮次和过期时间（可设为永不过期），配置持久化保存
- **列表**：查看所有活跃会话，显示消息数、最后活跃时间、过期状态
- **详情**：查看完整对话历史，区分用户/助手消息及时间戳
- **操作**：逐条删除或一键清空全部会话

默认配置：对话轮次不限制，会话永不过期。

## 🏗️ 项目结构

```
WeClawBot-Bridge/
├── src/                    # 后端源码 (Express + TypeScript)
│   ├── server.ts           # Express 服务器、路由、中间件
│   ├── index.ts            # 入口
│   └── ...
├── frontend/               # 前端源码 (Vue 3 + Vite)
│   ├── src/
│   │   ├── views/          # 页面组件 (Agents, Bot, Notify, Sessions, Settings, ApiRef)
│   │   ├── layouts/        # 布局组件 (AppLayout + 侧边栏)
│   │   ├── components/     # 通用组件 (ApiMethod, ApiParams)
│   │   ├── composables/    # API 层 (axios 封装)
│   │   ├── stores/         # Pinia 状态 (auth, theme)
│   │   ├── router/         # Vue Router (6 页面 + 登录守卫)
│   │   └── App.vue         # 根组件 (Naive UI providers)
│   ├── vite.config.ts      # Vite 配置 (自动导入 Naive UI 组件)
│   └── tsconfig.json
├── public/                 # 前端构建产物 (Vite 输出)
├── config/                 # 默认配置
├── Dockerfile              # 多阶段构建 (前端 + 后端)
└── package.json
```

## 🛠️ 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js 22 · TypeScript · Express · Helmet · Pino · Zod · prom-client |
| 前端 | Vue 3 · Vite · Naive UI · Pinia · Vue Router · unplugin-vue-components |
| 部署 | Docker (多阶段构建) · GitHub Actions CI |

## 📄 License

MIT
