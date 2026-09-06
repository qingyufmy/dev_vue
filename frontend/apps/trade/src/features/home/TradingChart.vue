<script setup lang="ts">
import { CandlestickSeries, ColorType, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp, type Time, type TickMarkType } from 'lightweight-charts'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MarketCandle } from '@aurum/contracts'
import { chartDisplayTime } from './chart-display-time'

const props = defineProps<{ candles: MarketCandle[]; historyVersion: number; timezoneOffsetMinutes?: number | null }>()
const host = ref<HTMLElement | null>(null)
let chart: IChartApi | null = null
let candleSeries: ISeriesApi<'Candlestick'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let resizeObserver: ResizeObserver | null = null
let renderedKey = ''

function displayOptions() {
  return {
    localization: { timeFormatter: (time: Time) => chartDisplayTime(time, props.timezoneOffsetMinutes) },
    timeScale: { tickMarkFormatter: (time: Time, tick: TickMarkType) => chartDisplayTime(time, props.timezoneOffsetMinutes, tick) },
  }
}

function color(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() }
function toTime(value: string) { return Math.floor(new Date(value).getTime() / 1000) as UTCTimestamp }
function candleData(candle: MarketCandle) { return { time: toTime(candle.openTime), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close) } }
function volumeData(candle: MarketCandle) { return { time: toTime(candle.openTime), value: Number(candle.tickVolume), color: Number(candle.close) >= Number(candle.open) ? color('--trade-up') : color('--trade-down') } }

function renderHistory(items: MarketCandle[]) {
  if (!chart || !candleSeries || !volumeSeries) return
  const identity = items.length ? `${items[0]?.accountId}:${items[0]?.symbol}:${items[0]?.timeframe}` : ''
  renderedKey = identity
  candleSeries.setData(items.map(candleData)); volumeSeries.setData(items.map(volumeData)); chart.timeScale().fitContent()
}
function renderLatest(items: MarketCandle[]) {
  if (!chart || !candleSeries || !volumeSeries || !renderedKey) return
  const latest = items.at(-1)
  if (latest) { candleSeries.update(candleData(latest)); volumeSeries.update(volumeData(latest)) }
}

onMounted(() => {
  if (!host.value) return
  chart = createChart(host.value, {
    autoSize: true, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: color('--muted-foreground') },
    grid: { vertLines: { color: color('--border') }, horzLines: { color: color('--border') } },
    rightPriceScale: { borderColor: color('--border') }, timeScale: { borderColor: color('--border'), timeVisible: true, secondsVisible: false, minBarSpacing: 2 },
    crosshair: { vertLine: { labelBackgroundColor: color('--primary') }, horzLine: { labelBackgroundColor: color('--primary') } },
  })
  chart.applyOptions(displayOptions())
  candleSeries = chart.addSeries(CandlestickSeries, { upColor: color('--trade-up'), downColor: color('--trade-down'), wickUpColor: color('--trade-up'), wickDownColor: color('--trade-down'), borderVisible: false, priceLineVisible: true })
  volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false })
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } })
  resizeObserver = new ResizeObserver(() => chart?.applyOptions({ width: host.value?.clientWidth ?? 0, height: host.value?.clientHeight ?? 0 }))
  resizeObserver.observe(host.value)
  renderHistory(props.candles)
})
watch(() => props.timezoneOffsetMinutes, () => chart?.applyOptions(displayOptions()))
watch(() => props.historyVersion, () => renderHistory(props.candles))
watch(() => props.candles.at(-1), () => renderLatest(props.candles), { deep: false })
onBeforeUnmount(() => { resizeObserver?.disconnect(); chart?.remove(); chart = null })
</script>

<template><div ref="host" class="h-[25rem] min-h-80 w-full" role="img" aria-label="实时 K 线与成交量图表" /></template>
