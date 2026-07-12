<template>
  <div>
    <n-grid :cols="1" :y-gap="20">
      <!-- 修改密码 -->
      <n-gi>
        <n-card title="修改管理密码">
          <n-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-placement="left" label-width="120">
            <n-form-item label="当前密码" path="oldPassword">
              <n-input v-model:value="pwdForm.oldPassword" type="password" show-password-on="click" placeholder="输入当前密码" />
            </n-form-item>
            <n-form-item label="新密码" path="newPassword">
              <n-input v-model:value="pwdForm.newPassword" type="password" show-password-on="click" placeholder="至少8位字符" />
            </n-form-item>
            <n-form-item label="确认新密码" path="newPassword2">
              <n-input v-model:value="pwdForm.newPassword2" type="password" show-password-on="click" placeholder="再次输入新密码" />
            </n-form-item>
            <n-button type="primary" :loading="changingPwd" @click="handleChangePassword">
              修改密码
            </n-button>
          </n-form>
        </n-card>
      </n-gi>

      <!-- 配置备份 -->
      <n-gi>
        <n-card title="配置备份">
          <n-space vertical>
            <n-text depth="3" style="font-size: 13px">
              导出完整 Agent 配置、会话策略和通知规则为易读 JSON 文件；不会导出会话记录、通知日志或管理密码。
            </n-text>
            <n-space>
              <n-button type="primary" :loading="exporting" @click="handleExport">
                📥 导出配置
              </n-button>
              <n-button @click="triggerImport">
                📤 导入配置
              </n-button>
              <input
                ref="fileInputRef"
                type="file"
                accept=".json"
                style="display: none"
                @change="handleImport"
              />
            </n-space>
          </n-space>
        </n-card>
      </n-gi>

      <!-- 系统信息 -->
      <n-gi>
        <n-card title="系统信息">
          <n-descriptions bordered :column="1">
            <n-descriptions-item label="应用名称">WeClawBot Bridge</n-descriptions-item>
            <n-descriptions-item label="描述">微信 ↔ OpenClaw AI Agent 桥接网关</n-descriptions-item>
            <n-descriptions-item label="版本">1.0.0</n-descriptions-item>
          </n-descriptions>
        </n-card>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMessage, useDialog } from 'naive-ui'
import { useAuthStore } from '../stores/auth'
import { api } from '../composables/api'
import type { FormInst, FormRules } from 'naive-ui'

const message = useMessage()
const dialog = useDialog()
const authStore = useAuthStore()

const pwdFormRef = ref<FormInst | null>(null)
const changingPwd = ref(false)
const exporting = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)

const pwdForm = ref({
  oldPassword: '',
  newPassword: '',
  newPassword2: '',
})

const pwdRules: FormRules = {
  oldPassword: { required: true, message: '请输入当前密码', trigger: 'blur' },
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 8, message: '新密码至少8位', trigger: 'blur' },
  ],
  newPassword2: [
    { required: true, message: '请确认新密码', trigger: 'blur' },
    {
      validator: (_rule, value) => value === pwdForm.value.newPassword,
      message: '两次输入的新密码不一致',
      trigger: 'blur',
    },
  ],
}

async function handleChangePassword() {
  try {
    await pwdFormRef.value?.validate()
  } catch { return }

  changingPwd.value = true
  try {
    await authStore.changePassword(pwdForm.value.oldPassword, pwdForm.value.newPassword)
    message.success('密码修改成功')
    pwdForm.value = { oldPassword: '', newPassword: '', newPassword2: '' }
  } catch (e: any) {
    message.error(e.message)
  } finally {
    changingPwd.value = false
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const blob = await api.download('/api/config/export')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'weclawbot-config.json'
    a.click()
    URL.revokeObjectURL(url)
    message.success('配置已导出')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    exporting.value = false
  }
}

function triggerImport() {
  fileInputRef.value?.click()
}

async function handleImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  dialog.warning({
    title: '确认导入',
    content: '导入配置将覆盖当前所有设置并恢复备份数据，是否继续？',
    positiveText: '继续导入',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const text = await file.text()
        const backup = JSON.parse(text)
        const result = (await api.uploadJson('/api/config/import', backup)) as Record<string, number | boolean>

        const parts: string[] = []
        if (result.agents) parts.push(`${result.agents} 个 Agent`)
        if (result.session) parts.push('会话配置')
        if (result.notifications) parts.push(`${result.notifications} 条通知规则`)
        if (result.storageKeys) parts.push(`${result.storageKeys} 条存储数据`)
        message.success(`导入成功：${parts.join('、')}`)
      } catch (e: any) {
        message.error(e.message)
      } finally {
        input.value = ''
      }
    },
    onNegativeClick: () => {
      input.value = ''
    },
  })
}
</script>
