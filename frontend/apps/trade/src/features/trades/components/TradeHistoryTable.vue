<script setup lang="ts">
import { ArrowDownRight, ArrowUpRight, ChevronRight, FileSearch } from '@lucide/vue'
import type { TradeHistoryRecord } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { decimal, evidenceLabel, sideLabel, sourceLabel, terminalTime } from '../model/trade-history-presentation'

defineProps<{ items: TradeHistoryRecord[]; currency: string; loading: boolean; loadingMore: boolean; hasMore: boolean }>()
const emit = defineEmits<{ select: [id: string]; more: [] }>()
const pnlClass = (value: string) => Number(value) > 0 ? 'text-trade-up' : Number(value) < 0 ? 'text-trade-down' : 'text-foreground'
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="flex-row items-start justify-between gap-4"><div><CardTitle>交易明细</CardTitle><CardDescription class="mt-1">点击任意记录查看成交拆分和完整来源链。</CardDescription></div><Badge variant="outline">{{ items.length }} 笔已加载</Badge></CardHeader>
    <CardContent class="p-0">
      <div v-if="loading && !items.length" class="grid gap-2 p-5"><Skeleton v-for="index in 6" :key="index" class="h-14 w-full" /></div>
      <Empty v-else-if="!items.length" class="min-h-64"><EmptyHeader><EmptyMedia variant="icon"><FileSearch /></EmptyMedia><EmptyTitle>当前范围没有交易记录</EmptyTitle><EmptyDescription>可调整账户、日期或来源筛选。页面不会用模拟数据代替终端记录。</EmptyDescription></EmptyHeader></Empty>
      <template v-else>
        <div class="hidden lg:block">
          <Table>
            <TableHeader><TableRow><TableHead>品种 / 方向</TableHead><TableHead>订单号</TableHead><TableHead>开仓 → 平仓</TableHead><TableHead class="text-right">手数</TableHead><TableHead class="text-right">开仓价</TableHead><TableHead class="text-right">平仓价</TableHead><TableHead class="text-right">净盈亏</TableHead><TableHead>来源</TableHead><TableHead class="w-12"><span class="sr-only">详情</span></TableHead></TableRow></TableHeader>
            <TableBody><TableRow v-for="item in items" :key="item.id" class="cursor-pointer" tabindex="0" @click="emit('select', item.id)" @keydown.enter="emit('select', item.id)" @keydown.space.prevent="emit('select', item.id)">
              <TableCell><div class="flex items-center gap-2"><span :class="['flex size-7 items-center justify-center rounded-md', item.side === 'buy' ? 'bg-trade-up/10 text-trade-up' : 'bg-trade-down/10 text-trade-down']"><ArrowUpRight v-if="item.side === 'buy'" class="size-4" /><ArrowDownRight v-else class="size-4" /></span><div><strong>{{ item.symbol }}</strong><p class="text-xs text-muted-foreground">{{ sideLabel(item.side) }}</p></div></div></TableCell>
              <TableCell class="font-mono text-xs tabular-nums">{{ item.primaryTicket }}</TableCell>
              <TableCell class="text-xs"><div>{{ terminalTime(item.openedAt, item.terminalTimezoneOffsetMinutes).slice(0, 19) }}</div><div class="text-muted-foreground">{{ terminalTime(item.closedAt, item.terminalTimezoneOffsetMinutes).slice(0, 19) }}</div></TableCell>
              <TableCell class="text-right font-mono tabular-nums">{{ item.volume }}</TableCell><TableCell class="text-right font-mono tabular-nums">{{ decimal(item.entryPrice) }}</TableCell><TableCell class="text-right font-mono tabular-nums">{{ decimal(item.exitPrice) }}</TableCell>
              <TableCell :class="['text-right font-mono font-medium tabular-nums', pnlClass(item.netProfit)]">{{ decimal(item.netProfit) }} {{ currency }}</TableCell>
              <TableCell><div class="flex flex-col items-start gap-1"><Badge variant="secondary">{{ sourceLabel(item.source) }}</Badge><span class="text-[11px] text-muted-foreground">{{ evidenceLabel(item.evidenceStatus) }}</span></div></TableCell><TableCell><ChevronRight class="size-4 text-muted-foreground" /></TableCell>
            </TableRow></TableBody>
          </Table>
        </div>
        <div class="grid gap-2 p-3 lg:hidden">
          <Button v-for="item in items" :key="item.id" type="button" variant="outline" class="h-auto min-h-24 w-full flex-col items-stretch justify-start whitespace-normal p-3 text-left" @click="emit('select', item.id)">
            <span class="flex items-start justify-between gap-3"><span><strong>{{ item.symbol }} · {{ sideLabel(item.side) }}</strong><span class="mt-1 block font-mono text-xs text-muted-foreground">#{{ item.primaryTicket }}</span></span><strong :class="['font-mono tabular-nums', pnlClass(item.netProfit)]">{{ decimal(item.netProfit) }} {{ currency }}</strong></span>
            <span class="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{{ sourceLabel(item.source) }} · {{ item.volume }} 手</span><span>{{ terminalTime(item.closedAt, item.terminalTimezoneOffsetMinutes).slice(5, 16) }}</span></span>
          </Button>
        </div>
        <div v-if="hasMore" class="flex justify-center border-t p-4"><Button variant="outline" class="min-h-11 min-w-32" :disabled="loadingMore" @click="emit('more')">{{ loadingMore ? '正在读取…' : '加载更多' }}</Button></div>
      </template>
    </CardContent>
  </Card>
</template>
