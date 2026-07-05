<template>
  <n-config-provider :theme="theme" :theme-overrides="themeStore.themeOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { darkTheme } from 'naive-ui'
import { useThemeStore } from './stores/theme'

const themeStore = useThemeStore()
const theme = computed(() => themeStore.isDark ? darkTheme : null)
</script>
