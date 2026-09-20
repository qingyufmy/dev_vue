<script setup lang="ts">
import { computed, ref } from 'vue'
import { Input } from '@aurum/ui/input'
import { RouterLink } from 'vue-router'
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
  accountId?: string | null
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
  if (status === 'accepted') return 'outline'
  if (status === 'risk_rejected') return 'destructive'
  if (status === 'stale') return 'secondary'
  return 'outline'
}

const search = ref('')
const filteredItems = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return props.items.filter(item => !query || `${strategyName(props.strategies,item.strategyId)} ${actionLabel(item.action)} ${decisionStatusLabel(item.status)}`.toLocaleLowerCase().includes(query))
})
const decisionTime = (value: string) => formatDateTime(value, props.timezoneOffsetMinutes)
</script>

<template>
  <Card class="min-h-0 shadow-none lg:sticky lg:top-4 lg:self-start">
    <CardHeader class="gap-3 border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <CardTitle class="flex items-center gap-2 text-sm"><Bot class="size-4 text-primary" aria-hidden="true" />决策记录</CardTitle>
          <CardDescription class="mt-1 text-xs">当前账户的入场与持仓管理建议</CardDescription>
        </div>
        <Badge variant="outline">{{ refreshing ? '同步中' : `${items.length} 条` }}</Badge>
      </div>
    <div v-if="accountId" class="flex flex-wrap items-center justify-between gap-2"><Button variant="link" size="sm" class="h-auto px-0" as-child><RouterLink :to="{path:'/strategist',query:{section:'subscriptions',account_id:accountId}}">管理策略订阅</RouterLink></Button></div>
      <Input v-if="items.length" v-model="search" aria-label="搜索交易决策" placeholder="搜索策略、操作或处理状态" />
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
          <EmptyTitle>{{ accountId ? '暂无 AI 交易决策' : '观摩模式不展示账户决策' }}</EmptyTitle>
          <EmptyDescription>{{ accountId ? '选择交易策略并开启“自动交易”。收到分析结果并完成评估后，这里会展示建议与处理状态。' : '可以切换到持仓挂单，查看来源账户的交易情况。' }}</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div v-else-if="!filteredItems.length" class="px-4 py-12 text-center"><p class="text-sm text-muted-foreground">没有匹配的决策记录</p><Button variant="link" @click="search=''">清除搜索</Button></div>
      <ScrollArea v-else class="h-[28rem] lg:h-[min(38rem,calc(100svh-18rem))]">
        <div class="grid gap-1 pr-2">
          <Button
            v-for="item in filteredItems"
            :key="item.decisionId"
            type="button"
            :aria-current="selectedId === item.decisionId ? 'true' : undefined"
            :variant="selectedId === item.decisionId ? 'secondary' : 'ghost'"
            class="h-auto min-h-24 w-full items-start justify-start whitespace-normal rounded-lg border border-transparent px-3 py-3 text-left transition-colors aria-[current=true]:border-primary/35 aria-[current=true]:bg-primary/8 aria-[current=true]:shadow-[inset_3px_0_0_var(--primary)]"
            @click="emit('select', item.decisionId)"
          >
            <span class="grid w-full min-w-0 gap-2">
              <span class="flex items-center justify-between gap-3">
                <span class="flex min-w-0 items-center gap-2"><strong class="truncate text-sm">{{ actionLabel(item.action) }}</strong><Badge :variant="statusVariant(item.status)">{{ decisionStatusLabel(item.status) }}</Badge></span>
                <span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{{ item.confidence }}%</span>
              </span>
              <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground">
                <span>{{ strategyName(strategies, item.strategyId) }}</span><span v-if="item.side" aria-hidden="true">·</span><span v-if="item.side">{{ sideLabel(item.side) }}</span>
              </span>
              <span class="flex items-center gap-1 text-xs font-normal text-muted-foreground"><Clock3 data-icon="inline-start" />{{ decisionTime(item.createdAt) }}</span>
            </span>
          </Button>
        </div>
      </ScrollArea>
    </CardContent>
  </Card>
</template>
