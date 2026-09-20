<script setup lang="ts">
import { ArrowDownRight, ArrowUpRight, ChevronRight, FileSearch, RefreshCw, RotateCcw } from '@lucide/vue'
import type { TradeHistoryRecord } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { decimal, evidenceLabel, sideLabel, sourceLabel, terminalTime } from '../model/trade-history-presentation'

const props = defineProps<{ items: TradeHistoryRecord[]; loading: boolean; loadingMore: boolean; hasMore: boolean; freshnessStatus: 'empty' | 'syncing' | 'ready' | 'stale' | 'failed'; hasFilters: boolean }>()
const emit = defineEmits<{ select: [id: string]; more: []; reset: []; refresh: [] }>()
const pnlClass = (value: string) => Number(value) > 0 ? 'text-trade-up' : Number(value) < 0 ? 'text-trade-down' : 'text-foreground'
const emptyTitle = () => props.freshnessStatus === 'syncing' ? '正在建立账户历史档案' : props.freshnessStatus === 'failed' ? '历史同步暂时中断' : props.hasFilters ? '没有匹配的交易记录' : '该账户暂无已结算交易'
const emptyDescription = () => props.freshnessStatus === 'syncing'
  ? '采集任务已经创建，正在等待终端提供可校验的时间与历史数据。休市期间可能停留在这里，恢复有效终端时钟后会自动继续。'
  : props.freshnessStatus === 'failed' ? '已保留现有终端证据。刷新可重新读取同步状态。'
    : props.hasFilters ? '当前账户有数据边界，尝试清除品种、日期、方向或来源条件。'
      : '这里只展示该账户经终端历史确认的平仓记录，不会借用其他账户或模拟数据。'
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="flex-row items-start justify-between gap-4"><div><CardTitle>交易明细</CardTitle><CardDescription class="mt-1">点击任意记录查看成交拆分和完整来源链。</CardDescription></div><Badge variant="outline">{{ items.length }} 笔已加载</Badge></CardHeader>
    <CardContent class="p-0">
      <div v-if="loading && !items.length" class="grid gap-2 p-5"><Skeleton v-for="index in 6" :key="index" class="h-14 w-full" /></div>
      <Empty v-else-if="!items.length" class="min-h-72">
        <EmptyHeader><EmptyMedia variant="icon"><RefreshCw v-if="freshnessStatus === 'syncing'" class="animate-spin motion-reduce:animate-none" /><FileSearch v-else /></EmptyMedia><EmptyTitle>{{ emptyTitle() }}</EmptyTitle><EmptyDescription class="max-w-lg">{{ emptyDescription() }}</EmptyDescription></EmptyHeader>
        <div class="flex flex-wrap justify-center gap-2"><Button v-if="hasFilters" variant="outline" @click="emit('reset')"><RotateCcw />清除筛选</Button><Button v-else-if="freshnessStatus === 'syncing' || freshnessStatus === 'failed'" variant="outline" @click="emit('refresh')"><RefreshCw />刷新状态</Button></div>
      </Empty>
      <template v-else>
        <div class="hidden lg:block">
          <Table>
            <TableHeader><TableRow><TableHead>品种 / 方向</TableHead><TableHead>订单号</TableHead><TableHead>开仓 → 平仓</TableHead><TableHead class="text-right">手数</TableHead><TableHead class="text-right">开仓价</TableHead><TableHead class="text-right">平仓价</TableHead><TableHead class="text-right">净盈亏</TableHead><TableHead>来源</TableHead><TableHead class="w-12"><span class="sr-only">详情</span></TableHead></TableRow></TableHeader>
            <TableBody><TableRow v-for="item in items" :key="item.id" class="cursor-pointer" tabindex="0" @click="emit('select', item.id)" @keydown.enter="emit('select', item.id)" @keydown.space.prevent="emit('select', item.id)">
              <TableCell><div class="flex items-center gap-2"><span :class="['flex size-7 items-center justify-center rounded-md', item.side === 'buy' ? 'bg-trade-up/10 text-trade-up' : 'bg-trade-down/10 text-trade-down']"><ArrowUpRight v-if="item.side === 'buy'" class="size-4" /><ArrowDownRight v-else class="size-4" /></span><div><strong>{{ item.symbol }}</strong><p class="text-xs text-muted-foreground">{{ sideLabel(item.side) }}</p></div></div></TableCell>
              <TableCell class="font-mono text-xs tabular-nums">{{ item.primaryTicket }}</TableCell>
              <TableCell class="text-xs"><div>{{ terminalTime(item.openedAt, item.terminalTimezoneOffsetMinutes).slice(0, 19) }}</div><div class="text-muted-foreground">{{ terminalTime(item.closedAt, item.terminalTimezoneOffsetMinutes).slice(0, 19) }}</div></TableCell>
              <TableCell class="text-right font-mono tabular-nums">{{ item.volume }}</TableCell><TableCell class="text-right font-mono tabular-nums">{{ decimal(item.entryPrice) }}</TableCell><TableCell class="text-right font-mono tabular-nums">{{ decimal(item.exitPrice) }}</TableCell>
              <TableCell :class="['text-right font-mono font-medium tabular-nums', pnlClass(item.netProfit)]">{{ decimal(item.netProfit) }} {{ item.accountCurrency ?? '币种未知' }}</TableCell>
              <TableCell><div class="flex flex-col items-start gap-1"><Badge variant="secondary">{{ sourceLabel(item.source) }}</Badge><span class="text-[11px] text-muted-foreground">{{ evidenceLabel(item.evidenceStatus) }}</span></div></TableCell><TableCell><ChevronRight class="size-4 text-muted-foreground" /></TableCell>
            </TableRow></TableBody>
          </Table>
        </div>
        <div class="grid gap-2 p-3 lg:hidden">
          <Button v-for="item in items" :key="item.id" type="button" variant="outline" class="h-auto min-h-24 w-full flex-col items-stretch justify-start whitespace-normal p-3 text-left" @click="emit('select', item.id)">
            <span class="flex items-start justify-between gap-3"><span><strong>{{ item.symbol }} · {{ sideLabel(item.side) }}</strong><span class="mt-1 block font-mono text-xs text-muted-foreground">#{{ item.primaryTicket }}</span></span><strong :class="['font-mono tabular-nums', pnlClass(item.netProfit)]">{{ decimal(item.netProfit) }} {{ item.accountCurrency ?? '币种未知' }}</strong></span>
            <span class="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{{ sourceLabel(item.source) }} · {{ item.volume }} 手</span><span>{{ terminalTime(item.closedAt, item.terminalTimezoneOffsetMinutes).slice(5, 16) }}</span></span>
          </Button>
        </div>
        <div v-if="hasMore" class="flex justify-center border-t p-4"><Button variant="outline" class="min-h-11 min-w-32" :disabled="loadingMore" @click="emit('more')">{{ loadingMore ? '正在读取…' : '加载更多' }}</Button></div>
      </template>
    </CardContent>
  </Card>
</template>
