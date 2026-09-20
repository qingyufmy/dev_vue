<script setup lang="ts">
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers, type IChartApi, type IPrimitivePaneRenderer, type ISeriesApi, type ISeriesMarkersPluginApi, type ISeriesPrimitive, type SeriesAttachedParameter, type SeriesMarker, type UTCTimestamp, type Time, type TickMarkType } from 'lightweight-charts'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PublicMarketSnapshotData } from '@aurum/contracts'
import type { ChartCandle } from './home-runtime'
import { chartDisplayTime } from './chart-display-time'

type StructureLayers = { bi: boolean; segment: boolean; center: boolean; fractal: boolean }
const props = defineProps<{ candles: ChartCandle[]; structure: PublicMarketSnapshotData['structure']; layers: StructureLayers; historyVersion: number; timezoneOffsetMinutes?: number | null }>()
const emit = defineEmits<{ older: [] }>()
let renderedTimes: string[] = []
let renderedCandles: ChartCandle[] = []
let historyRendering = false
let olderTimer: ReturnType<typeof setTimeout> | undefined
const host = ref<HTMLElement | null>(null)
let chart: IChartApi | null = null
let candleSeries: ISeriesApi<'Candlestick'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let structureSeries: ISeriesApi<'Line'>[] = []
let structureMarkers: ISeriesMarkersPluginApi<Time> | null = null
let centerBands: ISeriesPrimitive<Time> | null = null
let renderedKey = ''

function displayOptions() {
  return {
    localization: { timeFormatter: (time: Time) => chartDisplayTime(time, props.timezoneOffsetMinutes) },
    timeScale: { tickMarkFormatter: (time: Time, tick: TickMarkType) => chartDisplayTime(time, props.timezoneOffsetMinutes, tick) },
  }
}

const chartColors = new Map<string, string>()
function color(name: string, opacity?: number) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const key = `${value}:${opacity ?? 'source'}`
  const cached = chartColors.get(key)
  if (cached) return cached
  // Canvas resolves the design system's OKLCH colors into sRGB, which the
  // chart library's own color parser accepts. Preserve alpha for border tokens.
  const canvas = document.createElement('canvas')
  canvas.width = 1; canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return '#808080'
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  const resolved = `rgba(${red}, ${green}, ${blue}, ${opacity ?? (alpha ?? 255) / 255})`
  chartColors.set(key, resolved)
  return resolved
}
function toTime(value: string) { return Math.floor(new Date(value).getTime() / 1000) as UTCTimestamp }
function candleData(candle: ChartCandle) { return { time: toTime(candle.openTime), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close) } }
function volumeData(candle: ChartCandle) { return { time: toTime(candle.openTime), value: Number(candle.tickVolume), color: Number(candle.close) >= Number(candle.open) ? color('--trade-up') : color('--trade-down') } }

function layerVisible(kind: string) {
  if (kind.startsWith('fractal_')) return props.layers.fractal
  return props.layers[kind === 'forming_segment' ? 'segment' : kind === 'bi_center' ? 'center' : kind as keyof StructureLayers]
}

interface CenterBand { from: UTCTimestamp; to: UTCTimestamp; high: number; low: number; level: 'segment' | 'bi' }

