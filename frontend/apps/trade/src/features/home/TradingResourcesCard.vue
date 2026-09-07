<script setup lang="ts">
import { formatLaboratoryTime } from '~/lib/laboratory-display-time'
import { ListOrdered } from '@lucide/vue'
import type { OpenPosition, PendingOrder } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'

defineProps<{ positions: OpenPosition[]; orders: PendingOrder[] }>()
const value = (input: string | null) => input === null ? '--' : input
</script>

<template>
  <Card class="shadow-none">
    <Tabs default-value="positions">
      <CardHeader class="gap-4 border-b sm:flex-row sm:items-center sm:justify-between">
        <div><CardTitle class="text-base">持仓与挂单</CardTitle><CardDescription>点击交易员页面可执行管理操作</CardDescription></div>
        <TabsList><TabsTrigger value="positions">持仓 {{ positions.length }}</TabsTrigger><TabsTrigger value="orders">挂单 {{ orders.length }}</TabsTrigger></TabsList>
      </CardHeader>
      <CardContent class="p-0">
        <TabsContent value="positions" class="m-0 overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>品种 / 订单</TableHead><TableHead>方向</TableHead><TableHead>手数</TableHead><TableHead>开仓价</TableHead><TableHead>当前价</TableHead><TableHead>止损 / 止盈</TableHead><TableHead class="text-right">浮动盈亏</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="item in positions" :key="item.ticket"><TableCell><strong>{{ item.symbol }}</strong><p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p></TableCell><TableCell><Badge variant="outline">{{ item.side === 'buy' ? '买入' : '卖出' }}</Badge></TableCell><TableCell class="font-mono">{{ item.volume }}</TableCell><TableCell class="font-mono">{{ item.openPrice }}</TableCell><TableCell class="font-mono">{{ item.currentPrice }}</TableCell><TableCell class="font-mono text-xs">{{ value(item.stopLoss) }} / {{ value(item.takeProfit) }}</TableCell><TableCell class="text-right font-mono font-semibold" :class="Number(item.floatingProfit) >= 0 ? 'text-trade-up' : 'text-trade-down'">{{ item.floatingProfit }}</TableCell></TableRow>
              <TableRow v-if="!positions.length"><TableCell colspan="7" class="h-28 text-center text-muted-foreground"><ListOrdered class="mx-auto mb-2 size-5" />当前没有持仓</TableCell></TableRow>
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="orders" class="m-0 overflow-x-auto">
          <Table><TableHeader><TableRow><TableHead>品种 / 订单</TableHead><TableHead>类型</TableHead><TableHead>手数</TableHead><TableHead>价格</TableHead><TableHead>止损</TableHead><TableHead>止盈</TableHead><TableHead>到期时间</TableHead></TableRow></TableHeader><TableBody>
            <TableRow v-for="item in orders" :key="item.ticket"><TableCell><strong>{{ item.symbol }}</strong><p class="font-mono text-xs text-muted-foreground">#{{ item.ticket }}</p></TableCell><TableCell>{{ item.type }}</TableCell><TableCell class="font-mono">{{ item.volume }}</TableCell><TableCell class="font-mono">{{ item.price }}</TableCell><TableCell class="font-mono">{{ value(item.stopLoss) }}</TableCell><TableCell class="font-mono">{{ value(item.takeProfit) }}</TableCell><TableCell>{{ formatLaboratoryTime(item.expiresAt) }}</TableCell></TableRow>
            <TableRow v-if="!orders.length"><TableCell colspan="7" class="h-28 text-center text-muted-foreground">当前没有挂单</TableCell></TableRow>
          </TableBody></Table>
        </TabsContent>
      </CardContent>
    </Tabs>
  </Card>
</template>
