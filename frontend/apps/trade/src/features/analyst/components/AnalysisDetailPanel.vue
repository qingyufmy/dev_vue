<script setup lang="ts">
import AnalysisChart from './AnalysisChart.vue'
import ReasoningText from '~/components/ReasoningText.vue'
import { computed } from 'vue'
import { AlertTriangle, CheckCircle2, FileText } from '@lucide/vue'
import type { MarketAnalysisDetail, StrategySummary } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent } from '@aurum/ui/card'
import { marketDirectionRatio, analysisValidity, marketRegimeLabel, opportunityLabel, readableRecord } from '../model/analysis-presentation'

const props = defineProps<{ detail: MarketAnalysisDetail; strategies: StrategySummary[] }>()
const directionRatio = computed(() => marketDirectionRatio(props.detail.bullish_score, props.detail.bearish_score))
const keyLevels = computed(() => readableRecord(props.detail.key_levels))
const invalidation = computed(() => readableRecord(props.detail.invalidation))
</script>

<template>
  <Card class="gap-0 overflow-hidden py-0 shadow-none">
    <CardContent class="grid gap-5 p-5 sm:p-6">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="mb-2 text-xs font-medium text-muted-foreground">行情分析</p>
          <div class="flex flex-wrap items-center gap-3"><h2 class="text-xl font-semibold">{{ detail.summary.symbol }}</h2><Badge :variant="detail.summary.opportunity === 'none' ? 'secondary' : 'default'">{{ opportunityLabel(detail.summary.opportunity) }}</Badge></div>
        </div>
        <div class="min-w-0 text-xs leading-6 text-muted-foreground sm:text-right">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 sm:justify-end">
            <span>置信度 <strong class="font-mono font-medium text-foreground tabular-nums">{{ detail.summary.confidence }}%</strong></span>
            <span>{{ analysisValidity(detail.summary) }}</span>
          </div>
        </div>
      </header>

      <section class="grid gap-3 rounded-lg bg-muted/35 p-4">
        <h3 class="text-xs font-medium text-muted-foreground">行情结论</h3>
        <ReasoningText :text="detail.summary.summary" class="font-medium" />
      </section>

      <section class="rounded-lg border bg-muted/10 p-4">
        <div class="flex items-center justify-between gap-4"><h3 class="text-sm font-medium">市场方向倾向</h3><span class="text-xs text-muted-foreground">方向判断，不代表胜率</span></div>
        <div v-if="directionRatio" class="mt-3" aria-label="多空倾向比例">
          <div class="mb-2 flex justify-between text-sm font-semibold tabular-nums"><span class="text-trade-up">偏多 {{ directionRatio.bullish.toFixed(1) }}%</span><span class="text-trade-down">偏空 {{ directionRatio.bearish.toFixed(1) }}%</span></div>
          <div class="flex h-1.5 overflow-hidden rounded-full" aria-hidden="true"><span class="bg-trade-up" :style="{ width: `${directionRatio.bullish}%` }" /><span class="bg-trade-down" :style="{ width: `${directionRatio.bearish}%` }" /></div>
        </div>
        <p v-else class="mt-2 text-xs text-muted-foreground">本次分析未提供多空比例</p>
        <div class="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <p class="text-sm leading-7 text-muted-foreground">{{ marketRegimeLabel(detail.market_regime) }}</p>
        </div>
      </section>

      <div class="grid gap-6 lg:grid-cols-2">
        <section class="min-w-0 border-t pt-4"><h3 class="mb-3 flex items-center gap-2 text-sm font-semibold"><CheckCircle2 class="size-4 text-success" />关键依据</h3>
          <ul v-if="detail.supporting_evidence.length" class="grid gap-3"><li v-for="(item, index) in detail.supporting_evidence" :key="index" class="min-w-0 [overflow-wrap:anywhere] relative pl-4 before:absolute before:left-0 before:top-3 before:size-1 before:rounded-full before:bg-muted-foreground"><ReasoningText :text="item" /></li></ul>
          <p v-else class="text-sm text-muted-foreground">本次未单独列出依据。</p>
        </section>
        <section class="min-w-0 border-t pt-4"><h3 class="mb-3 flex items-center gap-2 text-sm font-semibold"><AlertTriangle class="size-4 text-warning" />市场风险</h3>
          <ul v-if="detail.counter_evidence.length" class="grid gap-3"><li v-for="(item, index) in detail.counter_evidence" :key="index" class="min-w-0 [overflow-wrap:anywhere] relative pl-4 before:absolute before:left-0 before:top-3 before:size-1 before:rounded-full before:bg-muted-foreground"><ReasoningText :text="item" /></li></ul>
          <p v-else class="text-sm text-muted-foreground">本次未单独列出反向证据。</p>
        </section>
      </div>

      <section v-if="keyLevels.length" class="min-w-0 border-t pt-4"><h3 class="mb-3 text-sm font-semibold">关键价位与结构</h3><dl class="grid gap-3 sm:grid-cols-2"><div v-for="item in keyLevels" :key="item.key" class="rounded-lg bg-muted/25 p-3"><dt class="text-xs text-muted-foreground">{{ item.label }}</dt><dd class="mt-1 break-words font-mono text-sm tabular-nums">{{ item.value }}</dd></div></dl></section>
      <section v-if="invalidation.length" class="min-w-0 border-t pt-4"><h3 class="mb-3 text-sm font-semibold">结论失效条件</h3><dl class="grid gap-3"><div v-for="item in invalidation" :key="item.key"><dt class="mb-1 text-xs text-muted-foreground">{{ item.label }}</dt><dd><ReasoningText :text="item.value" /></dd></div></dl></section>
      <section v-if="detail.data_gaps.length" class="rounded-lg border border-warning/20 bg-warning/5 p-4"><h3 class="mb-3 text-sm font-semibold">数据完整性</h3><ul class="grid gap-2"><li v-for="(item, index) in detail.data_gaps" :key="index"><ReasoningText :text="item" /></li></ul></section>

      <AnalysisChart v-if="detail.chart?.length" :key="detail.summary.analysisId" :periods="detail.chart" />

      <details :key="detail.summary.analysisId" open class="group border-t pt-4">
        <summary class="flex cursor-pointer items-center gap-2 rounded-md py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring"><FileText class="size-4" />分析正文<span class="ml-auto text-xs font-normal text-muted-foreground"><span class="group-open:hidden">展开</span><span class="hidden group-open:inline">收起</span></span></summary>
        <ReasoningText class="mt-3 rounded-lg border bg-muted/10 p-4" :text="detail.analysis_body || '本次分析没有保存正文。'" />
      </details>
    </CardContent>
  </Card>
</template>
