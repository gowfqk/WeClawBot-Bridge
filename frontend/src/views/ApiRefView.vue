<template>
  <div>
    <n-grid :cols="24" :x-gap="20">
      <!-- 左侧目录 -->
      <n-gi :span="6">
        <n-card title="目录" size="small" style="position: sticky; top: 0">
          <n-menu :options="tocMenuOptions" :value="activeSection" @update:value="scrollToSection" />
        </n-card>
      </n-gi>

      <!-- 右侧文档 -->
      <n-gi :span="18">
        <n-space vertical :size="24">
          <!-- 快速上手 -->
          <n-card id="doc-quickstart" title="🚀 快速上手">
            <n-text>三步开始用 WeClawBot 和微信里的 AI 对话：</n-text>
            <n-ol style="margin-top: 16px">
              <n-li>
                <n-text strong>登录微信</n-text> — 进入 <n-text code>Bot 控制</n-text> 页面，点击「刷新二维码」，用微信扫码登录。
              </n-li>
              <n-li>
                <n-text strong>添加 Agent</n-text> — 进入 <n-text code>Agent 管理</n-text> 页面，添加你的 AI 服务（支持 OpenAI 格式、CLI 工具、WS 插件接入）。
              </n-li>
              <n-li>
                <n-text strong>微信对话</n-text> — 在微信中发 <n-text code>#命令</n-text> 切换 Agent，之后直接发消息即可对话。
              </n-li>
            </n-ol>
          </n-card>

          <!-- 微信命令 -->
          <n-card id="doc-commands" title="💬 微信命令">
            <n-text>在微信中发送以下命令控制 Bot：</n-text>
            <n-table :bordered="false" :single-line="false" style="margin-top: 12px">
              <thead>
                <tr><th>命令</th><th>说明</th><th>示例</th></tr>
              </thead>
              <tbody>
                <tr><td><n-text code>#help</n-text></td><td>显示帮助信息</td><td>#help</td></tr>
                <tr><td><n-text code>#agents</n-text></td><td>列出所有可用 Agent</td><td>#agents</td></tr>
                <tr><td><n-text code>#status</n-text></td><td>查看所有 Agent 在线状态</td><td>#status</td></tr>
                <tr><td><n-text code>#命令</n-text></td><td>切换到指定 Agent</td><td>#hermes</td></tr>
                <tr><td><n-text code>#clear</n-text></td><td>清空当前会话历史</td><td>#clear</td></tr>
                <tr><td>直接发消息</td><td>与当前 Agent 对话</td><td>你好</td></tr>
              </tbody>
            </n-table>
            <n-text depth="3" style="display: block; margin-top: 12px">
              💡 切换 Agent 不会清空对话历史，每个 Agent 独立维护上下文。
            </n-text>
          </n-card>

          <!-- Agent 类型 -->
          <n-card id="doc-agent-types" title="🤖 Agent 类型">
            <n-tabs type="line">
              <n-tab-pane name="http" tab="HTTP (OpenAI)">
                <n-text>最常用的方式，兼容所有 OpenAI 格式的 API：</n-text>
                <n-table :bordered="false" :single-line="false" style="margin-top: 12px">
                  <thead><tr><th>字段</th><th>说明</th><th>示例</th></tr></thead>
                  <tbody>
                    <tr><td>命令</td><td>微信切换关键词</td><td>gpt</td></tr>
                    <tr><td>类型</td><td>HTTP</td><td>http</td></tr>
                    <tr><td>请求格式</td><td>OpenAI 兼容</td><td>openai</td></tr>
                    <tr><td>端点 URL</td><td>API 地址（自动补 /chat/completions）</td><td>https://api.openai.com/v1</td></tr>
                    <tr><td>API Key</td><td>认证密钥</td><td>sk-...</td></tr>
                    <tr><td>模型</td><td>模型名称</td><td>gpt-4o</td></tr>
                  </tbody>
                </n-table>
                <n-text depth="3" style="display: block; margin-top: 8px">
                  支持流式 SSE 输出，支持 Vision（微信图片自动转 base64 image_url）。
                </n-text>
              </n-tab-pane>

              <n-tab-pane name="cli" tab="CLI 命令行">
                <n-text>将本地命令行工具直接接入微信：</n-text>
                <n-table :bordered="false" :single-line="false" style="margin-top: 12px">
                  <thead><tr><th>字段</th><th>说明</th><th>示例</th></tr></thead>
                  <tbody>
                    <tr><td>命令</td><td>微信切换关键词</td><td>claude</td></tr>
                    <tr><td>类型</td><td>CLI</td><td>cli</td></tr>
                    <tr><td>CLI 命令</td><td>可执行命令</td><td>claude</td></tr>
                    <tr><td>模式</td><td>persistent（持久会话）/ oneshot</td><td>persistent</td></tr>
                  </tbody>
                </n-table>
              </n-tab-pane>

              <n-tab-pane name="ws-remote" tab="WS Remote 插件接入">
                <n-text>可使用 Hermes、OpenClaw、QwenPaw 的专用 Channel 插件，或使用通用 SDK 接入 Claude Code、OpenCode、Codex CLI；它们都会主动连接 Bridge，无需暴露 Agent 的 HTTP 服务：</n-text>
                <n-ol style="margin-top: 12px">
                  <n-li>
                    <n-text strong>添加 Agent</n-text> — 类型选 <n-text code>WS Remote (插件接入)</n-text>，填写 ID、名称和切换命令。
                  </n-li>
                  <n-li>
                    <n-text strong>选择接入方式</n-text> — 在表单或列表的「Token」弹窗中选择 <n-text code>Hermes</n-text>、<n-text code>OpenClaw</n-text>、<n-text code>QwenPaw</n-text>，或 <n-text code>Claude Code</n-text>、<n-text code>OpenCode</n-text>、<n-text code>Codex CLI</n-text>。
                  </n-li>
                  <n-li>
                    <n-text strong>生成 Token 并安装</n-text> — 点击「生成 Token」，复制当前接入方式对应的安装命令；命令会自动带入 Bridge 地址、Agent ID 和 Token。
                  </n-li>
                  <n-li>
                    <n-text strong>重启 Agent 服务</n-text> — 连接成功后，Agent 管理列表会显示「在线」。
                  </n-li>
                </n-ol>
                <n-text depth="3" style="display: block; margin-top: 8px">
                  一个 Bridge 可并行接入多个实例；每个实例必须使用独立的 Agent ID 与 Token。离线时消息会提示「不在线」，插件重连后自动恢复。
                </n-text>
              </n-tab-pane>
            </n-tabs>
          </n-card>

          <!-- OpenAI 兼容 API -->
          <n-card id="doc-openai" title="🔗 OpenAI 兼容 API">
            <n-text>可将 Bridge 作为 OpenAI 兼容服务接入任意支持 Chat Completions 的客户端。请求中的 <n-text code>model</n-text> 是管理面板配置的 <n-text strong>Agent ID</n-text>，用于选择目标 Agent，而非底层模型名。</n-text>
            <n-ul style="margin-top: 12px">
              <n-li><n-text code>GET /v1/models</n-text> — 列出可用 Agent ID。</n-li>
              <n-li><n-text code>POST /v1/chat/completions</n-text> — 通过 <n-text code>model</n-text> 调用指定 HTTP、CLI 或 WS Remote Agent。</n-li>
              <n-li>使用 Bridge 的 <n-text code>API_KEY</n-text> 或管理密码作为 <n-text code>Authorization: Bearer</n-text>；不要使用管理面板登录会话 Token。</n-li>
            </n-ul>
            <n-code language="bash" :code="openAiExample" word-break style="display: block; margin-top: 12px" />
            <n-text depth="3" style="display: block; margin-top: 8px">
              当前为无状态接口：每次请求需传完整 <n-text code>messages</n-text>，Bridge 不保存 OpenAI API 对话历史；仅支持文本 <n-text code>user</n-text> / <n-text code>assistant</n-text> 消息。<n-text code>stream: true</n-text> 返回 SSE 单块完成响应，非逐 token 流。可选 <n-text code>user</n-text> 仅作为传给 Agent 的匿名调用方标识。
            </n-text>
          </n-card>

          <!-- 会话管理 -->
          <n-card id="doc-sessions" title="📝 会话管理">
            <n-text>单用户模式下，每个 Agent 独立维护对话历史：</n-text>
            <n-ul style="margin-top: 12px">
              <n-li>切换 Agent 不清空上下文，回到之前的 Agent 继续对话</n-li>
              <n-li>会话管理页面可查看所有会话列表与完整对话详情</n-li>
              <n-li>支持设置最大对话轮次和过期时间（默认永不过期）</n-li>
              <n-li>支持逐条删除或一键清空会话</n-li>
            </n-ul>
          </n-card>

          <!-- 通知推送 -->
          <n-card id="doc-notify" title="📢 通知与 Webhook">
            <n-text>两种方式向微信推送消息：</n-text>
            <n-h4 style="margin: 12px 0 4px">管理面板通知</n-h4>
            <n-text depth="3">通知管理页面 → 输入内容 → 发送，支持文本和 Markdown 格式。</n-text>
            <n-h4 style="margin: 12px 0 4px">Webhook（CI/CD 集成）</n-h4>
            <n-text depth="3" style="font-size: 13px; display: block">
              curl -X POST https://your-domain/api/webhook \\<br>
              &nbsp;&nbsp;-H "Content-Type: application/json" \\<br>
              &nbsp;&nbsp;-H "X-Webhook-Secret: your-secret" \\<br>
              &nbsp;&nbsp;-d '{"content":{"text":"部署完成 ✅"}}'
            </n-text>
            <n-text depth="3" style="display: block; margin-top: 8px">
              无需 userId，Bot 在线即可推送。适合 GitHub Actions、定时任务等场景。
            </n-text>
          </n-card>

          <!-- WS Agent 状态 -->
          <n-card id="doc-ws-status" title="🔌 WS Agent 在线状态">
            <n-text>WS Remote 类型的 Agent 在 Agent 管理列表中显示在线状态：</n-text>
            <n-ul style="margin-top: 12px">
              <n-li><n-text type="success">在线</n-text> — 插件已连接，消息正常路由</n-li>
              <n-li><n-text type="error">离线</n-text> — 插件未连接，发消息会提示"不在线"</n-li>
            </n-ul>
            <n-text depth="3" style="display: block; margin-top: 8px">
              Agent 配置持久保留，离线不会丢失。插件重连后自动恢复在线。
            </n-text>
          </n-card>

          <!-- 配置备份 -->
          <n-card id="doc-backup" title="💾 配置备份">
            <n-text>设置页面支持导出/导入完整配置（JSON），包含：</n-text>
            <n-ul style="margin-top: 12px">
              <n-li>所有 Agent 配置（含 API Key）</n-li>
              <n-li>会话配置（轮次限制、过期时间）</n-li>
              <n-li>WS Agent Token</n-li>
              <n-li>存储数据</n-li>
            </n-ul>
            <n-text depth="3" style="display: block; margin-top: 8px">
              适合迁移、备份或恢复场景。
            </n-text>
          </n-card>

          <!-- 常见问题 -->
          <n-card id="doc-faq" title="❓ 常见问题">
            <n-collapse>
              <n-collapse-item title="微信二维码过期了怎么办？" name="qr">
                管理面板会自动刷新二维码，无需手动操作。如果长时间未扫码，点击「刷新二维码」重新获取。
              </n-collapse-item>
              <n-collapse-item title="为什么 Agent 回复「服务繁忙」？" name="busy">
                可能原因：API Key 无效、端点 URL 错误、模型名不对、后端服务不可达。
                在 Agent 管理页面点击「测试」按钮，查看具体错误信息。
              </n-collapse-item>
              <n-collapse-item title="WS Agent 显示离线？" name="offline">
                插件进程未运行或网络不通。检查插件端是否已 connect()，确认 Bridge 地址可达。
                插件会自动重连（指数退避），通常网络恢复后几秒内重新上线。
              </n-collapse-item>
              <n-collapse-item title="多个微信号发消息会怎样？" name="multi">
                当前设计是单用户模式：所有微信入口共享当前 Agent 和会话历史。真实微信用户 ID 只用于回复当前消息，
                不再为不同发送者维护独立上下文。
              </n-collapse-item>
              <n-collapse-item title="对话历史会占很多内存吗？" name="memory">
                可在会话管理页面设置最大轮次和过期时间。默认不限制轮次、永不过期。
                对于高流量场景，建议设置轮次上限（如 20 轮）。
              </n-collapse-item>
            </n-collapse>
          </n-card>
        </n-space>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MenuOption } from 'naive-ui'

const activeSection = ref('doc-quickstart')

const openAiExample = `curl https://your-domain/v1/chat/completions \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "hermes",
    "messages": [{"role": "user", "content": "你好"}]
  }'`

const tocMenuOptions: MenuOption[] = [
  { label: '🚀 快速上手', key: 'doc-quickstart' },
  { label: '💬 微信命令', key: 'doc-commands' },
  { label: '🤖 Agent 类型', key: 'doc-agent-types' },
  { label: '🔗 OpenAI 兼容 API', key: 'doc-openai' },
  { label: '📝 会话管理', key: 'doc-sessions' },
  { label: '📢 通知与 Webhook', key: 'doc-notify' },
  { label: '🔌 WS Agent 状态', key: 'doc-ws-status' },
  { label: '💾 配置备份', key: 'doc-backup' },
  { label: '❓ 常见问题', key: 'doc-faq' },
]

function scrollToSection(key: string) {
  activeSection.value = key
  const el = document.getElementById(key)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>
