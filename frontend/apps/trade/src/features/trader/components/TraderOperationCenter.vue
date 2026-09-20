<script setup lang="ts">
import type { ExecutionDistributionDetail, Operation } from '@aurum/contracts'
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { Ban, CircleAlert, ClipboardCheck, Info } from '@lucide/vue'
import { formatDateTime } from '../model/trader-presentation'

import { executionExplanation } from '~/features/audit'

const props = withDefaults(defineProps<{
  operations: Operation[]
  distribution?: ExecutionDistributionDetail | null
  loading?: boolean
  timezoneOffsetMinutes?: number | null
}>(), {
  loading: false,
  distribution: null,
  timezoneOffsetMinutes: null,
})

const emit = defineEmits<{
  'close-distribution': []
}>()

const operationStatusLabels: Record<Operation['status'], string> = {
  accepted: '已受理', queued: '排队中', running: '执行中', succeeded: '已完成',
  partially_succeeded: '部分完成', rejected: '已拒绝', failed: '失败', uncertain: '待核实',
  cancelled: '已取消', expired: '已过期',
}

const statusVariant = (status: Operation['status']) => {
  if (status === 'succeeded') return 'default'
  if (status === 'rejected' || status === 'failed') return 'destructive'
  if (status === 'uncertain' || status === 'partially_succeeded') return 'secondary'
  return 'outline'
}

const hasUncertain = computed(() => props.operations.some((item) => item.status === 'uncertain'))
const attributableTargets = computed(() => props.distribution?.targets.filter((item) => item.status === 'succeeded' && item.sourceTicket).length ?? 0)

function operationLabel(kind: string) {
  const labels: Record<string, string> = {
    'execution.command': '账户交易指令',
    'execution.distribution': '策略交易分发',
    'execution.distribution_close': '分发平仓',
    command: '账户交易指令',
    distribution: '策略交易分发',
    distribution_close: '分发平仓',
    manual_order: '手动交易',
    user_execution_command: '账户交易指令',
  }
  return labels[kind] ?? '交易操作'
}

function operationSummary(operation: Operation) {
  const summary = operation.resultSummary
  const labels: Record<string, string> = { succeeded: '完成', failed: '失败', uncertain: '待核实', rejected: '未通过' }
  const counts = summary ? Object.entries(labels)
    .filter(([key]) => typeof summary[key] === 'number')
    .map(([key, label]) => `${label} ${summary[key]}`) : []
  return counts.length ? counts.join(' · ') : executionExplanation(operation.errorCode, operation.status)
}

function time(value: string | null | undefined) {
  return formatDateTime(value ?? null, props.timezoneOffsetMinutes)
}
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="gap-2 border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <CardTitle class="flex items-center gap-2 text-base"><ClipboardCheck aria-hidden="true" />本次操作</CardTitle>
          <CardDescription>显示本次打开页面后提交的操作及处理结果。</CardDescription>
        </div>
        <Badge variant="outline">{{ loading ? '同步中' : `${operations.length} 条` }}</Badge>
      </div>
    </CardHeader>

    <CardContent class="grid gap-4 p-4 sm:p-5">
      <div v-if="distribution?.kind === 'manual_order'" class="grid gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div class="min-w-0">
          <p class="text-sm font-medium">最近一次策略分发</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">目标 {{ distribution.targetCount }} 个 · 已精确归因持仓 {{ attributableTargets }} 个 · 状态 {{ operationStatusLabels[distribution.status] }}</p>
        </div>
        <Button variant="destructive" size="lg" :disabled="loading || !attributableTargets" @click="emit('close-distribution')"><Ban data-icon="inline-start" />分发平仓</Button>
      </div>
      <Alert v-if="hasUncertain" variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>有操作等待核实</AlertTitle>
        <AlertDescription>指令可能已送达终端，但结果尚未确认。请等待核实，不要重复提交。</AlertDescription>
      </Alert>
      <Alert v-else>
        <Info aria-hidden="true" />
        <AlertTitle>状态说明</AlertTitle>
        <AlertDescription>已受理只表示服务器登记成功，不代表终端已经成交；后续状态会通过实时事件更新。</AlertDescription>
      </Alert>

      <div v-if="loading" class="grid gap-3">
        <Skeleton v-for="index in 3" :key="index" class="h-20 w-full" />
      </div>
      <Empty v-else-if="!operations.length" class="min-h-56 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ClipboardCheck /></EmptyMedia>
          <EmptyTitle>暂时没有操作记录</EmptyTitle>
          <EmptyDescription>提交交易、修改保护价或分发操作后，受理与执行状态会出现在这里。</EmptyDescription>
        </EmptyHeader>
      </Empty>

      <div v-else class="hidden overflow-x-auto md:block">
        <Table class="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead>操作</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>受理时间</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead>结果 / 说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="operation in operations" :key="operation.operationId">
              <TableCell>
                <p class="font-medium">{{ operationLabel(operation.kind) }}</p>
              </TableCell>
              <TableCell><Badge :variant="statusVariant(operation.status)">{{ operationStatusLabels[operation.status] }}</Badge></TableCell>
              <TableCell class="whitespace-nowrap text-xs tabular-nums">{{ time(operation.acceptedAt) }}</TableCell>
              <TableCell class="whitespace-nowrap text-xs tabular-nums">{{ time(operation.updatedAt) }}</TableCell>
              <TableCell class="max-w-64 text-sm leading-5">
                <p>{{ operationSummary(operation) }}</p>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div v-if="!loading && operations.length" class="grid gap-3 md:hidden">
        <Card v-for="operation in operations" :key="operation.operationId" size="sm" class="shadow-none">
          <CardHeader class="gap-2 pb-2">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <CardTitle class="truncate text-sm">{{ operationLabel(operation.kind) }}</CardTitle>
              </div>
              <Badge class="shrink-0" :variant="statusVariant(operation.status)">{{ operationStatusLabels[operation.status] }}</Badge>
            </div>
          </CardHeader>
          <CardContent class="grid gap-3 pt-0 text-sm">
            <div class="grid grid-cols-2 gap-3">
              <div><p class="text-xs text-muted-foreground">更新时间</p><p class="mt-1 text-xs tabular-nums">{{ time(operation.updatedAt) }}</p></div>
            </div>
            <p class="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-5">{{ operationSummary(operation) }}</p>
            <p class="text-xs text-muted-foreground">受理 {{ time(operation.acceptedAt) }}</p>
          </CardContent>
        </Card>
      </div>
    </CardContent>
  </Card>
</template>
