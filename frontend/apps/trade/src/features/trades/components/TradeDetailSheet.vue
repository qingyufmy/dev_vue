<script setup lang="ts">
import { ExternalLink, FileClock, Link2, ReceiptText } from '@lucide/vue'
import type { TradeRecordDetail } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent } from '@aurum/ui/card'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Separator } from '@aurum/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { attributionLink, decimal, evidenceLabel, sideLabel, sourceLabel, terminalTime } from '../model/trade-history-presentation'

const props = defineProps<{ open: boolean; detail: TradeRecordDetail | null; loading: boolean; error: string }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const pnlClass = computed(() => Number(props.detail?.netProfit ?? 0) > 0 ? 'text-trade-up' : Number(props.detail?.netProfit ?? 0) < 0 ? 'text-trade-down' : 'text-foreground')
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', Boolean($event))">
    <SheetContent class="w-full gap-0 p-0 sm:max-w-2xl">
      <SheetHeader class="border-b p-5 pr-16"><div class="flex items-center gap-2 text-xs text-primary"><ReceiptText class="size-4" />终端权威交易记录</div><SheetTitle>{{ detail ? `${detail.symbol} · ${sideLabel(detail.side)}` : '交易详情' }}</SheetTitle><SheetDescription>{{ detail ? `订单 #${detail.primaryTicket}` : '正在读取交易详情' }}</SheetDescription></SheetHeader>
      <ScrollArea class="min-h-0 flex-1"><div class="grid gap-5 p-5">
        <div v-if="loading" class="grid gap-3"><Skeleton class="h-36 w-full" /><Skeleton class="h-52 w-full" /></div>
        <p v-else-if="error" class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">{{ error }}</p>
        <template v-else-if="detail">
          <Card class="shadow-none"><CardContent class="grid gap-4 p-4 sm:grid-cols-3"><div><p class="text-xs text-muted-foreground">净盈亏</p><strong :class="['mt-1 block font-mono text-2xl tabular-nums', pnlClass]">{{ decimal(detail.netProfit) }} {{ detail.accountCurrency ?? '币种未知' }}</strong></div><div><p class="text-xs text-muted-foreground">来源</p><div class="mt-2 flex flex-wrap gap-2"><Badge variant="secondary">{{ sourceLabel(detail.source) }}</Badge><Badge variant="outline">{{ evidenceLabel(detail.evidenceStatus) }}</Badge></div></div><div><p class="text-xs text-muted-foreground">平仓时间</p><strong class="mt-1 block text-sm">{{ terminalTime(detail.closedAt, detail.terminalTimezoneOffsetMinutes) }}</strong></div></CardContent></Card>
          <section><h3 class="text-sm font-semibold">订单参数与费用</h3><div class="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4"><div v-for="item in [{ label: '手数', value: detail.volume }, { label: '开仓价', value: decimal(detail.entryPrice) }, { label: '平仓价', value: decimal(detail.exitPrice) }, { label: '止损 / 止盈', value: `${decimal(detail.stopLoss)} / ${decimal(detail.takeProfit)}` }, { label: '交易盈亏', value: decimal(detail.grossProfit) }, { label: '佣金', value: decimal(detail.commission) }, { label: '库存费', value: decimal(detail.swap) }, { label: '手续费', value: decimal(detail.fee) }]" :key="item.label" class="bg-card p-3"><p class="text-xs text-muted-foreground">{{ item.label }}</p><strong class="mt-1 block font-mono text-sm tabular-nums">{{ item.value }}</strong></div></div></section>
          <section><div class="flex items-center gap-2"><Link2 class="size-4 text-primary" /><h3 class="text-sm font-semibold">决策与执行链路</h3></div><p class="mt-1 text-xs text-muted-foreground">只展示已由订单、成交或分发目标证明的关联；未证明时不会猜测。</p><div v-if="detail.attributions.length" class="mt-3 grid gap-2 sm:grid-cols-2"><Button v-for="item in detail.attributions" :key="`${item.kind}:${item.sourceId}:${item.relation}`" as-child variant="outline" class="min-h-11 justify-between"><RouterLink :to="attributionLink(item).to"><span>{{ attributionLink(item).label }}</span><ExternalLink class="size-4" /></RouterLink></Button></div><p v-else class="mt-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">这笔交易暂无可证明的系统链路，来源保持“{{ sourceLabel(detail.source) }}”。</p></section>
          <Separator />
          <section><div class="flex items-center gap-2"><FileClock class="size-4 text-primary" /><h3 class="text-sm font-semibold">终端成交明细</h3></div><div class="mt-3 overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead>成交号</TableHead><TableHead>角色</TableHead><TableHead class="text-right">手数</TableHead><TableHead class="text-right">价格</TableHead><TableHead class="text-right">交易盈亏</TableHead></TableRow></TableHeader><TableBody><TableRow v-for="deal in detail.deals" :key="deal.id"><TableCell class="font-mono text-xs">{{ deal.dealTicket }}</TableCell><TableCell>{{ { entry: '开仓', exit: '平仓', fee: '费用', adjustment: '调整', unknown: '待核实' }[deal.role] }}</TableCell><TableCell class="text-right font-mono">{{ deal.volume ?? '--' }}</TableCell><TableCell class="text-right font-mono">{{ decimal(deal.price) }}</TableCell><TableCell class="text-right font-mono">{{ decimal(deal.grossProfit) }} {{ deal.accountCurrency ?? '币种未知' }}</TableCell></TableRow></TableBody></Table></div></section>
          <p class="break-all text-[11px] text-muted-foreground">证据摘要：{{ detail.evidenceHash }}</p>
        </template>
      </div></ScrollArea>
    </SheetContent>
  </Sheet>
</template>
