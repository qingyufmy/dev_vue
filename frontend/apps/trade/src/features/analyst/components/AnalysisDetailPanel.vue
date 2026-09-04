<script setup lang="ts">
import { AlertTriangle, CheckCircle2, CircleGauge, FileText, ShieldAlert } from '@lucide/vue'
import type { MarketAnalysisDetail, StrategySummary } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Progress } from '@aurum/ui/progress'
import { Separator } from '@aurum/ui/separator'
import { analysisTime, analysisValidity, biasLabel, biasTextClass, opportunityLabel, readableRecord } from '../model/analysis-presentation'

const props = defineProps<{ detail: MarketAnalysisDetail; strategies: StrategySummary[] }>()

function strategyName(id: string) {
  return props.strategies.find((item) => item.id === id)?.name ?? `策略 ${id}`
}
</script>

<template>
  <article class="grid gap-4">
    <Card class="shadow-none">
      <CardHeader class="border-b">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline">{{ detail.summary.symbol }}</Badge>
              <Badge :variant="detail.summary.opportunity === 'none' ? 'secondary' : 'default'">{{ opportunityLabel(detail.summary.opportunity) }}</Badge>
              <Badge variant="outline">{{ analysisValidity(detail.summary) }}</Badge>
            </div>
            <CardTitle class="text-xl sm:text-2xl">{{ detail.summary.summary }}</CardTitle>
            <CardDescription class="mt-2">{{ strategyName(detail.summary.strategyId) }} · {{ analysisTime(detail.summary.analyzedAt) }}</CardDescription>
          </div>
          <div class="shrink-0 sm:w-48">
            <div class="mb-2 flex items-end justify-between gap-3">
              <span class="text-xs text-muted-foreground">市场判断置信度</span>
              <strong class="text-lg tabular-nums">{{ detail.summary.confidence }}%</strong>
            </div>
            <Progress :model-value="detail.summary.confidence" aria-label="市场判断置信度" />
          </div>
        </div>
      </CardHeader>
      <CardContent class="grid gap-5 pt-5 md:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <section>
          <p class="text-xs text-muted-foreground">市场偏向</p>
          <p :class="['mt-1 text-3xl font-semibold tracking-tight', biasTextClass(detail.summary.marketBias)]">{{ biasLabel(detail.summary.marketBias) }}</p>
        </section>
        <section>
          <p class="text-xs text-muted-foreground">市场环境</p>
          <p class="mt-1 text-base font-medium">{{ detail.market_regime || '暂未给出明确市场环境' }}</p>
        </section>
      </CardContent>
    </Card>

    <div class="grid gap-4 xl:grid-cols-2">
      <Card class="shadow-none">
        <CardHeader><CardTitle class="flex items-center gap-2 text-base"><CircleGauge />关键价位</CardTitle><CardDescription>模型分析时识别的价格区域</CardDescription></CardHeader>
        <CardContent>
          <dl v-if="readableRecord(detail.key_levels).length" class="grid gap-3 sm:grid-cols-2">
            <div v-for="item in readableRecord(detail.key_levels)" :key="item.key" class="rounded-lg border bg-muted/30 p-3">
              <dt class="text-xs text-muted-foreground">{{ item.label }}</dt><dd class="mt-1 break-words font-mono text-sm tabular-nums">{{ item.value }}</dd>
            </div>
          </dl>
          <p v-else class="text-sm text-muted-foreground">本次分析未给出关键价位。</p>
        </CardContent>
      </Card>
      <Card class="shadow-none">
        <CardHeader><CardTitle class="flex items-center gap-2 text-base"><ShieldAlert />失效条件</CardTitle><CardDescription>出现这些情况时，不应继续沿用本结论</CardDescription></CardHeader>
        <CardContent>
          <dl v-if="readableRecord(detail.invalidation).length" class="grid gap-3 sm:grid-cols-2">
            <div v-for="item in readableRecord(detail.invalidation)" :key="item.key" class="rounded-lg border bg-muted/30 p-3">
              <dt class="text-xs text-muted-foreground">{{ item.label }}</dt><dd class="mt-1 break-words text-sm">{{ item.value }}</dd>
            </div>
          </dl>
          <p v-else class="text-sm text-muted-foreground">本次分析未给出单独的失效条件。</p>
        </CardContent>
      </Card>
    </div>

    <Card class="shadow-none">
      <CardHeader><CardTitle class="text-base">判断依据</CardTitle><CardDescription>支持结论与需要谨慎对待的反向证据分开展示</CardDescription></CardHeader>
      <CardContent class="grid gap-6 md:grid-cols-2">
        <section>
          <h3 class="flex items-center gap-2 text-sm font-medium"><CheckCircle2 class="text-success" />支持依据</h3>
          <ul v-if="detail.supporting_evidence.length" class="mt-3 grid gap-2">
            <li v-for="item in detail.supporting_evidence" :key="item" class="rounded-lg bg-muted/40 p-3 text-sm leading-6">{{ item }}</li>
          </ul>
          <p v-else class="mt-3 text-sm text-muted-foreground">没有单独列出的支持依据。</p>
        </section>
        <section>
          <h3 class="flex items-center gap-2 text-sm font-medium"><AlertTriangle class="text-warning" />反向证据</h3>
          <ul v-if="detail.counter_evidence.length" class="mt-3 grid gap-2">
            <li v-for="item in detail.counter_evidence" :key="item" class="rounded-lg bg-muted/40 p-3 text-sm leading-6">{{ item }}</li>
          </ul>
          <p v-else class="mt-3 text-sm text-muted-foreground">没有单独列出的反向证据。</p>
        </section>
      </CardContent>
    </Card>

    <Card v-if="detail.data_gaps.length" class="shadow-none">
      <CardHeader><CardTitle class="text-base">数据缺口</CardTitle><CardDescription>以下信息在本次判断中缺失或可信度不足</CardDescription></CardHeader>
      <CardContent><ul class="grid gap-2 sm:grid-cols-2"><li v-for="item in detail.data_gaps" :key="item" class="rounded-lg border p-3 text-sm">{{ item }}</li></ul></CardContent>
    </Card>

    <Separator />

    <Card class="shadow-none">
      <CardHeader><CardTitle class="flex items-center gap-2 text-base"><FileText />完整推理与分析正文</CardTitle><CardDescription>这是模型保存的完整分析正文，位于结构化结论之后</CardDescription></CardHeader>
      <CardContent><div class="whitespace-pre-wrap break-words text-sm leading-7 text-foreground/90">{{ detail.analysis_body || '本次分析没有保存正文。' }}</div></CardContent>
    </Card>
  </article>
</template>
