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
          <!-- 功能概览 -->
          <n-card id="doc-overview" title="功能概览">
            <n-text>WeClawBot Bridge 是微信 ↔ AI Agent 桥接网关，提供以下核心功能：</n-text>
            <n-ul style="margin-top: 12px">
              <n-li>微信 Bot 登录与消息收发</n-li>
              <n-li>AI Agent 注册、调度与测试</n-li>
              <n-li>会话管理与上下文保持</n-li>
              <n-li>定时/事件通知推送</n-li>
              <n-li>配置备份与恢复</n-li>
            </n-ul>
          </n-card>

          <!-- 认证 -->
          <n-card id="doc-auth" title="认证">
            <n-text>所有管理 API 需要通过 Bearer Token 认证。首次使用需设置管理密码。</n-text>
            <api-method method="POST" path="/api/auth/login" desc="登录管理面板" />
            <api-params :params="authLoginParams" />
            <api-method method="GET" path="/api/auth/status" desc="查询认证状态" />
            <api-method method="POST" path="/api/auth/setup" desc="首次设置密码" />
            <api-params :params="authSetupParams" />
            <api-method method="POST" path="/api/auth/change-password" desc="修改密码" />
            <api-params :params="authChangeParams" />
            <api-method method="POST" path="/api/auth/logout" desc="退出登录" />
          </n-card>

          <!-- Agent 管理 -->
          <n-card id="doc-agents" title="Agent 管理">
            <api-method method="GET" path="/api/agents" desc="获取所有 Agent 列表" />
            <api-method method="POST" path="/api/agents" desc="注册新 Agent" />
            <api-method method="PUT" path="/api/agents/:id" desc="更新 Agent 配置" />
            <api-method method="DELETE" path="/api/agents/:id" desc="删除 Agent" />
            <api-method method="POST" path="/api/agents/:id/test" desc="测试 Agent 响应" />
            <api-params :params="[{ name: 'text', type: 'string', required: true, desc: '测试消息文本' }]" />
          </n-card>

          <!-- Bot 控制 -->
          <n-card id="doc-bot" title="Bot 控制">
            <api-method method="GET" path="/api/bot/status" desc="获取 Bot 在线状态" />
            <api-method method="POST" path="/api/bot/login" desc="触发微信扫码登录" />
            <n-text depth="3" style="font-size: 13px; display: block; margin-top: 8px">
              登录后返回 qrUrl，前端可生成二维码供用户扫描。
            </n-text>
          </n-card>

          <!-- 通知 -->
          <n-card id="doc-notify" title="通知管理">
            <api-method method="POST" path="/api/notify" desc="发送通知" />
            <api-params :params="[{ name: 'content', type: 'object', required: true, desc: '通知内容 { text: string }' }]" />
            <api-method method="POST" path="/api/notify/rules" desc="添加通知规则" />
            <api-method method="DELETE" path="/api/notify/rules/:id" desc="删除通知规则" />
            <api-method method="GET" path="/api/notify/log" desc="获取通知日志" />
            <api-method method="POST" path="/api/webhook" desc="Webhook 发送通知" />
          </n-card>

          <!-- 会话 -->
          <n-card id="doc-sessions" title="会话管理">
            <api-method method="GET" path="/api/sessions" desc="获取会话列表" />
            <api-method method="GET" path="/api/sessions/detail" desc="获取会话详情" />
            <api-params :params="sessionDetailParams" />
            <api-method method="DELETE" path="/api/sessions/clear" desc="清空会话" />
            <api-method method="GET" path="/api/sessions/config" desc="获取会话配置" />
            <api-method method="PUT" path="/api/sessions/config" desc="更新会话配置" />
          </n-card>

          <!-- 配置 -->
          <n-card id="doc-config" title="配置管理">
            <api-method method="GET" path="/api/config" desc="获取配置状态" />
            <api-method method="GET" path="/api/config/export" desc="导出配置备份（JSON）" />
            <api-method method="POST" path="/api/config/import" desc="导入配置备份" />
          </n-card>

          <!-- 监控 -->
          <n-card id="doc-monitor" title="监控">
            <api-method method="GET" path="/api/health" desc="健康检查" />
            <api-method method="GET" path="/api/metrics" desc="Prometheus 格式指标" />
          </n-card>
        </n-space>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MenuOption } from 'naive-ui'
import ApiMethod from '../components/ApiMethod.vue'
import ApiParams from '../components/ApiParams.vue'

const activeSection = ref('doc-overview')

const tocMenuOptions: MenuOption[] = [
  { label: '功能概览', key: 'doc-overview' },
  { label: '认证', key: 'doc-auth' },
  { label: 'Agent 管理', key: 'doc-agents' },
  { label: 'Bot 控制', key: 'doc-bot' },
  { label: '通知管理', key: 'doc-notify' },
  { label: '会话管理', key: 'doc-sessions' },
  { label: '配置管理', key: 'doc-config' },
  { label: '监控', key: 'doc-monitor' },
]

function scrollToSection(key: string) {
  activeSection.value = key
  const el = document.getElementById(key)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// 参数定义
const authLoginParams = [{ name: 'password', type: 'string', required: true, desc: '管理密码' }]
const authSetupParams = [{ name: 'password', type: 'string', required: true, desc: '管理密码（≥4位）' }]
const authChangeParams = [
  { name: 'oldPassword', type: 'string', required: true, desc: '当前密码' },
  { name: 'newPassword', type: 'string', required: true, desc: '新密码（≥4位）' },
]
const sessionDetailParams = [
  { name: 'userId', type: 'string', required: true, desc: '用户 ID（query）' },
  { name: 'agentId', type: 'string', required: true, desc: 'Agent ID（query）' },
]
</script>
