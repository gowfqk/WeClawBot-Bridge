# WeClawBot Bridge

微信 ↔ AI Agent 桥接网关 — 单 Bot 多 Agent 命令切换，支持 HTTP / CLI 双模式，自带 Web 管理面板。

## 功能特性

- **多 Agent 切换**：在微信中发 `/命令` 随时切换不同 AI，各自独立维护对话历史，切换不清空上下文
- **OpenAI 兼容**：HTTP Agent 支持 OpenAI 格式（填 base URL 即可），自动补全 `/chat/completions`，支持流式 SSE 输出
- **Vision 支持**：可将微信图片以 base64 `image_url` 方式传给支持视觉的模型
- **CLI Agent**：将本地命令行工具（如 `claude`、Python 脚本）直接接入微信，支持持久会话与哨兵结束符
- **会话管理**：自动维护每用户 × 每 Agent 的对话历史，可配置最大轮次和过期时间；Web 面板支持查看/删除/清空会话，默认永不过期
- **自动刷新二维码**：微信登录二维码过期后自动重新获取，管理面板实时显示刷新状态
- **Webhook**：外部程序（GitHub Actions 等）无需 userId，Bot 在线即可推送消息到微信
- **通知系统**：管理面板一键发送通知，支持文本 / 文件 / 带注释文件
- **详细错误提示**：HTTP 404/401/429/5xx/超时分别返回具体原因，不再笼统报「服务繁忙」
- **管理面板**：响应式 Web UI，支持移动端底部导航栏；内置完整 API 参考文档
- **安全认证**：管理面板密码登录保护，支持修改密码；API 路由 CSRF 防护
- **可观测性**：Pino 结构化日志 + Prometheus `/api/metrics` 指标暴露

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，按需修改端口和密钥
```

### 3. 启动开发服务

```bash
PORT=5000 npm run dev
```

或编译后生产启动：

```bash
npm run build
node dist/index.js
```

启动后访问 `http://localhost:5000/admin.html` 进入管理面板，首次访问需设置管理密码。

### 4. 登录微信 Bot

进入管理面板 → **Bot 控制** 标签页，点击「手动刷新二维码」，用微信扫码登录。二维码过期后会自动刷新。

### 5. 添加 Agent

管理面板 → **Agent 管理** → 填写配置后点「添加 Agent」：

**HTTP Agent（OpenAI 格式）示例：**

| 字段 | 值 |
|------|----|
| 命令 | `gpt` |
| 类型 | http |
| 请求格式 | openai |
| 端点 URL | `https://api.openai.com/v1`（填 base URL） |
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
| `/help` | 显示帮助 |
| `/agents` | 列出所有 Agent |
| `/status` | 查看 Bot 状态 |
| `/<命令>` | 切换到对应 Agent（会话历史保留） |
| 直接发消息 | 与当前 Agent 对话 |

## 管理面板

| 标签页 | 功能 |
|--------|------|
| Agent 管理 | 添加/编辑/删除 Agent，在线测试 |
| Bot 控制 | 查看在线状态、扫码登录、刷新二维码 |
| 通知管理 | 一键发送通知消息 |
| **会话管理** | 查看所有会话列表与对话详情，配置过期时间，删除/清空会话 |
| 设置 | 修改管理密码 |
| API 参考 | 完整接口文档与示例 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `API_KEY` | 管理面板密码 | 首次访问时设置 |
| `ENCRYPTION_KEY` | 凭证加密密钥（32字节十六进制） | 无 |
| `STORAGE_DIR` | 数据存储目录 | `.wechatbot-gateway` |
| `LOG_LEVEL` | 日志级别 | `info` |
| `SESSION_MAX_ROUNDS` | 会话最大轮次 | `10` |
| `SESSION_EXPIRE_MS` | 会话过期时间（毫秒），`0` = 永不过期 | `0` |

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

项目内置 CI workflow（`.github/workflows/ci.yml`），提交到 main 分支时自动构建并推送微信通知。

在仓库 Secrets 中添加 `WECLAW_WEBHOOK_URL` 指向你的 webhook 地址即可启用。

```yaml
# 手动集成示例
- name: 微信通知
  run: |
    curl -s -X POST ${{ secrets.WECLAW_WEBHOOK_URL }} \
      -H "Content-Type: application/json" \
      -d "{\"content\":{\"text\":\"✅ [${{ github.repository }}] 部署成功\"}}"
```

## 会话管理

会话按「用户 × Agent」独立维护，支持在 Web 面板中管理：

- **配置**：设置最大对话轮次和过期时间（可设为永不过期），配置持久化保存
- **列表**：查看所有活跃会话，显示消息数、最后活跃时间、过期状态
- **详情**：查看完整对话历史，区分用户/助手消息及时间戳
- **操作**：逐条删除或一键清空全部会话

默认配置：最大 10 轮对话，永不过期。

## 技术栈

- **运行时**：Node.js 22 + TypeScript
- **框架**：Express.js
- **安全**：Helmet（CSP / 安全头）、CSRF 防护
- **日志**：Pino（结构化 JSON）
- **配置校验**：Zod
- **指标**：prom-client（Prometheus）

## License

MIT
