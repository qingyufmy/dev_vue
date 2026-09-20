<script setup lang="ts">
import { Activity, CalendarClock, ChartNoAxesCombined, Layers3, ListChecks, TrendingDown } from '@lucide/vue'
import type { RiskPolicy, RiskSummary } from '@aurum/contracts'
import { computed } from 'vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Progress } from '@aurum/ui/progress'
import { formatDecimal, ratio } from '../model/risk-presentation'

const props = defineProps<{ policy: RiskPolicy | null; summary: RiskSummary | null }>()
const metrics = computed(() => {
  const policy = props.policy
  const summary = props.summary
  if (!policy || !summary) return []
  return [
    { label: '当日亏损', value: `${formatDecimal(summary.dailyLossPercent)}%`, detail: `上限 ${formatDecimal(policy.maxDailyLossPercent)}%`, progress: ratio(summary.dailyLossPercent, policy.maxDailyLossPercent), icon: TrendingDown },
    { label: '当日回撤', value: `${formatDecimal(summary.drawdownPercent)}%`, detail: `上限 ${formatDecimal(policy.maxDrawdownPercent)}%`, progress: ratio(summary.drawdownPercent, policy.maxDrawdownPercent), icon: ChartNoAxesCombined },
    { label: '持仓数量', value: `${summary.openPositions} 笔`, detail: `上限 ${policy.maxOpenPositions} 笔`, progress: ratio(summary.openPositions, policy.maxOpenPositions), icon: Layers3 },
    { label: '挂单数量', value: `${summary.pendingOrders} 笔`, detail: `上限 ${policy.maxPendingOrders} 笔`, progress: ratio(summary.pendingOrders, policy.maxPendingOrders), icon: ListChecks },
    { label: '账户总手数', value: `${formatDecimal(summary.totalVolume)} 手`, detail: `上限 ${formatDecimal(policy.maxTotalVolume)} 手`, progress: ratio(summary.totalVolume, policy.maxTotalVolume), icon: Activity },
    { label: '当日开仓', value: `${summary.dailyOpenCount} 次`, detail: `上限 ${policy.maxDailyOpenCount} 次`, progress: ratio(summary.dailyOpenCount, policy.maxDailyOpenCount), icon: CalendarClock },
  ]
})

function progressClass(value: number) {
  return value >= 100 ? '[&_[data-slot=progress-indicator]]:bg-destructive' : value >= 80 ? '[&_[data-slot=progress-indicator]]:bg-amber-500' : ''
}
</script>

<template>
  <section aria-labelledby="risk-metrics-title">
    <div class="mb-3 flex items-end justify-between gap-3">
      <div><h2 id="risk-metrics-title" class="text-base font-semibold">实时风险用量</h2><p class="mt-0.5 text-xs text-muted-foreground">当前用量与账户上限；数据未准备好时不显示估算值</p></div>
      <p v-if="summary" class="text-xs text-muted-foreground">交易日 {{ summary.businessDate }}</p>
    </div>
    <div v-if="!summary || !policy" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <div v-for="label in ['当日亏损', '当日回撤', '持仓数量', '挂单数量', '账户总手数', '当日开仓']" :key="label" class="rounded-xl border bg-card p-5">
        <p class="text-sm text-muted-foreground">{{ label }}</p><p class="my-3 text-2xl font-semibold">—</p><p class="text-xs text-muted-foreground">等待账户风险数据</p>
      </div>
    </div>
    <div v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <Card v-for="metric in metrics" :key="metric.label" class="shadow-none">
        <CardHeader class="flex-row items-start justify-between space-y-0 pb-3">
          <div><CardDescription>{{ metric.label }}</CardDescription><CardTitle class="mt-1 font-mono text-xl tabular-nums">{{ metric.value }}</CardTitle></div>
          <span class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"><component :is="metric.icon" class="size-4" aria-hidden="true" /></span>
        </CardHeader>
        <CardContent class="space-y-2">
          <Progress :model-value="metric.progress" :class="progressClass(metric.progress)" />
          <div class="flex items-center justify-between text-xs text-muted-foreground"><span>{{ metric.detail }}</span><span class="font-mono tabular-nums">{{ Math.round(metric.progress) }}%</span></div>
        </CardContent>
      </Card>
    </div>
  </section>
</template>
