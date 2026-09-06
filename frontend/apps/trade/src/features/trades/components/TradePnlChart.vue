<script setup lang="ts">
import { ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { TradeHistorySummary } from '@aurum/contracts'
import { moneyStatusLabel } from '../model/trade-history-presentation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'

const props = defineProps<{ points: Array<{ businessDate: string; tradeCount: number; netProfit: string | null; cumulativeNetProfit: string | null }>; summary: TradeHistorySummary }>()
const drawable = computed(() => props.summary.moneyStatus === 'comparable' && props.points.length > 0 && props.points.every(point => point.cumulativeNetProfit !== null))
const host = ref<HTMLElement | null>(null); let chart: IChartApi | null = null; let series: ISeriesApi<'Line'> | null = null
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const render = () => { if (!series) return; series.setData((drawable.value ? props.points : []).map(item => ({ time: Math.floor(new Date(`${item.businessDate}T00:00:00Z`).getTime() / 1000) as UTCTimestamp, value: Number(item.cumulativeNetProfit) }))); chart?.timeScale().fitContent() }
watch(host, element => {
  chart?.remove(); chart = null; series = null
  if (!element) return
  chart = createChart(element, { autoSize: true, height: 220, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--muted-foreground') }, grid: { vertLines: { color: css('--border') }, horzLines: { color: css('--border') } }, rightPriceScale: { borderColor: css('--border') }, timeScale: { borderColor: css('--border') } })
  series = chart.addSeries(LineSeries, { color: css('--primary'), lineWidth: 2, priceLineVisible: false }); render()
}, { flush: 'post' })
watch([() => props.points, () => props.summary], render); onBeforeUnmount(() => chart?.remove())

</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="pb-2"><CardTitle class="text-base">累计净盈亏</CardTitle><CardDescription>按终端业务日汇总，包含佣金、库存费和手续费。</CardDescription></CardHeader>
    <CardContent><div v-if="drawable" ref="host" class="h-[13.75rem] w-full" role="img" :aria-label="`累计净盈亏曲线，共 ${points.length} 个交易日，单位 ${summary.accountCurrency}`" /><div v-else class="flex h-[13.75rem] items-center justify-center text-sm text-muted-foreground">{{ summary.moneyStatus === 'comparable' ? '当前范围暂无可绘制数据' : moneyStatusLabel(summary.moneyStatus) }}</div><table class="sr-only"><caption>累计净盈亏数据</caption><thead><tr><th>业务日</th><th>交易笔数</th><th>当日净盈亏</th><th>累计净盈亏</th></tr></thead><tbody><tr v-for="point in points" :key="point.businessDate"><td>{{ point.businessDate }}</td><td>{{ point.tradeCount }}</td><td>{{ point.netProfit ?? '--' }}</td><td>{{ point.cumulativeNetProfit ?? '--' }}</td></tr></tbody></table></CardContent>
  </Card>
</template>
