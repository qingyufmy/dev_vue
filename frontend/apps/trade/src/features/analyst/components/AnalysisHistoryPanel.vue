<script setup lang="ts">
import { AlertCircle, Clock3, RadioTower } from '@lucide/vue'
import type { MarketAnalysisSummary, StrategySummary } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Skeleton } from '@aurum/ui/skeleton'
import { analysisTime, biasLabel, opportunityLabel } from '../model/analysis-presentation'

const props = defineProps<{
  items: MarketAnalysisSummary[]
  strategies: StrategySummary[]
  selectedId: string
  loading: boolean
  refreshing: boolean
  error: string
}>()

const emit = defineEmits<{ select: [id: string] }>()

function strategyName(id: string) {
  return props.strategies.find((item) => item.id === id)?.name ?? `策略 ${id}`
}
</script>

<template>
  <Card class="min-h-0 shadow-none lg:h-[calc(100svh-10.5rem)]">
    <CardHeader class="border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <CardTitle>分析记录</CardTitle>
          <CardDescription>按当前系统账号归档，不随交易账户切换</CardDescription>
        </div>
        <Badge variant="outline">{{ refreshing ? '同步中' : `${items.length} 条` }}</Badge>
      </div>
    </CardHeader>
    <CardContent class="min-h-0 p-2">
      <div v-if="loading" class="grid gap-2 p-1">
        <Skeleton v-for="index in 7" :key="index" class="h-24 w-full" />
      </div>
      <Alert v-else-if="error" variant="destructive">
        <AlertCircle />
        <AlertTitle>分析记录读取失败</AlertTitle>
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <Empty v-else-if="!items.length" class="min-h-72 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><RadioTower /></EmptyMedia>
          <EmptyTitle>还没有分析记录</EmptyTitle>
          <EmptyDescription>自动分析完成后会出现在这里，也可以手动发起一次分析。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <ScrollArea v-else class="h-[24rem] lg:h-[calc(100svh-16rem)]">
        <div class="grid gap-2 pr-3">
          <Button
            v-for="item in items"
            :key="item.analysisId"
            type="button"
            :variant="selectedId === item.analysisId ? 'secondary' : 'ghost'"
            class="h-auto min-h-24 w-full items-start justify-start whitespace-normal px-3 py-3 text-left"
            @click="emit('select', item.analysisId)"
          >
            <span class="grid w-full min-w-0 gap-2">
              <span class="flex items-center justify-between gap-3">
                <strong class="truncate text-sm">{{ item.symbol }}</strong>
                <Badge :variant="item.opportunity === 'none' ? 'outline' : 'default'">{{ opportunityLabel(item.opportunity) }}</Badge>
              </span>
              <span class="truncate text-xs font-normal text-muted-foreground">{{ strategyName(item.strategyId) }}</span>
              <span class="flex items-center justify-between gap-2 text-xs font-normal text-muted-foreground">
                <span>{{ biasLabel(item.marketBias) }}</span>
                <span class="inline-flex items-center gap-1 tabular-nums"><Clock3 data-icon="inline-start" />{{ analysisTime(item.analyzedAt) }}</span>
              </span>
            </span>
          </Button>
        </div>
      </ScrollArea>
    </CardContent>
  </Card>
</template>
