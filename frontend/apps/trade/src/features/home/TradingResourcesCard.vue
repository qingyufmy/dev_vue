<script setup lang="ts">
import { formatLaboratoryTime } from '~/lib/laboratory-display-time'
import { ListOrdered } from '@lucide/vue'
import type { OpenPosition, PendingOrder } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'

defineProps<{ positions: OpenPosition[]; orders: PendingOrder[]; positionsConfirmed: boolean; ordersConfirmed: boolean }>()
const orderTypes: Record<PendingOrder['type'], string> = { buy_limit: '买入限价', sell_limit: '卖出限价', buy_stop: '买入止损', sell_stop: '卖出止损', buy_stop_limit: '买入止损限价', sell_stop_limit: '卖出止损限价' }
const value = (input: string | null) => input === null ? '--' : input
</script>

<template>
  <Card class="min-w-0 gap-0 py-0 shadow-none">
    <Tabs default-value="positions" class="min-w-0 w-full flex-col gap-0">
      <CardHeader class="flex min-w-0 flex-col gap-4 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0 space-y-1"><CardTitle class="text-base">持仓与挂单</CardTitle><CardDescription>在交易员页面管理持仓与挂单</CardDescription></div>
        <TabsList class="shrink-0 self-start sm:self-center"><TabsTrigger class="min-h-11" value="positions">持仓 {{ positionsConfirmed ? positions.length : '--' }}</TabsTrigger><TabsTrigger class="min-h-11" value="orders">挂单 {{ ordersConfirmed ? orders.length : '--' }}</TabsTrigger></TabsList>
      </CardHeader>
      <CardContent class="min-w-0 p-0">
        <TabsContent value="positions" class="m-0 overflow-x-auto">
          <div class="divide-y md:hidden">
            <article v-for="item in positions" :key="item.ticket" class="space-y-3 p-4">
              <div class="flex items-center justify-between gap-2"><strong>{{ item.symbol }}</strong><Badge variant="outline">{{ item.side === 'buy' ? '买入' : '卖出' }} · {{ item.volume }} 手</Badge></div>
              <p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p>
              <dl class="grid grid-cols-2 gap-3 text-xs text-muted-foreground"><div><dt>开仓价 / 当前价</dt><dd class="font-mono text-foreground">{{ item.openPrice }} / {{ item.currentPrice }}</dd></div><div><dt>浮动盈亏</dt><dd class="font-mono font-semibold" :class="Number(item.floatingProfit) >= 0 ? 'text-trade-up' : 'text-trade-down'">{{ item.floatingProfit }}</dd></div><div class="col-span-2"><dt>止损 / 止盈</dt><dd class="font-mono text-foreground">{{ value(item.stopLoss) }} / {{ value(item.takeProfit) }}</dd></div></dl>
            </article>
            <p v-if="!positions.length" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ positionsConfirmed ? '当前没有持仓' : '正在等待终端同步' }}</p>
          </div>
          <Table class="hidden md:table min-w-[42rem] [&_th]:px-4 [&_td]:px-4 [&_td]:py-3">
            <TableHeader><TableRow><TableHead>品种 / 订单</TableHead><TableHead>方向</TableHead><TableHead>手数</TableHead><TableHead>开仓价</TableHead><TableHead>当前价</TableHead><TableHead>止损 / 止盈</TableHead><TableHead class="text-right">浮动盈亏</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="item in positions" :key="item.ticket"><TableCell><strong>{{ item.symbol }}</strong><p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p></TableCell><TableCell><Badge variant="outline">{{ item.side === 'buy' ? '买入' : '卖出' }}</Badge></TableCell><TableCell class="font-mono">{{ item.volume }}</TableCell><TableCell class="font-mono">{{ item.openPrice }}</TableCell><TableCell class="font-mono">{{ item.currentPrice }}</TableCell><TableCell class="font-mono text-xs">{{ value(item.stopLoss) }} / {{ value(item.takeProfit) }}</TableCell><TableCell class="text-right font-mono font-semibold" :class="Number(item.floatingProfit) >= 0 ? 'text-trade-up' : 'text-trade-down'">{{ item.floatingProfit }}</TableCell></TableRow>
              <TableRow v-if="!positions.length"><TableCell colspan="7" class="h-28 text-center text-muted-foreground"><ListOrdered class="mx-auto mb-2 size-5" />{{ positionsConfirmed ? '当前没有持仓' : '正在等待终端同步持仓' }}</TableCell></TableRow>
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="orders" class="m-0 overflow-x-auto">
          <div class="divide-y md:hidden">
            <article v-for="item in orders" :key="item.ticket" class="space-y-3 p-4">
              <div class="flex items-center justify-between gap-2"><strong>{{ item.symbol }}</strong><Badge variant="outline">{{ orderTypes[item.type] }} · {{ item.volume }} 手</Badge></div>
              <p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p>
              <dl class="grid grid-cols-2 gap-3 text-xs text-muted-foreground"><div><dt>触发价</dt><dd class="font-mono text-foreground">{{ item.price }}</dd></div><div><dt>到期时间</dt><dd class="text-foreground">{{ formatLaboratoryTime(item.expiresAt) }}</dd></div><div class="col-span-2"><dt>止损 / 止盈</dt><dd class="font-mono text-foreground">{{ value(item.stopLoss) }} / {{ value(item.takeProfit) }}</dd></div></dl>
            </article>
            <p v-if="!orders.length" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ ordersConfirmed ? '当前没有挂单' : '正在等待终端同步' }}</p>
          </div>
          <Table class="hidden md:table min-w-[42rem] [&_th]:px-4 [&_td]:px-4 [&_td]:py-3"><TableHeader><TableRow><TableHead>品种 / 订单</TableHead><TableHead>类型</TableHead><TableHead>手数</TableHead><TableHead>价格</TableHead><TableHead>止损</TableHead><TableHead>止盈</TableHead><TableHead>到期时间</TableHead></TableRow></TableHeader><TableBody>
            <TableRow v-for="item in orders" :key="item.ticket"><TableCell><strong>{{ item.symbol }}</strong><p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p></TableCell><TableCell>{{ orderTypes[item.type] }}</TableCell><TableCell class="font-mono">{{ item.volume }}</TableCell><TableCell class="font-mono">{{ item.price }}</TableCell><TableCell class="font-mono">{{ value(item.stopLoss) }}</TableCell><TableCell class="font-mono">{{ value(item.takeProfit) }}</TableCell><TableCell>{{ formatLaboratoryTime(item.expiresAt) }}</TableCell></TableRow>
            <TableRow v-if="!orders.length"><TableCell colspan="7" class="h-28 text-center text-muted-foreground">{{ ordersConfirmed ? '当前没有挂单' : '正在等待终端同步挂单' }}</TableCell></TableRow>
          </TableBody></Table>
        </TabsContent>
      </CardContent>
    </Tabs>
  </Card>
</template>