class CenterBandPrimitive implements ISeriesPrimitive<Time> {
  private chart?: SeriesAttachedParameter<Time>['chart']
  private series?: SeriesAttachedParameter<Time>['series']
  constructor(private readonly bands: CenterBand[], private readonly segmentFill: string,
    private readonly biFill: string, private readonly stroke: string) {}
  attached(param: SeriesAttachedParameter<Time>) { this.chart = param.chart; this.series = param.series }
  detached() { this.chart = undefined; this.series = undefined }
  paneViews() {
    const renderer: IPrimitivePaneRenderer = {
      draw: () => {},
      drawBackground: target => target.useBitmapCoordinateSpace(scope => {
        if (!this.chart || !this.series) return
        const context = scope.context
        for (const band of this.bands) {
          const left = this.chart.timeScale().timeToCoordinate(band.from)
          const right = this.chart.timeScale().timeToCoordinate(band.to)
          const top = this.series.priceToCoordinate(band.high)
          const bottom = this.series.priceToCoordinate(band.low)
          if ([left, right, top, bottom].some(value => value == null)) continue
          const x = Math.round(Math.min(left!, right!) * scope.horizontalPixelRatio)
          const y = Math.round(Math.min(top!, bottom!) * scope.verticalPixelRatio)
          const width = Math.max(1, Math.round(Math.abs(right! - left!) * scope.horizontalPixelRatio))
          const height = Math.max(1, Math.round(Math.abs(bottom! - top!) * scope.verticalPixelRatio))
          context.fillStyle = band.level === 'segment' ? this.segmentFill : this.biFill
          context.fillRect(x, y, width, height)
          context.strokeStyle = this.stroke
          context.lineWidth = Math.max(1, scope.horizontalPixelRatio)
          context.setLineDash([4 * scope.horizontalPixelRatio, 3 * scope.horizontalPixelRatio])
          context.strokeRect(x, y, width, height)
          context.setLineDash([])
        }
      }),
    }
    return [{ zOrder: () => 'bottom' as const, renderer: () => renderer }]
  }
}

function visibleCenterBands() {
  const groups = new Map<string, { from: UTCTimestamp; to: UTCTimestamp; values: number[]; level: 'segment' | 'bi' }>()
  const visibleTimes = new Set(renderedTimes.map(toTime))
  for (const line of props.structure?.lines ?? []) {
    if (line.kind !== 'center' && line.kind !== 'bi_center') continue
    const from = toTime(line.from), to = toTime(line.to)
    if (!visibleTimes.has(from) || !visibleTimes.has(to)) continue
    const level = line.kind === 'center' ? 'segment' : 'bi'
    const key = `${level}:${line.from}:${line.to}`
    const group = groups.get(key) ?? { from, to, values: [], level }
    group.values.push(line.start, line.end)
    groups.set(key, group)
  }
  return [...groups.values()].flatMap(group => {
    const values = [...new Set(group.values.filter(Number.isFinite))]
    return values.length >= 2 ? [{ from: group.from, to: group.to, high: Math.max(...values), low: Math.min(...values), level: group.level }] : []
  })
}

