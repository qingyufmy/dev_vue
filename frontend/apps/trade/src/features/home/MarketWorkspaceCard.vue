<script setup lang="ts">
import { Maximize2, RadioTower } from '@lucide/vue'
import type { MarketCandle, MarketQuote, Timeframe } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardHeader } from '@aurum/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import TradingChart from './TradingChart.vue'
import { terminalDisplayDate, terminalDisplayTimezone } from '~/lib/terminal-display-time'

defineProps<{ symbols: string[]; symbol: string; timeframe: Timeframe; quote: MarketQuote | null; candles: MarketCandle[]; realtime: string; historyVersion: number; timezoneOffsetMinutes?: number | null }>()
const emit = defineEmits<{ symbol: [value: string]; timeframe: [value: Timeframe] }>()
const periods: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']
</script>

<template>
  <Card class="min-w-0 overflow-hidden shadow-none">
    <CardHeader class="border-b p-3 sm:p-4">
      <div class="flex flex-wrap items-center gap-2">
        <Select :model-value="symbol" @update:model-value="(value) => value && emit('symbol', String(value))">
          <SelectTrigger class="h-9 w-32"><SelectValue placeholder="品种" /></SelectTrigger>
          <SelectContent><SelectItem v-for="item in symbols" :key="item" :value="item">{{ item }}</SelectItem></SelectContent>
        </Select>
        <Select :model-value="timeframe" @update:model-value="(value) => emit('timeframe', value as Timeframe)">
          <SelectTrigger class="h-9 w-24"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem v-for="item in periods" :key="item" :value="item">{{ item }}</SelectItem></SelectContent>
        </Select>
        <div class="ml-auto flex min-w-0 items-center rounded-lg border bg-muted/30">
          <div class="px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">卖出</p><p class="font-mono text-sm font-semibold tabular-nums text-trade-down">{{ quote?.bid ?? '--' }}</p></div>
          <div class="border-x px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">买入</p><p class="font-mono text-sm font-semibold tabular-nums text-trade-up">{{ quote?.ask ?? '--' }}</p></div>
          <div class="px-3 py-1.5 text-center"><p class="text-[11px] text-muted-foreground">点差</p><p class="font-mono text-sm tabular-nums">{{ quote?.spread ?? '--' }}</p></div>
        </div>
      </div>
    </CardHeader>
    <CardContent class="p-0">
      <div v-if="candles.length" class="relative"><TradingChart :timezone-offset-minutes="timezoneOffsetMinutes" :candles="candles" :history-version="historyVersion" /></div>
      <div v-else class="flex h-[25rem] flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <RadioTower class="size-8" aria-hidden="true" /><p class="text-sm">等待终端提供 {{ symbol || '当前品种' }} K 线</p>
      </div>
      <div class="flex min-h-11 items-center gap-2 border-t px-4 text-xs text-muted-foreground">
        <Badge variant="outline">{{ timeframe }}</Badge><span>{{ realtime === 'live' ? '实时增量已连接' : '使用最近快照' }}</span>
        <span class="ml-auto font-mono">{{ quote?.observedAt ? terminalDisplayDate(new Date(quote.observedAt), timezoneOffsetMinutes).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'UTC' }) : '--:--:--' }} {{ terminalDisplayTimezone(timezoneOffsetMinutes).label }}</span>
        <Button variant="ghost" size="icon-sm" aria-label="全屏查看行情" disabled><Maximize2 /></Button>
      </div>
    </CardContent>
  </Card>
</template>
