<script setup lang="ts">
import { ClipboardList, Eye, ListChecks } from '@lucide/vue'
import type { OpenPosition, PendingOrder } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import {
  formatDateTime,
  formatDecimal,
  formatPrice,
  formatVolume,
  orderTypeLabel,
  profitClass,
  sideLabel,
  sourceLabel,
} from '../model/trader-presentation'

const props = withDefaults(defineProps<{
  positions: OpenPosition[]
  orders: PendingOrder[]
  loading?: boolean
  timezoneOffsetMinutes?: number | null
}>(), {
  loading: false,
  timezoneOffsetMinutes: null,
})

const emit = defineEmits<{
  inspect: [kind: 'position' | 'order', ticket: string]
}>()

function inspect(kind: 'position' | 'order', ticket: string) {
  emit('inspect', kind, ticket)
}

function tradingTime(value: string | null) {
  return formatDateTime(value, props.timezoneOffsetMinutes)
}
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <Tabs default-value="positions">
      <CardHeader class="gap-3 border-b sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <CardTitle class="flex items-center gap-2 text-base"><ClipboardList aria-hidden="true" />持仓与挂单</CardTitle>
          <CardDescription>实时查看账户资源；选择一项查看完整参数</CardDescription>
        </div>
        <TabsList variant="line" class="w-full sm:w-auto">
          <TabsTrigger value="positions" class="min-h-11 flex-1 sm:flex-none"><ListChecks aria-hidden="true" />持仓 {{ positions.length }}</TabsTrigger>
          <TabsTrigger value="orders" class="min-h-11 flex-1 sm:flex-none"><ClipboardList aria-hidden="true" />挂单 {{ orders.length }}</TabsTrigger>
        </TabsList>
      </CardHeader>

      <CardContent class="p-0">
        <TabsContent value="positions" class="m-0">
          <div v-if="loading" class="grid gap-3 p-4"><Skeleton v-for="index in 3" :key="index" class="h-28 w-full" /></div>
          <Empty v-else-if="!positions.length" class="min-h-52 border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ListChecks /></EmptyMedia>
              <EmptyTitle>当前没有持仓</EmptyTitle>
              <EmptyDescription>账户建立持仓后，方向、价格和浮动盈亏会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <div v-else class="hidden overflow-x-auto md:block">
            <Table class="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead>品种 / 订单</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead>手数</TableHead>
                  <TableHead>开仓价</TableHead>
                  <TableHead>当前价</TableHead>
                  <TableHead>止损 / 止盈</TableHead>
                  <TableHead>浮动盈亏</TableHead>
                  <TableHead>来源 / 时间</TableHead>
                  <TableHead class="text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="item in positions" :key="item.ticket">
                  <TableCell><strong>{{ item.symbol }}</strong><p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p></TableCell>
                  <TableCell><Badge variant="outline">{{ sideLabel(item.side) }}</Badge></TableCell>
                  <TableCell class="font-mono tabular-nums">{{ formatVolume(item.volume) }}</TableCell>
                  <TableCell class="font-mono tabular-nums">{{ formatPrice(item.openPrice) }}</TableCell>
                  <TableCell class="font-mono tabular-nums">{{ formatPrice(item.currentPrice) }}</TableCell>
                  <TableCell class="font-mono text-xs tabular-nums">{{ formatPrice(item.stopLoss) }} / {{ formatPrice(item.takeProfit) }}</TableCell>
                  <TableCell class="font-mono font-semibold tabular-nums" :class="profitClass(item.floatingProfit)">{{ formatDecimal(item.floatingProfit, 2) }}</TableCell>
                  <TableCell><p>{{ sourceLabel(item.source) }}</p><p class="text-xs text-muted-foreground">{{ tradingTime(item.openedAt) }}</p></TableCell>
                  <TableCell class="text-right"><Button variant="outline" size="lg" @click="inspect('position', item.ticket)">查看详情</Button></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div v-if="!loading && positions.length" class="grid gap-3 p-3 md:hidden">
            <Card v-for="item in positions" :key="item.ticket" size="sm" class="shadow-none">
              <CardHeader class="gap-2 pb-2">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0"><CardTitle class="truncate text-base">{{ item.symbol }}</CardTitle><CardDescription class="font-mono">#{{ item.ticket }} · {{ sourceLabel(item.source) }}</CardDescription></div>
                  <Badge variant="outline">{{ sideLabel(item.side) }}</Badge>
                </div>
              </CardHeader>
              <CardContent class="grid gap-3 pt-0">
                <div class="grid grid-cols-2 gap-3 text-sm">
                  <div><p class="text-xs text-muted-foreground">手数</p><p class="mt-1 font-mono tabular-nums">{{ formatVolume(item.volume) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">浮动盈亏</p><p class="mt-1 font-mono font-semibold tabular-nums" :class="profitClass(item.floatingProfit)">{{ formatDecimal(item.floatingProfit, 2) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">开仓价</p><p class="mt-1 font-mono tabular-nums">{{ formatPrice(item.openPrice) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">当前价</p><p class="mt-1 font-mono tabular-nums">{{ formatPrice(item.currentPrice) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">止损 / 止盈</p><p class="mt-1 font-mono text-xs tabular-nums">{{ formatPrice(item.stopLoss) }} / {{ formatPrice(item.takeProfit) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">开仓时间</p><p class="mt-1 text-xs tabular-nums">{{ tradingTime(item.openedAt) }}</p></div>
                </div>
                <Button variant="outline" size="lg" class="w-full" @click="inspect('position', item.ticket)"><Eye data-icon="inline-start" />查看持仓详情</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="orders" class="m-0">
          <div v-if="loading" class="grid gap-3 p-4"><Skeleton v-for="index in 3" :key="index" class="h-28 w-full" /></div>
          <Empty v-else-if="!orders.length" class="min-h-52 border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
              <EmptyTitle>当前没有挂单</EmptyTitle>
              <EmptyDescription>账户存在待触发订单后，挂单类型、触发价和有效期会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <div v-else class="hidden overflow-x-auto md:block">
            <Table class="min-w-[1080px]">
              <TableHeader>
                <TableRow>
                  <TableHead>品种 / 订单</TableHead>
                  <TableHead>挂单类型</TableHead>
                  <TableHead>手数</TableHead>
                  <TableHead>触发价</TableHead>
                  <TableHead>止损 / 止盈</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>到期时间</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead class="text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="item in orders" :key="item.ticket">
                  <TableCell><strong>{{ item.symbol }}</strong><p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p></TableCell>
                  <TableCell><Badge variant="outline">{{ orderTypeLabel(item.type) }}</Badge></TableCell>
                  <TableCell class="font-mono tabular-nums">{{ formatVolume(item.volume) }}</TableCell>
                  <TableCell class="font-mono tabular-nums">{{ formatPrice(item.price) }}</TableCell>
                  <TableCell class="font-mono text-xs tabular-nums">{{ formatPrice(item.stopLoss) }} / {{ formatPrice(item.takeProfit) }}</TableCell>
                  <TableCell class="text-xs tabular-nums">{{ tradingTime(item.createdAt) }}</TableCell>
                  <TableCell class="text-xs tabular-nums">{{ tradingTime(item.expiresAt) }}</TableCell>
                  <TableCell>{{ sourceLabel(item.source) }}</TableCell>
                  <TableCell class="text-right"><Button variant="outline" size="lg" @click="inspect('order', item.ticket)">查看详情</Button></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div v-if="!loading && orders.length" class="grid gap-3 p-3 md:hidden">
            <Card v-for="item in orders" :key="item.ticket" size="sm" class="shadow-none">
              <CardHeader class="gap-2 pb-2">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0"><CardTitle class="truncate text-base">{{ item.symbol }}</CardTitle><CardDescription class="font-mono">#{{ item.ticket }} · {{ sourceLabel(item.source) }}</CardDescription></div>
                  <Badge variant="outline">{{ orderTypeLabel(item.type) }}</Badge>
                </div>
              </CardHeader>
              <CardContent class="grid gap-3 pt-0">
                <div class="grid grid-cols-2 gap-3 text-sm">
                  <div><p class="text-xs text-muted-foreground">手数</p><p class="mt-1 font-mono tabular-nums">{{ formatVolume(item.volume) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">触发价</p><p class="mt-1 font-mono tabular-nums">{{ formatPrice(item.price) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">止损 / 止盈</p><p class="mt-1 font-mono text-xs tabular-nums">{{ formatPrice(item.stopLoss) }} / {{ formatPrice(item.takeProfit) }}</p></div>
                  <div><p class="text-xs text-muted-foreground">有效期</p><p class="mt-1 text-xs tabular-nums">{{ tradingTime(item.expiresAt) }}</p></div>
                </div>
                <Button variant="outline" size="lg" class="w-full" @click="inspect('order', item.ticket)"><Eye data-icon="inline-start" />查看挂单详情</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </CardContent>
    </Tabs>
  </Card>
</template>
