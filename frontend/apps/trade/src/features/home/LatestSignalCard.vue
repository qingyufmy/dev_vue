<script setup lang="ts">
import { BrainCircuit, Maximize2 } from '@lucide/vue'
import type { MarketAnalysisSummary, StrategySummary } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Progress } from '@aurum/ui/progress'
import { Skeleton } from '@aurum/ui/skeleton'
import { defineAsyncComponent, ref } from 'vue'
import { analysisTime, analysisValidity, biasLabel, biasTextClass, loadAnalysisFullScreenSheet, opportunityLabel } from '~/features/analyst'

const props = defineProps<{ analysis: MarketAnalysisSummary | null; strategies: StrategySummary[]; loading: boolean; error: string }>()
const fullScreenOpen = ref(false)
const AnalysisFullScreenSheet = defineAsyncComponent(loadAnalysisFullScreenSheet)

function strategyName(id: string) {
  return props.strategies.find((item) => item.id === id)?.name ?? `策略 ${id}`
}
</script>

<template>
  <Card class="flex min-h-[25rem] flex-col shadow-none">
    <CardHeader class="border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><BrainCircuit /></span>
          <div class="min-w-0"><CardTitle class="text-base">最新 AI 分析</CardTitle><CardDescription>当前系统账号的最新行情判断</CardDescription></div>
        </div>
        <Badge v-if="analysis" variant="outline">{{ analysisValidity(analysis) }}</Badge>
      </div>
    </CardHeader>

    <CardContent class="flex flex-1 flex-col p-5">
      <div v-if="loading && !analysis" class="grid gap-4"><Skeleton class="h-6 w-28" /><Skeleton class="h-12 w-40" /><Skeleton class="h-20 w-full" /><Skeleton class="h-16 w-full" /></div>
      <Empty v-else-if="!analysis" class="flex-1 border-0">
        <EmptyHeader><EmptyMedia variant="icon"><BrainCircuit /></EmptyMedia><EmptyTitle>{{ error ? '最新分析读取失败' : '暂无最新分析结果' }}</EmptyTitle><EmptyDescription>{{ error || '自动或手动分析完成后，这里会自动显示最新结论。' }}</EmptyDescription></EmptyHeader>
      </Empty>
      <template v-else>
        <div class="flex flex-wrap items-center gap-2"><Badge variant="outline">{{ analysis.symbol }}</Badge><Badge :variant="analysis.opportunity === 'none' ? 'secondary' : 'default'">{{ opportunityLabel(analysis.opportunity) }}</Badge></div>
        <div class="mt-5 flex items-end justify-between gap-3">
          <div><p class="text-xs text-muted-foreground">市场偏向</p><p :class="['mt-1 text-3xl font-semibold tracking-tight', biasTextClass(analysis.marketBias)]">{{ biasLabel(analysis.marketBias) }}</p></div>
          <div class="text-right"><p class="text-xs text-muted-foreground">置信度</p><p class="mt-1 text-2xl font-semibold tabular-nums">{{ analysis.confidence }}%</p></div>
        </div>
        <Progress class="mt-3" :model-value="analysis.confidence" aria-label="最新分析置信度" />
        <p class="mt-5 text-base font-medium leading-7">{{ analysis.summary }}</p>
        <dl class="mt-auto grid gap-3 border-t pt-4 text-xs text-muted-foreground">
          <div class="flex items-center justify-between gap-3"><dt>分析策略</dt><dd class="max-w-[65%] truncate text-foreground">{{ strategyName(analysis.strategyId) }}</dd></div>
          <div class="flex items-center justify-between gap-3"><dt>分析时间</dt><dd class="tabular-nums text-foreground">{{ analysisTime(analysis.analyzedAt) }}</dd></div>
        </dl>
      </template>
    </CardContent>

    <CardFooter v-if="analysis" class="border-t p-3">
      <Button class="w-full" variant="outline" size="lg" @click="fullScreenOpen = true"><Maximize2 />全屏查看完整推理</Button>
    </CardFooter>
  </Card>

  <AnalysisFullScreenSheet v-if="analysis && fullScreenOpen" v-model:open="fullScreenOpen" :analysis-id="analysis.analysisId" :strategies="strategies" />
</template>
