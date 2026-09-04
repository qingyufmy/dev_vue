<script setup lang="ts">
import { computed } from 'vue'
import { RotateCcw, Search } from '@lucide/vue'
import type { AuditActor, AuditCategory, AuditStatus, TradingAccount } from '@aurum/contracts'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Field, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { emptyAuditFilters, type AuditFilters } from '../model/audit-presentation'

const props = defineProps<{
  accounts: TradingAccount[]
  loading: boolean
}>()

const accountId = defineModel<string>('accountId', { required: true })
const filters = defineModel<AuditFilters>('filters', { required: true })
const emit = defineEmits<{ apply: []; reset: [] }>()

const accountSelect = computed({
  get: () => accountId.value || 'all',
  set: (value: string) => { accountId.value = value === 'all' ? '' : value },
})
const category = selectValue('category')
const status = selectValue('status')
const actor = selectValue('actor')

function selectValue(key: 'category' | 'status' | 'actor') {
  return computed({
    get: () => filters.value[key] || 'all',
    set: (value: string) => {
      if (key === 'category') filters.value.category = value === 'all' ? '' : value as AuditCategory
      if (key === 'status') filters.value.status = value === 'all' ? '' : value as AuditStatus
      if (key === 'actor') filters.value.actor = value === 'all' ? '' : value as AuditActor
    },
  })
}

function reset() {
  filters.value = emptyAuditFilters()
  emit('reset')
}
</script>

<template>
  <Card class="shadow-none">
    <CardHeader class="gap-1 pb-3">
      <CardTitle class="text-base">筛选审计事件</CardTitle>
      <CardDescription>按账户和执行阶段缩小范围，详情只展示已核实的摘要与证据。</CardDescription>
    </CardHeader>
    <CardContent>
      <FieldGroup class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Field class="md:col-span-2 xl:col-span-1">
          <FieldLabel>交易账户</FieldLabel>
          <Select v-model="accountSelect" :disabled="loading || !accounts.length">
            <SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部账户" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部账户</SelectItem>
                <SelectItem v-for="account in props.accounts" :key="account.id" :value="account.id">
                  {{ account.platform.toUpperCase() }} · {{ account.login }} · {{ account.server }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel>分类</FieldLabel>
          <Select v-model="category">
            <SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部分类" /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="all">全部分类</SelectItem>
              <SelectItem value="analysis">行情分析</SelectItem>
              <SelectItem value="trading">交易决策</SelectItem>
              <SelectItem value="risk">风控</SelectItem>
              <SelectItem value="execution">执行链路</SelectItem>
              <SelectItem value="terminal">终端事实</SelectItem>
              <SelectItem value="configuration">配置变更</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel>状态</FieldLabel>
          <Select v-model="status">
            <SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部状态" /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="queued">排队中</SelectItem>
              <SelectItem value="running">处理中</SelectItem>
              <SelectItem value="succeeded">已完成</SelectItem>
              <SelectItem value="rejected">已拒绝</SelectItem>
              <SelectItem value="failed">失败</SelectItem>
              <SelectItem value="uncertain">待核实</SelectItem>
              <SelectItem value="cancelled">已取消</SelectItem>
              <SelectItem value="info">信息</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel>主体</FieldLabel>
          <Select v-model="actor">
            <SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部主体" /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="all">全部主体</SelectItem>
              <SelectItem value="ai">AI</SelectItem>
              <SelectItem value="user">用户</SelectItem>
              <SelectItem value="system">系统</SelectItem>
              <SelectItem value="bridge">量见智桥</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </Field>

        <Field class="md:col-span-2">
          <FieldLabel>关键词 / 关联 ID</FieldLabel>
          <Input v-model="filters.query" class="min-h-11" maxlength="80" placeholder="搜索动作、原因、品种或关联 ID" @keyup.enter="emit('apply')" />
        </Field>
        <Field>
          <FieldLabel>开始日期（UTC）</FieldLabel>
          <Input v-model="filters.from" class="min-h-11" type="date" />
        </Field>
        <Field>
          <FieldLabel>结束日期（UTC）</FieldLabel>
          <Input v-model="filters.to" class="min-h-11" type="date" />
        </Field>
        <div class="flex items-end gap-2 md:col-span-2 xl:col-span-4">
          <Button class="min-h-11 flex-1 sm:flex-none" :disabled="loading" @click="emit('apply')"><Search data-icon="inline-start" />应用筛选</Button>
          <Button variant="outline" class="min-h-11" :disabled="loading" @click="reset"><RotateCcw data-icon="inline-start" />重置</Button>
        </div>
      </FieldGroup>
    </CardContent>
  </Card>
</template>
