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
import { activeTerminalDisplayTimezone } from '~/lib/laboratory-display-time'
import { terminalDisplayDate, terminalDisplayTimezone } from '~/lib/terminal-display-time'

const props = defineProps<{ symbols: string[]; symbol: string; timeframe: Timeframe; quote: ChartQuote | null; candles: ChartCandle[]; structure: PublicMarketSnapshotData['structure']; realtime: string; historyVersion: number; timezoneOffsetMinutes?: number | null; loading?: boolean; error?: string; historyLoading?: boolean; historyMessage?: string }>()
const emit = defineEmits<{ symbol: [value: string]; timeframe: [value: Timeframe]; retry: []; older: [] }>()
const periods: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']
const layers = reactive({ bi: true, segment: true, center: true, fractal: false })
const layerOptions = [{ key: 'bi', label: '笔' }, { key: 'segment', label: '线段' }, { key: 'center', label: '中枢' }, { key: 'fractal', label: '分型' }] as const
const now = ref(Date.now())
const clockDetails = ref(false)
const displayTimezone = computed(activeTerminalDisplayTimezone)
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { clearInterval(clock) })
const quoteCurrent = computed(() => !!props.quote && now.value - Date.parse(props.quote.observedAt) <= 30_000)
const marketStatus = computed(() => {
  if (!quoteCurrent.value) return '等待最新行情 · 历史快照'
  if (props.realtime === 'live') return '公共行情实时更新'
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
const structureSummary = computed(() => {
  if (!props.structure) return ['M5', 'M15', 'H1', 'H4'].includes(props.timeframe) ? '结构数据准备中' : '当前周期暂不支持结构计算'
  if (!props.structure.lines.length) return `结构证据不足 · ${props.structure.based_on_closed_bars} 根已收盘 K 线`
  return `缠论结构 · ${props.structure.based_on_closed_bars} 根已收盘 K 线`
})
</script>

<template>
  <Card class="min-w-0 overflow-hidden shadow-none">
    <CardHeader class="shrink-0 border-b p-3 sm:p-4">
      <div class="flex flex-wrap items-center gap-2">
        <Select :model-value="symbol" @update:model-value="(value) => value && emit('symbol', String(value))">
          <SelectTrigger aria-label="行情品种" class="min-h-11 w-32"><SelectValue placeholder="品种" /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem v-for="item in symbols" :key="item" :value="item">{{ item }}</SelectItem></SelectGroup></SelectContent>
        </Select>
        <Select :model-value="timeframe" @update:model-value="(value) => emit('timeframe', value as Timeframe)">
          <SelectTrigger aria-label="K 线周期" class="min-h-11 w-24"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem v-for="item in periods" :key="item" :value="item">{{ item }}</SelectItem></SelectGroup></SelectContent>
        </Select>
        <div class="ml-auto flex min-w-0 items-center rounded-lg border bg-muted/30">
          <template v-if="quote && quoteCurrent && !loading">
            <div class="px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">卖出</p><p class="font-mono text-sm font-semibold tabular-nums text-trade-down">{{ price(quote.bid) }}</p></div>
            <div class="border-x px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">买入</p><p class="font-mono text-sm font-semibold tabular-nums text-trade-up">{{ price(quote.ask) }}</p></div>
            <div class="px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">点差</p><p class="font-mono text-sm tabular-nums">{{ price(quote.spread) }}</p></div>
          </template>
          <span v-else role="status" class="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><LoaderCircle v-if="loading" class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{{ loading ? '报价加载中' : '等待最新报价' }}</span>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 border-t pt-3">
        <span class="mr-1 text-xs font-medium">结构图层</span>
        <Button v-for="layer in layerOptions" :key="layer.key" type="button" size="sm" class="min-h-11 px-3" :variant="layers[layer.key] ? 'secondary' : 'ghost'" :aria-pressed="layers[layer.key]" @click="layers[layer.key] = !layers[layer.key]">{{ layer.label }}</Button>
        <span class="ml-auto text-xs text-muted-foreground">{{ structureSummary }}</span>
      </div>
    </CardHeader>
    <CardContent class="flex flex-1 flex-col p-0" :aria-busy="loading">
      <div v-if="error" role="alert" class="flex min-h-[25rem] flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p class="text-sm text-destructive">{{ error }}</p><Button variant="outline" @click="emit('retry')">重新读取行情</Button>
      </div>
      <div v-else-if="loading" role="status" class="flex min-h-[25rem] flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />行情加载中…</div>
      <div v-else-if="candles.length" class="relative min-h-[25rem] flex-1"><TradingChart :timezone-offset-minutes="timezoneOffsetMinutes" :candles="candles" :structure="structure" :layers="layers" :history-version="historyVersion" @older="emit('older')" /><div class="absolute left-3 top-2 flex items-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle v-if="historyLoading" class="size-3 animate-spin motion-reduce:animate-none" />{{ historyLoading ? '历史加载中…' : historyMessage }}</div></div>
      <div v-else role="status" class="flex min-h-[25rem] flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <LoaderCircle class="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" /><p class="text-sm">{{ symbol }} {{ timeframe }} 行情加载中…</p>
      </div>
      <div class="flex min-h-11 shrink-0 items-center gap-2 border-t px-4 text-xs text-muted-foreground">
        <Badge variant="outline">{{ timeframe }}</Badge><span role="status">{{ marketStatus }}</span>
        <Button variant="ghost" size="sm" class="ml-auto min-h-11 font-mono text-xs" aria-label="查看行情时区确认信息" :aria-expanded="clockDetails" @click="clockDetails = !clockDetails">{{ terminalDisplayDate(new Date(now), timezoneOffsetMinutes).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'UTC' }) }} {{ terminalDisplayTimezone(timezoneOffsetMinutes).label }}</Button>

      </div>
      <p v-if="structure?.lines.length" class="shrink-0 border-t px-4 py-2 text-xs leading-5 text-muted-foreground">蓝色实线：笔 · 黄色实线：已确认线段 · 黄色虚线：形成中线段 · 灰色虚线：中枢 · 圆点：确认分型。结构仅使用已收盘 K 线。</p>
      <p v-if="clockDetails" class="shrink-0 border-t px-4 py-3 text-xs text-muted-foreground">公共行情时区 {{ displayTimezone.label }} · {{ displayTimezone.statusLabel }}。由管理员终端确认，前端本地走时。</p>
    </CardContent>
  </Card>
</template>
