<script setup lang="ts">
import { AlertCircle, Bot, Clock3 } from '@lucide/vue'
import type { StrategySummary, TraderDecisionSummary } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Skeleton } from '@aurum/ui/skeleton'
import { actionLabel, decisionStatusLabel, formatDateTime, sideLabel, strategyName } from '../model/trader-presentation'

const props = withDefaults(defineProps<{
  items: TraderDecisionSummary[]
  strategies: StrategySummary[]
  selectedId: string
  loading?: boolean
  refreshing?: boolean
  error?: string
  timezoneOffsetMinutes?: number | null
}>(), {
  loading: false,
  refreshing: false,
  error: '',
  timezoneOffsetMinutes: null,
})

const emit = defineEmits<{
  select: [id: string]
}>()

function statusVariant(status: TraderDecisionSummary['status']) {
  if (status === 'accepted') return 'default'
  if (status === 'risk_rejected') return 'destructive'
  if (status === 'stale') return 'secondary'
  return 'outline'
}

const decisionTime = (value: string) => formatDateTime(value, props.timezoneOffsetMinutes)
</script>

<template>
  <Card class="min-h-0 shadow-none lg:h-[calc(100svh-11rem)]">
    <CardHeader class="gap-3 border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <CardTitle class="flex items-center gap-2"><Bot aria-hidden="true" />AI 交易员记录</CardTitle>
          <CardDescription>按当前交易账户归档，查看 AI 对入场与持仓管理的判断</CardDescription>
        </div>
        <Badge variant="outline">{{ refreshing ? '同步中' : `${items.length} 条` }}</Badge>
      </div>
    </CardHeader>

    <CardContent class="min-h-0 p-2">
      <div v-if="loading" class="grid gap-2 p-1"><Skeleton v-for="index in 6" :key="index" class="h-24 w-full" /></div>
      <Alert v-else-if="error" variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>交易员记录读取失败</AlertTitle>
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <Empty v-else-if="!items.length" class="min-h-72 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Bot /></EmptyMedia>
          <EmptyTitle>还没有交易员决定</EmptyTitle>
          <EmptyDescription>当分析机会触发账户级 AI 交易员评估后，决定会显示在这里。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <ScrollArea v-else class="h-[28rem] lg:h-[calc(100svh-17rem)]">
        <div class="grid gap-2 pr-3">
          <Button
            v-for="item in items"
            :key="item.decisionId"
            type="button"
            :variant="selectedId === item.decisionId ? 'secondary' : 'ghost'"
            class="h-auto min-h-24 w-full items-start justify-start whitespace-normal px-3 py-3 text-left"
            @click="emit('select', item.decisionId)"
          >
            <span class="grid w-full min-w-0 gap-2">
              <span class="flex items-center justify-between gap-3">
                <span class="flex min-w-0 items-center gap-2"><strong class="truncate text-sm">{{ item.action === 'hold' ? '账户决定' : '执行建议' }}</strong><Badge :variant="statusVariant(item.status)">{{ decisionStatusLabel(item.status) }}</Badge></span>
                <span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{{ item.confidence }}%</span>
              </span>
              <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground">
                <span>{{ strategyName(strategies, item.strategyId) }}</span><span aria-hidden="true">·</span><span>{{ actionLabel(item.action) }}</span><span v-if="item.side" aria-hidden="true">·</span><span v-if="item.side">{{ sideLabel(item.side) }}</span>
              </span>
              <span class="flex items-center gap-1 text-xs font-normal text-muted-foreground"><Clock3 data-icon="inline-start" />{{ decisionTime(item.createdAt) }}</span>
            </span>
          </Button>
        </div>
      </ScrollArea>
    </CardContent>
  </Card>
</template>
