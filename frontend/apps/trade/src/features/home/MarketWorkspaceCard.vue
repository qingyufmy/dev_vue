<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { PublicMarketSnapshotData, Timeframe } from '@aurum/contracts'
import type { ChartCandle, ChartQuote } from './home-runtime'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardHeader } from '@aurum/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import TradingChart from './TradingChart.vue'
import SymbolSearchSelect from './SymbolSearchSelect.vue'
import { chartReferenceLevels } from './chart-reference-levels'
import { presentChanTrend } from './chan-trend-presentation'
import { activeTerminalDisplayTimezone } from '~/lib/laboratory-display-time'
import { terminalDisplayDate, terminalDisplayTimezone } from '~/lib/terminal-display-time'

const props = defineProps<{ symbols: string[]; symbol: string; timeframe: Timeframe; quote: ChartQuote | null; candles: ChartCandle[]; structure: PublicMarketSnapshotData['structure']; realtime: string; historyVersion: number; marketSource?: 'public' | 'terminal'; timezoneOffsetMinutes?: number | null; loading?: boolean; error?: string; historyLoading?: boolean; historyMessage?: string; symbolDirectoryNotice?: string }>()
const emit = defineEmits<{ symbol: [value: string]; timeframe: [value: Timeframe]; retry: []; older: [] }>()
const periods: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']
const layers = reactive({ bi: true, segment: true, center: true, fractal: true, levels: true })
const layerOptions = [{ key: 'bi', label: '笔', tone: 'bg-chart-1' }, { key: 'segment', label: '段', tone: 'bg-chart-3' }, { key: 'center', label: '中枢', tone: 'bg-chart-2' }, { key: 'fractal', label: '分型', tone: 'bg-chart-3' }] as const
const now = ref(Date.now())
const clockDetails = ref(false)
const referenceLevels = computed(() => {
  const latest = props.candles.at(-1)
  return chartReferenceLevels(props.structure, Number(latest?.close), latest?.openTime ?? '')
})
const referenceCount = computed(() => Number(!!referenceLevels.value.support) + Number(!!referenceLevels.value.resistance))
const displayTimezone = computed(activeTerminalDisplayTimezone)
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { clearInterval(clock) })
const quoteCurrent = computed(() => !!props.quote && now.value - Date.parse(props.quote.observedAt) <= 30_000)
const marketStatus = computed(() => {
  if (!quoteCurrent.value) return '等待最新行情 · 历史快照'
  if (props.realtime === 'live') return props.marketSource === 'terminal' ? '当前终端行情实时更新' : '公共行情实时更新'
  if (props.realtime === 'connecting') return '正在连接实时行情'
  if (props.realtime === 'recovering') return '正在同步最新行情'
  if (props.realtime === 'offline') return '实时连接已断开 · 自动重连中'
  return '行情快照 · 实时连接未建立'
})
function price(value?: string | null) {
  if (value == null) return null
  const [whole, fraction = ''] = value.split('.')
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`
}
function referencePrice(key: 'support' | 'resistance') {
  const level = referenceLevels.value[key]
  if (!level || !Number.isFinite(level.low) || !Number.isFinite(level.high)) return '暂无'
  const low = price(String(level.low)), high = price(String(level.high))
  return level.low === level.high ? low : `${low}–${high}`
}
const layerCounts = computed(() => {
  const lines = props.structure?.lines ?? []
  const visibleTimes = new Set(props.candles.map(candle => candle.openTime))
  const visible = lines.filter(line => visibleTimes.has(line.from) && visibleTimes.has(line.to))
  const centers = new Set(visible.filter(line => line.kind === 'center' || line.kind === 'bi_center').map(line => `${line.kind}:${line.from}:${line.to}`)).size
  return {
    bi: visible.filter(line => line.kind === 'bi').length,
    segment: visible.filter(line => line.kind === 'segment' || line.kind === 'forming_segment').length,
    center: centers,
    fractal: visible.filter(line => line.kind.startsWith('fractal_')).length,
  }
})
const trendPresentation = computed(() => presentChanTrend(props.structure))
</script>

<template>
  <Card class="min-w-0 gap-0 overflow-hidden py-0 shadow-none">
    <CardHeader class="shrink-0 gap-3 border-b p-3 sm:p-4">
      <div class="flex flex-wrap items-center gap-2">
        <SymbolSearchSelect :symbols="symbols" :model-value="symbol" @update:model-value="emit('symbol', $event)" />
        <Select :model-value="timeframe" @update:model-value="(value) => emit('timeframe', value as Timeframe)">
          <SelectTrigger aria-label="K 线周期" class="min-h-11 w-20 bg-transparent"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem v-for="item in periods" :key="item" :value="item">{{ item }}</SelectItem></SelectGroup></SelectContent>
        </Select>
        <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1" role="status" :aria-label="trendPresentation.ariaLabel" :title="trendPresentation.title">
          <Badge variant="outline" class="min-h-7 gap-1.5 border-transparent bg-muted/50"><span class="size-1.5 rounded-full" :class="trendPresentation.tone" aria-hidden="true" />{{ trendPresentation.primary }}</Badge>
          <Badge v-if="trendPresentation.phase" variant="outline" class="min-h-7 border-border/70 bg-background/70 text-foreground">{{ trendPresentation.phase }}</Badge>
          <span v-if="trendPresentation.quality.length" class="px-1 text-xs text-muted-foreground">{{ trendPresentation.quality.join(' · ') }}</span>
        </div>
        <div v-if="quote && quoteCurrent && !loading" class="flex min-w-0 flex-wrap items-center rounded-lg border bg-muted/20">
            <div class="px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">卖出</p><p class="font-mono text-sm font-semibold tabular-nums text-trade-down">{{ price(quote.bid) }}</p></div>
            <div class="border-x px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">买入</p><p class="font-mono text-sm font-semibold tabular-nums text-trade-up">{{ price(quote.ask) }}</p></div>
            <div class="px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">点差</p><p class="font-mono text-sm tabular-nums">{{ price(quote.spread) }}</p></div>
        </div>
      </div>
      <p v-if="symbolDirectoryNotice" class="text-xs text-amber-600 dark:text-amber-400" role="status">{{ symbolDirectoryNotice }}</p>
      <div class="flex flex-wrap items-center gap-1 rounded-lg bg-muted/35 p-1" role="group" aria-label="缠论图层">
        <Button v-for="layer in layerOptions" :key="layer.key" type="button" size="sm" variant="ghost" class="min-h-11 flex-1 gap-2 px-2 text-xs transition-colors motion-reduce:transition-none sm:px-3" :class="layers[layer.key] ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'" :aria-pressed="layers[layer.key]" :aria-label="`${layer.label}图层，${layerCounts[layer.key]} 项${layers[layer.key] ? '，已显示' : '，已隐藏'}`" @click="layers[layer.key] = !layers[layer.key]"><span class="h-0.5 w-3 rounded-full" :class="[layer.tone, layers[layer.key] ? 'opacity-100' : 'opacity-35']" aria-hidden="true" />{{ layer.label }}</Button>
        <Button type="button" size="sm" variant="ghost" class="min-h-11 flex-1 px-2 text-xs transition-colors motion-reduce:transition-none sm:px-3" :class="layers.levels ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'" :aria-pressed="layers.levels" :aria-label="`支撑压力图层，${referenceCount} 项${layers.levels ? '，已显示' : '，已隐藏'}`" @click="layers.levels = !layers.levels">支撑 / 压力</Button>
      </div>
      <div v-if="layers.levels" class="grid grid-cols-2 divide-x rounded-lg border bg-muted/10" aria-label="支撑与压力参考">
        <div v-for="(label, key) in { support: '参考支撑', resistance: '参考压力' }" :key="key" class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
          <span class="text-xs text-muted-foreground">{{ label }}</span>
          <strong class="font-mono text-sm tabular-nums" :class="key === 'support' ? 'text-chart-1' : 'text-chart-3'">{{ referencePrice(key) }}</strong>
          <span v-if="referenceLevels[key]" class="text-xs text-muted-foreground">{{ referenceLevels[key].source }}</span>
        </div>
      </div>
      <p v-if="structure && !structure.lines.length" role="status" class="text-xs text-muted-foreground">当前结构证据不足，等待后续行情确认。</p>
    </CardHeader>
    <CardContent class="flex flex-1 flex-col p-0" :aria-busy="loading">
      <div v-if="error" role="alert" class="flex min-h-[25rem] flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p class="text-sm text-destructive">{{ error }}</p><Button variant="outline" @click="emit('retry')">重新读取行情</Button>
      </div>
      <div v-else-if="loading" role="status" class="flex min-h-[25rem] flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />行情加载中…</div>
      <div v-else-if="candles.length" class="relative min-h-[25rem] flex-1"><TradingChart :timezone-offset-minutes="timezoneOffsetMinutes" :candles="candles" :structure="structure" :layers="layers" :reference-levels="referenceLevels" :history-version="historyVersion" @older="emit('older')" /><div v-if="historyLoading || historyMessage" class="pointer-events-none absolute bottom-8 left-3 flex items-center gap-2 rounded bg-card/85 px-2 py-1 text-xs text-muted-foreground" role="status"><LoaderCircle v-if="historyLoading" class="size-3 animate-spin motion-reduce:animate-none" />{{ historyLoading ? '历史加载中…' : historyMessage }}</div></div>
      <div v-else role="status" class="flex min-h-[25rem] flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <LoaderCircle class="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" /><p class="text-sm">{{ symbol }} {{ timeframe }} 行情加载中…</p>
      </div>
      <div class="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-2 border-t px-3 text-xs text-muted-foreground">
        <span role="status">{{ marketStatus }}</span>
        <Button variant="ghost" size="sm" class="min-h-11 px-1 font-mono text-xs" aria-label="查看行情时区确认信息" :aria-expanded="clockDetails" @click="clockDetails = !clockDetails">{{ terminalDisplayDate(new Date(now), timezoneOffsetMinutes).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'UTC' }) }} {{ terminalDisplayTimezone(timezoneOffsetMinutes).label }}</Button>

      </div>
      <p v-if="clockDetails" class="shrink-0 border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">{{ marketSource === 'terminal' ? '当前终端' : '公共行情' }}时区 {{ displayTimezone.label }} · {{ displayTimezone.statusLabel }}。前端本地走时；收盘或数据修正后自动更新确认结构。虚线段为形成中结构，中枢包含段级与笔级，支撑压力仅作结构参考。</p>
    </CardContent>
  </Card>
</template>
