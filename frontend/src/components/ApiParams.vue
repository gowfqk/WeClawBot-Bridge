<template>
  <n-table v-if="params.length" :bordered="false" :single-line="false" size="small" :data="params" :columns="columns" />
</template>

<script setup lang="ts">
import { h } from 'vue'
import type { DataTableColumns } from 'naive-ui'

interface Param {
  name: string
  type: string
  required: boolean
  desc: string
}

defineProps<{ params: Param[] }>()

const columns: DataTableColumns<Param> = [
  { title: '参数', key: 'name', width: 120, render: (row) => h('code', { style: 'font-size:12px' }, row.name) },
  { title: '类型', key: 'type', width: 80 },
  { title: '必填', key: 'required', width: 50, render: (row) => row.required ? '是' : '否' },
  { title: '说明', key: 'desc' },
]
</script>
