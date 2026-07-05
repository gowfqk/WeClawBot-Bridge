<template>
  <div class="api-method">
    <n-tag :type="methodColor" size="small" round :bordered="false">{{ method }}</n-tag>
    <code class="api-path">{{ path }}</code>
    <span v-if="desc" class="api-desc">{{ desc }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  desc?: string
}>()

const methodColorMap: Record<string, 'success' | 'info' | 'warning' | 'error' | 'default'> = {
  GET: 'success',
  POST: 'info',
  PUT: 'warning',
  DELETE: 'error',
}

const methodColor = computed(() => methodColorMap[props.method] || 'default')
</script>

<style scoped>
.api-method {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  margin-bottom: 4px;
}
.api-path {
  font-size: 13px;
  font-family: monospace;
}
.api-desc {
  font-size: 12px;
  color: var(--n-text-color-3);
  margin-left: 8px;
}
</style>