function renderStructure() {
  if (!chart || !candleSeries) return
  for (const series of structureSeries) chart.removeSeries(series)
  structureSeries = []
  if (centerBands) candleSeries.detachPrimitive(centerBands)
  centerBands = null
  const visibleTimes = new Set(renderedTimes.map(toTime))
  const markers: SeriesMarker<Time>[] = []
  if (props.layers.center) {
    const bands = visibleCenterBands()
    if (bands.length) {
      centerBands = new CenterBandPrimitive(bands, color('--chart-2', 0.13), color('--chart-2', 0.065), color('--chart-2', 0.58))
      candleSeries.attachPrimitive(centerBands)
    }
  }
  for (const line of props.structure?.lines ?? []) {
    if (!layerVisible(line.kind)) continue
    const from = toTime(line.from)
    const to = toTime(line.to)
    if (line.kind.startsWith('fractal_')) {
      if (visibleTimes.has(from)) markers.push({ time: from, position: line.kind === 'fractal_top' ? 'aboveBar' : 'belowBar', shape: 'circle', color: color('--chart-3'), text: line.kind === 'fractal_top' ? '顶' : '底' })
      continue
    }
    if (!visibleTimes.has(from) || !visibleTimes.has(to)) continue
    if (line.kind === 'center' || line.kind === 'bi_center') continue
    const series = chart.addSeries(LineSeries, {
      color: line.kind === 'bi' ? color('--chart-1', 0.72) : color('--chart-3', line.kind === 'forming_segment' ? 0.78 : 1),
      lineWidth: line.kind === 'segment' ? 3 : line.kind === 'forming_segment' ? 2 : 1,
      lineStyle: line.kind === 'forming_segment' ? LineStyle.Dashed : LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    series.setData([{ time: from, value: line.start }, { time: to, value: line.end }])
    structureSeries.push(series)
  }
  structureMarkers?.setMarkers(markers)
}

function renderHistory(items: ChartCandle[]) {
  if (!chart || !candleSeries || !volumeSeries) return
  const identity = items.length ? `${items[0]?.symbol}:${items[0]?.timeframe}` : ''
  const range = chart.timeScale().getVisibleLogicalRange()
  const previousFirst = renderedTimes[0]
  const shift = previousFirst ? items.findIndex(item => item.openTime === previousFirst) : -1
  const preserve = identity === renderedKey && shift >= 0 && range
  historyRendering = true
  renderedKey = identity
  renderedTimes = items.map(item => item.openTime)
  renderedCandles = items.slice()
  candleSeries.setData(items.map(candleData)); volumeSeries.setData(items.map(volumeData))
  renderStructure()
  if (preserve) chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift })
  // Keep enough recent history in view to make higher-level segments readable;
  // users can still zoom in for candle detail or scroll left for older evidence.
  else if (items.length) chart.timeScale().setVisibleLogicalRange({ from: Math.max(-3, items.length - 200), to: items.length + 3 })
  historyRendering = false
}
function renderLatest(items: ChartCandle[]) {
  if (!chart || !candleSeries || !volumeSeries) return
  if (!renderedKey) { renderHistory(items); return }
  // A terminal correction may arrive for a previous bar after a quote has
  // already opened the next bar. Preserve the viewport while applying it.
  if (items.slice(0, -1).some((item, index) => item !== renderedCandles[index])) {
    renderHistory(items)
    return
  }
  const latest = items.at(-1)
  if (latest) { candleSeries.update(candleData(latest)); volumeSeries.update(volumeData(latest)) }
  renderedCandles = items.slice()
  renderedTimes = items.map(item => item.openTime)
}

onMounted(() => {
  if (!host.value) return
  chart = createChart(host.value, {
    kineticScroll: { mouse: false, touch: false },
    autoSize: true, layout: { attributionLogo: false, background: { type: ColorType.Solid, color: 'transparent' }, textColor: color('--muted-foreground') },
    grid: { vertLines: { color: color('--border') }, horzLines: { color: color('--border') } },
    rightPriceScale: { borderColor: color('--border') }, timeScale: { borderColor: color('--border'), timeVisible: true, secondsVisible: false, minBarSpacing: 2 },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { labelBackgroundColor: color('--primary') }, horzLine: { labelBackgroundColor: color('--primary') } },
  })
  chart.applyOptions(displayOptions())
  candleSeries = chart.addSeries(CandlestickSeries, { upColor: color('--trade-up'), downColor: color('--trade-down'), wickUpColor: color('--trade-up'), wickDownColor: color('--trade-down'), borderVisible: false, priceLineVisible: true })
  structureMarkers = createSeriesMarkers(candleSeries, [])
  volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1)
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } })
  chart.panes()[0]?.setStretchFactor(4)
  chart.panes()[1]?.setStretchFactor(1)
  renderHistory(props.candles)
  chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (historyRendering || !range || range.from > 40) return
    clearTimeout(olderTimer)
    olderTimer = setTimeout(() => {
      if ((chart?.timeScale().getVisibleLogicalRange()?.from ?? Infinity) <= 40) emit('older')
    }, 200)
  })
})
watch(() => props.timezoneOffsetMinutes, () => chart?.applyOptions(displayOptions()))
watch(() => props.historyVersion, () => renderHistory(props.candles))
watch(() => props.candles, () => renderLatest(props.candles), { deep: false })
watch(() => props.structure, renderStructure, { deep: false })
watch(() => props.layers, renderStructure, { deep: true })
onBeforeUnmount(() => { clearTimeout(olderTimer); structureMarkers?.detach(); chart?.remove(); chart = null })
</script>

<template><div ref="host" class="absolute inset-0 h-full w-full" role="img" aria-label="实时 K 线、成交量与缠论结构图表" /></template>
