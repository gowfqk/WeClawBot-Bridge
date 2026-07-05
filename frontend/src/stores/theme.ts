import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { GlobalThemeOverrides } from 'naive-ui'

export const useThemeStore = defineStore('theme', () => {
  const isDark = ref(localStorage.getItem('theme') === 'dark')

  function toggleTheme() {
    isDark.value = !isDark.value
  }

  watch(isDark, (val) => {
    localStorage.setItem('theme', val ? 'dark' : 'light')
  })

  // Naive UI 主题覆盖
  const themeOverrides = ref<GlobalThemeOverrides>({
    common: {
      primaryColor: '#6366f1',
      primaryColorHover: '#4f46e5',
      primaryColorPressed: '#4338ca',
      borderRadius: '8px',
    },
  })

  return { isDark, toggleTheme, themeOverrides }
})
