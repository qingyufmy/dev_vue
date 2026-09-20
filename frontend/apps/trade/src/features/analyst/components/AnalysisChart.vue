<script setup lang="ts">
import { computed, ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { CandlestickSeries, createSeriesMarkers, LineSeries, LineStyle, ColorType, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { MarketAnalysisDetail } from '@aurum/contracts'
import { Maximize2, Minimize2 } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
const props = defineProps<{ periods: NonNullable<MarketAnalysisDetail['chart']> }>()
const host = ref<HTMLElement>()
const selected = ref('M5')
const layers = reactive({ bi: true, segment: true, center: true, fractal: true })
const layerOptions = [{ key: 'bi', label: '笔' }, { key: 'segment', label: '线段' }, { key: 'center', label: '中枢' }, { key: 'fractal', label: '分型' }] as const
const panel = ref<HTMLElement>()
const fullscreen = ref(false)
const fullscreenError = ref('')
async function toggleFullscreen() {
  fullscreenError.value = ''
  try {
    if (document.fullscreenElement === panel.value) await document.exitFullscreen()
    else await panel.value?.requestFullscreen()
  } catch { fullscreenError.value = '暂时无法全屏，请检查浏览器权限后重试。' }
}
function syncFullscreen() { fullscreen.value = document.fullscreenElement === panel.value }
let renderedPeriod = ''
const orderedPeriods = computed(() => [...props.periods].sort((a,b) => ['M1','M5','M15','M30','H1','H4','D1'].indexOf(a.timeframe) - ['M1','M5','M15','M30','H1','H4','D1'].indexOf(b.timeframe)))
const current = computed(() => props.periods.find(p => p.timeframe === selected.value) ?? props.periods[0])
type ChartBar = NonNullable<MarketAnalysisDetail['chart']>[number]['bars'][number]
const hoveredBar = ref<ChartBar>()
const inspectedBar = computed(() => hoveredBar.value ?? current.value?.bars.at(-1))
const formatTime = (value: string) => value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, '')
function visibleLine(kind: string) {
  if (kind.startsWith('fractal_')) return layers.fractal
  return layers[kind === 'forming_segment' ? 'segment' : kind as 'bi' | 'segment' | 'center'] ?? false
}
const inspectedStructures = computed(() => {
  if (!inspectedBar.value) return []
  const at = time(inspectedBar.value.time)
  return (current.value?.lines ?? []).filter(line => visibleLine(line.kind)
    && at >= time(line.from) && at <= time(line.to)
    && current.value?.bars.some(bar => time(bar.time) === time(line.from))
    && current.value?.bars.some(bar => time(bar.time) === time(line.to)))
})
const structureLabels: Record<string, string> = { bi: '已确认笔', segment: '已确认线段', forming_segment: '形成中线段', center: '中枢边界', fractal_top: '已确认顶分型', fractal_bottom: '已确认底分型' }
let chart: IChartApi | undefined
const time = (value: string) => Math.floor(Date.parse(value) / 1000) as UTCTimestamp
function render() {
  if (!host.value || !current.value) return
  const range = renderedPeriod === current.value.timeframe ? chart?.timeScale().getVisibleLogicalRange() : null
  hoveredBar.value = undefined
  renderedPeriod = current.value.timeframe
  chart?.remove()
  chart = createChart(host.value, { autoSize: true, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', attributionLogo: false }, grid: { vertLines: { color: '#202733' }, horzLines: { color: '#202733' } }, timeScale: { timeVisible: true, secondsVisible: false, lockVisibleTimeRangeOnResize: true }, height: host.value.clientHeight })
  const bars = [...new Map(current.value.bars.map(b => [time(b.time), b])).values()].sort((a,b) => time(a.time)-time(b.time))
  const candleSeries = chart.addSeries(CandlestickSeries, { upColor: '#ef4444', downColor: '#10b981', wickUpColor: '#ef4444', wickDownColor: '#10b981', borderVisible: false })
  candleSeries.setData(bars.map(b => ({ time: time(b.time), open: b.open, high: b.high, low: b.low, close: b.close })))
  if (layers.fractal) createSeriesMarkers(candleSeries, current.value.lines.filter(line => line.kind.startsWith('fractal_') && bars.some(bar => time(bar.time) === time(line.from))).map(line => ({ time: time(line.from), position: line.kind === 'fractal_top' ? 'aboveBar' as const : 'belowBar' as const, shape: 'circle' as const, color: '#eab308', text: line.kind === 'fractal_top' ? '顶分型' : '底分型' })))
  for (const line of current.value.lines) {
    if (line.kind.startsWith('fractal_') || !layers[line.kind === 'forming_segment' ? 'segment' : line.kind as 'bi' | 'segment' | 'center']) continue
    if (!bars.some(b => time(b.time) === time(line.from)) || !bars.some(b => time(b.time) === time(line.to))) continue
    chart.addSeries(LineSeries, { color: line.kind === 'center' ? '#94a3b8' : line.kind === 'bi' ? '#60a5fa' : '#eab308', lineWidth: 1, lineStyle: line.kind === 'segment' || line.kind === 'bi' ? LineStyle.Solid : LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData([{ time: time(line.from), value: line.start }, { time: time(line.to), value: line.end }])
  }
  const barsByTime = new Map(bars.map(bar => [time(bar.time), bar]))
  chart.subscribeCrosshairMove(event => {
    hoveredBar.value = event.point && event.point.x >= 0 && event.point.y >= 0
      && event.point.x < host.value!.clientWidth && event.point.y < host.value!.clientHeight
      && typeof event.time === 'number' ? barsByTime.get(event.time as UTCTimestamp) : undefined
  })
  if (range) chart.timeScale().setVisibleLogicalRange(range)
  else chart.timeScale().fitContent()
}
onMounted(() => { render(); document.addEventListener('fullscreenchange', syncFullscreen) })
watch([current,layers],render,{flush:'post',deep:true})
onBeforeUnmount(() => { chart?.remove(); document.removeEventListener('fullscreenchange', syncFullscreen) })
</script>
<template>
  <section ref="panel" class="min-w-0 rounded-lg border bg-card" :class="fullscreen ? 'flex h-screen flex-col overflow-auto' : ''">
    <header class="grid gap-3 p-4"><div class="flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">K 线与结构证据</h3><Button size="sm" variant="ghost" :aria-label="fullscreen ? '退出图表全屏' : '全屏查看图表'" @click="toggleFullscreen"><Minimize2 v-if="fullscreen" class="size-4" /><Maximize2 v-else class="size-4" /></Button></div><p class="text-xs text-muted-foreground">分析时保存的计算行情 · 时间为 UTC · 最后一根可能尚未收盘</p>
      <div class="flex flex-wrap items-center gap-2"><Button v-for="period in orderedPeriods" :key="period.timeframe" size="sm" :variant="current?.timeframe === period.timeframe ? 'secondary' : 'ghost'" :aria-pressed="current?.timeframe === period.timeframe" @click="selected = period.timeframe">{{ period.timeframe }}</Button><div class="ml-auto flex flex-wrap gap-1"><Button v-for="layer in layerOptions" :key="layer.key" size="sm" :variant="layers[layer.key] ? 'secondary' : 'ghost'" :aria-pressed="layers[layer.key]" @click="layers[layer.key] = !layers[layer.key]">{{ layer.label }}</Button></div></div>
    </header>
    <p v-if="fullscreenError" role="alert" class="px-4 text-sm text-destructive">{{ fullscreenError }}</p>
    <div v-if="inspectedBar" class="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/20 px-4 py-2 text-xs tabular-nums">
      <span class="text-muted-foreground">{{ formatTime(inspectedBar.time) }} UTC</span>
      <span v-for="field in ([['open', '开'], ['high', '高'], ['low', '低'], ['close', '收']] as const)" :key="field[0]" class="whitespace-nowrap"><span class="mr-1 text-muted-foreground">{{ field[1] }}</span>{{ inspectedBar[field[0]] }}</span>
      <span class="text-muted-foreground">{{ inspectedBar.closed ? '已收盘' : '未收盘' }}</span>
    </div>
    <div ref="host" class="min-w-0 border-y" :class="fullscreen ? 'min-h-[360px] flex-1' : 'h-[360px]'" role="img" :aria-label="`${current?.timeframe} 历史 K 线图`" />
    <p class="p-3 text-xs leading-6 text-muted-foreground">{{ current?.bars.length }} 根冻结 K 线 · 蓝色实线：已确认笔 · 黄色实线：已确认线段 · 黄色虚线：形成中线段 · 灰色虚线：中枢 · 圆点：最新确认分型</p>
    <details class="border-t p-3"><summary class="cursor-pointer text-xs focus-visible:outline-2">查看所选 K 线覆盖的结构（{{ inspectedStructures.length }}）</summary>
      <p class="mt-2 text-xs text-muted-foreground">移动鼠标查看对应时刻；移出图表后显示最新 K 线。结构来自本次分析快照。</p>
      <ul v-if="inspectedStructures.length" class="mt-3 grid gap-2 text-xs tabular-nums"><li v-for="(line, index) in inspectedStructures" :key="index" class="flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-muted/30 p-2"><strong>{{ structureLabels[line.kind] }}</strong><span>{{ line.start }}{{ line.from !== line.to ? ` → ${line.end}` : '' }}</span><span class="text-muted-foreground">{{ formatTime(line.from) }}{{ line.from !== line.to ? ` — ${formatTime(line.to)}` : '' }} UTC</span></li></ul>
      <p v-else class="mt-2 text-xs text-muted-foreground">当前 K 线没有可见结构覆盖。</p>
    </details>
    <details class="border-t p-3"><summary class="cursor-pointer text-xs focus-visible:outline-2">查看最近 K 线数据</summary><div class="mt-3 overflow-x-auto"><table class="w-full text-right text-xs tabular-nums"><thead><tr><th class="py-2 text-left">时间（UTC）</th><th>开</th><th>高</th><th>低</th><th>收</th></tr></thead><tbody><tr v-for="bar in current?.bars.slice(-10)" :key="bar.time"><td class="py-2 text-left">{{ bar.time.replace('T',' ').replace('.000Z','') }}</td><td>{{ bar.open }}</td><td>{{ bar.high }}</td><td>{{ bar.low }}</td><td>{{ bar.close }}</td></tr></tbody></table></div></details>
  </section>
</template>
