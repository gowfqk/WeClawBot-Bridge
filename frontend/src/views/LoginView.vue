<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">🤖</div>
      <h2 class="login-title">{{ isSetup ? '首次设置' : '管理面板登录' }}</h2>

      <!-- 登录表单 -->
      <n-form v-if="!isSetup" ref="loginFormRef" :model="loginForm" :rules="loginRules">
        <n-form-item path="password" label="管理密码">
          <n-input
            v-model:value="loginForm.password"
            type="password"
            show-password-on="click"
            placeholder="请输入管理密码"
            @keydown.enter="handleLogin"
          />
        </n-form-item>
        <n-button type="primary" block :loading="authStore.loading" @click="handleLogin">
          登 录
        </n-button>
      </n-form>

      <!-- 首次设置密码 -->
      <n-form v-else ref="setupFormRef" :model="setupForm" :rules="setupRules">
        <n-form-item path="password" label="设置管理密码">
          <n-input
            v-model:value="setupForm.password"
            type="password"
            show-password-on="click"
            placeholder="至少8位字符"
          />
        </n-form-item>
        <n-form-item path="password2" label="确认密码">
          <n-input
            v-model:value="setupForm.password2"
            type="password"
            show-password-on="click"
            placeholder="再次输入密码"
            @keydown.enter="handleSetup"
          />
        </n-form-item>
        <n-button type="primary" block :loading="authStore.loading" @click="handleSetup">
          设置密码并登录
        </n-button>
      </n-form>

      <p class="login-hint">
        {{ isSetup ? '首次使用，请设置管理面板的访问密码' : '输入管理密码以访问控制面板' }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useAuthStore } from '../stores/auth'
import type { FormInst, FormRules } from 'naive-ui'

const router = useRouter()
const message = useMessage()
const authStore = useAuthStore()

const isSetup = ref(false)
const loginFormRef = ref<FormInst | null>(null)
const setupFormRef = ref<FormInst | null>(null)

const loginForm = ref({ password: '' })
const setupForm = ref({ password: '', password2: '' })

const loginRules: FormRules = {
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

const setupRules: FormRules = {
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 8, message: '密码至少8位', trigger: 'blur' },
  ],
  password2: [
    { required: true, message: '请确认密码', trigger: 'blur' },
    {
      validator: (_rule, value) => value === setupForm.value.password,
      message: '两次输入的密码不一致',
      trigger: 'blur',
    },
  ],
}

async function handleLogin() {
  try {
    await loginFormRef.value?.validate()
  } catch { return }
  try {
    await authStore.login(loginForm.value.password)
    message.success('登录成功')
    router.push('/agents')
  } catch (e: any) {
    message.error(e.message || '登录失败')
  }
}

async function handleSetup() {
  try {
    await setupFormRef.value?.validate()
  } catch { return }
  try {
    await authStore.setup(setupForm.value.password)
    message.success('密码设置成功')
    router.push('/agents')
  } catch (e: any) {
    message.error(e.message || '设置失败')
  }
}

onMounted(async () => {
  await authStore.checkStatus()
  if (authStore.isLoggedIn) {
    router.push('/agents')
    return
  }
  isSetup.value = authStore.needsSetup
})
</script>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--n-color);
}
.login-card {
  width: 400px;
  max-width: 90vw;
  padding: 40px 32px;
  border-radius: 12px;
  background: var(--n-card-color);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}
.login-logo {
  font-size: 48px;
  text-align: center;
  margin-bottom: 8px;
}
.login-title {
  text-align: center;
  margin-bottom: 24px;
  font-size: 20px;
}
.login-hint {
  text-align: center;
  margin-top: 16px;
  font-size: 13px;
  color: var(--n-text-color-3);
}
</style>
