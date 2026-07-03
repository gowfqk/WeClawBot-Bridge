# WeClawBot Bridge

微信 ↔ OpenClaw AI Agent 桥接网关 — 单 Bot 多 Agent 命令切换。

## 功能特性

- **多 Agent 支持**：通过 `/命令` 在微信中切换不同 AI Agent
- **HTTP & CLI Agent**：支持 HTTP API 类型和 CLI 命令行类型的 Agent
- **会话管理**：自动维护每个用户与每个 Agent 的对话历史
- **通知系统**：支持通过 API 发送通知消息到微信
- **Webhook**：支持外部程序通过 Webhook 推送消息
- **管理面板**：Web UI 管理 Agent、查看 Bot 状态、发送通知
- **安全认证**：管理面板支持密码登录保护

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

```bash
# 复制示例配置
cp .env.example .env
cp config/agents.example.json config/agents.json

# 编辑 config/agents.json，填入你的 Agent 配置
# 编辑 .env，设置端口和密码等
```

### 3. 编译 & 启动

```bash
npm run build
npm start
```

启动后访问 `http://localhost:3000` 查看首页，`http://localhost:3000/admin.html` 进入管理面板。

首次访问管理面板时需要设置管理密码。

### 4. 微信使用

在微信中向 Bot 发送消息：

| 命令 | 功能 |
|------|------|
| `/help` | 显示帮助 |
| `/agents` | 列出所有 Agent |
| `/status` | 查看 Bot 状态 |
| `/openclaw` | 切换到 OpenClaw Agent |
| 直接发消息 | 与当前 Agent 对话 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3000 |
| `API_KEY` | 管理面板密码 | 首次访问时设置 |
| `ENCRYPTION_KEY` | 凭证加密密钥（32字节十六进制） | 无 |
| `STORAGE_DIR` | 数据存储目录 | .wechatbot-gateway |
| `LOG_LEVEL` | 日志级别 | info |
| `SESSION_MAX_ROUNDS` | 会话最大轮次 | 10 |
| `SESSION_EXPIRE_MS` | 会话过期时间（毫秒） | 1800000 |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/metrics` | Prometheus 指标 |
| POST | `/api/auth/login` | 管理面板登录 |
| GET | `/api/auth/status` | 检查登录状态 |
| POST | `/api/auth/setup` | 首次设置密码 |
| POST | `/api/auth/change-password` | 修改管理密码 |
| POST | `/api/bot/login` | 获取 Bot 登录二维码 |
| GET | `/api/bot/status` | Bot 在线状态 |
| GET | `/api/agents` | 列出所有 Agent |
| POST | `/api/agents` | 注册新 Agent |
| PUT | `/api/agents/:id` | 更新 Agent |
| DELETE | `/api/agents/:id` | 删除 Agent |
| POST | `/api/agents/:id/test` | 测试 Agent 调用 |
| POST | `/api/notify` | 发送通知 |
| POST | `/api/webhook` | Webhook 通知 |

## 技术栈

- Node.js + TypeScript
- Express.js
- Helmet (CSP / 安全头)
- Pino (日志)
- Zod (配置校验)

## License

MIT
