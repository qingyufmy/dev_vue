<script setup lang="ts">
import { BrainCircuit, Maximize2 } from '@lucide/vue'
import type { MarketAnalysisSummary, StrategySummary } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { computed, defineAsyncComponent, ref } from 'vue'
import { marketDirectionRatio, analysisTime, analysisValidity, loadAnalysisFullScreenSheet, opportunityLabel } from '~/features/analyst'

import { createApiClient } from '@aurum/api-client'
import { useQuery } from '@tanstack/vue-query'
import { useTradeSession } from '~/features/auth'

const props = defineProps<{ analysis: MarketAnalysisSummary | null; strategies: StrategySummary[]; loading: boolean; error: string }>()
const fullScreenOpen = ref(false)
const AnalysisFullScreenSheet = defineAsyncComponent(loadAnalysisFullScreenSheet)

const client = createApiClient()
const { session } = useTradeSession()
const directionQuery = useQuery({
  queryKey: computed(() => ['trade', 'analyst', 'detail', `${session.value?.user.id ?? ''}:${session.value?.authenticated_at ?? ''}`, props.analysis?.analysisId ?? '']),
  queryFn: async () => (await client.getMarketAnalysis(props.analysis!.analysisId)).data,
  enabled: computed(() => Boolean(session.value && props.analysis)),
  staleTime: 60_000,
})
const directionRatio = computed(() => {
  const detail = directionQuery.data.value
  if (detail?.summary.analysisId !== props.analysis?.analysisId) return null
  return marketDirectionRatio(detail?.bullish_score, detail?.bearish_score)
})

function strategyName(id: string) {
  return props.strategies.find((item) => item.id === id)?.name ?? '分析策略'
}
</script>

<template>
  <Card class="flex flex-col shadow-none" :class="analysis ? 'min-h-[25rem]' : 'self-start'">
    <CardHeader class="border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><BrainCircuit /></span>
          <div class="min-w-0"><CardTitle class="text-base">最新 AI 分析</CardTitle></div>
        </div>

      </div>
    </CardHeader>

    <CardContent class="flex flex-1 flex-col p-5">
      <div v-if="loading && !analysis" class="grid gap-4"><Skeleton class="h-6 w-28" /><Skeleton class="h-12 w-40" /><Skeleton class="h-20 w-full" /><Skeleton class="h-16 w-full" /></div>
      <Empty v-else-if="!analysis" class="flex-1 border-0">
        <EmptyHeader><EmptyMedia variant="icon"><BrainCircuit /></EmptyMedia><EmptyTitle>{{ error ? '最新分析读取失败' : '暂无最新分析结果' }}</EmptyTitle><EmptyDescription>{{ error || '自动或手动分析完成后，这里会自动显示最新结论。' }}</EmptyDescription></EmptyHeader>
      </Empty>
      <template v-else>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p class="mr-auto text-lg font-semibold tracking-tight">{{ analysis.symbol }}</p>
          <Badge :variant="analysis.opportunity === 'none' ? 'secondary' : 'default'">{{ opportunityLabel(analysis.opportunity) }}</Badge>
          <p class="text-xs text-muted-foreground">置信度 <span class="font-medium tabular-nums text-foreground">{{ analysis.confidence }}%</span></p>
        </div>
        <section class="mt-4" aria-label="市场方向倾向">
          <h3 class="text-xs font-medium text-muted-foreground">市场方向倾向</h3>
          <template v-if="directionRatio">
            <div class="mb-2 mt-3 flex justify-between gap-2 text-xs font-semibold tabular-nums">
              <span class="text-trade-up">偏多 {{ directionRatio.bullish.toFixed(1) }}%</span>
              <span class="text-trade-down">偏空 {{ directionRatio.bearish.toFixed(1) }}%</span>
            </div>
            <div class="flex h-1.5 overflow-hidden rounded-full" aria-hidden="true">
              <span class="bg-trade-up" :style="{ width: `${directionRatio.bullish}%` }" />
              <span class="bg-trade-down" :style="{ width: `${directionRatio.bearish}%` }" />
            </div>
            <p class="mt-2 text-xs text-muted-foreground">倾向强弱，不代表胜率</p>
          </template>
          <p v-else class="mt-2 text-xs text-muted-foreground">{{ directionQuery.isPending.value ? '正在读取方向倾向…' : directionQuery.isError.value ? '方向倾向暂时无法读取' : '本次分析未提供多空比例' }}</p>
        </section>
        <p class="my-5 line-clamp-6 text-sm leading-7 text-foreground">{{ analysis.summary }}</p>
        <p class="mb-4 text-xs text-muted-foreground">{{ analysisValidity(analysis) }}</p>
        <dl class="mt-auto grid gap-3 border-t pt-4 text-xs text-muted-foreground">
          <div class="flex items-center justify-between gap-3"><dt>分析策略</dt><dd class="max-w-[65%] truncate text-foreground">{{ strategyName(analysis.strategyId) }}</dd></div>
          <div class="flex items-center justify-between gap-3"><dt>分析时间</dt><dd class="tabular-nums text-foreground">{{ analysisTime(analysis.analyzedAt) }}</dd></div>
        </dl>
      </template>
    </CardContent>

    <CardFooter v-if="analysis" class="border-t p-3">
      <Button class="w-full" variant="outline" size="lg" @click="fullScreenOpen = true"><Maximize2 />查看完整分析</Button>
    </CardFooter>
  </Card>

  <AnalysisFullScreenSheet v-if="analysis && fullScreenOpen" v-model:open="fullScreenOpen" :analysis-id="analysis.analysisId" :strategies="strategies" />
</template>
