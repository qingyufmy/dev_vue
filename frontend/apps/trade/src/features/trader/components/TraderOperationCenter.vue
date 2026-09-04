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
import { Ban, CircleAlert, ClipboardCheck, Clock3, Info } from '@lucide/vue'
import { actionLabel, formatDateTime } from '../model/trader-presentation'

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
  return labels[kind] ?? actionLabel(kind)
}

function operationSummary(operation: Operation) {
  const summary = operation.resultSummary
  if (summary) {
    for (const key of ['message', 'detail', 'reason', 'summary']) {
      const value = summary[key]
      if (typeof value === 'string' && value.trim()) return value
    }
    const counts = ['succeeded', 'failed', 'uncertain', 'rejected']
      .filter((key) => typeof summary[key] === 'number')
      .map((key) => `${key} ${summary[key]}`)
    if (counts.length) return counts.join(' · ')
  }
  if (operation.errorCode) return `错误码：${operation.errorCode}`
  if (operation.status === 'uncertain') return '结果尚未精确对账'
  if (operation.status === 'accepted' || operation.status === 'queued' || operation.status === 'running') return '等待终端回执与资源复核'
  return '--'
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
          <CardTitle class="flex items-center gap-2 text-base"><ClipboardCheck aria-hidden="true" />执行操作中心</CardTitle>
          <CardDescription>记录本次页面会话提交的交易操作；最终状态以服务端对账和终端资源为准。</CardDescription>
        </div>
        <Badge variant="outline">{{ loading ? '同步中' : `${operations.length} 条` }}</Badge>
      </div>
    </CardHeader>

    <CardContent class="grid gap-4 p-4 sm:p-5">
      <div v-if="distribution?.kind === 'manual_order'" class="grid gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div class="min-w-0">
          <p class="text-sm font-medium">最近一次策略分发</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">目标 {{ distribution.targetCount }} 个 · 已精确归因持仓 {{ attributableTargets }} 个 · 状态 {{ operationStatusLabels[distribution.status] }}</p>
          <p class="mt-1 truncate font-mono text-xs text-muted-foreground" :title="distribution.id">#{{ distribution.id }}</p>
        </div>
        <Button variant="destructive" size="lg" :disabled="loading || !attributableTargets" @click="emit('close-distribution')"><Ban data-icon="inline-start" />分发平仓</Button>
      </div>
      <Alert v-if="hasUncertain" variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>有操作等待核实</AlertTitle>
        <AlertDescription>待核实（uncertain）表示指令可能已经送达终端但结果暂时不能确认，系统不会自动重发；请等待精确对账。</AlertDescription>
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
              <TableHead>目标</TableHead>
              <TableHead>受理时间</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead>结果 / 说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="operation in operations" :key="operation.operationId">
              <TableCell>
                <p class="font-medium">{{ operationLabel(operation.kind) }}</p>
                <p class="mt-1 max-w-44 truncate font-mono text-xs text-muted-foreground" :title="operation.operationId">#{{ operation.operationId }}</p>
              </TableCell>
              <TableCell><Badge :variant="statusVariant(operation.status)">{{ operationStatusLabels[operation.status] }}</Badge></TableCell>
              <TableCell>
                <p class="font-mono text-sm tabular-nums">{{ operation.resourceId ? `#${operation.resourceId}` : '--' }}</p>
                <p v-if="operation.distributionId" class="mt-1 text-xs text-muted-foreground">分发 {{ operation.distributionId }}</p>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs tabular-nums">{{ time(operation.acceptedAt) }}</TableCell>
              <TableCell class="whitespace-nowrap text-xs tabular-nums">{{ time(operation.updatedAt) }}</TableCell>
              <TableCell class="max-w-64 text-sm leading-5">
                <p>{{ operationSummary(operation) }}</p>
                <p v-if="operation.revision" class="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Clock3 aria-hidden="true" />版本 {{ operation.revision }}</p>
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
                <CardDescription class="truncate font-mono">#{{ operation.operationId }}</CardDescription>
              </div>
              <Badge class="shrink-0" :variant="statusVariant(operation.status)">{{ operationStatusLabels[operation.status] }}</Badge>
            </div>
          </CardHeader>
          <CardContent class="grid gap-3 pt-0 text-sm">
            <div class="grid grid-cols-2 gap-3">
              <div><p class="text-xs text-muted-foreground">目标</p><p class="mt-1 font-mono tabular-nums">{{ operation.resourceId ? `#${operation.resourceId}` : '--' }}</p></div>
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
