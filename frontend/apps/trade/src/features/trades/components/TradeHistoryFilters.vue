<script setup lang="ts">
import { ChevronDown, Filter, RotateCcw, Search } from '@lucide/vue'
import type { TradingAccount } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Field, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Separator } from '@aurum/ui/separator'
import { computed, ref } from 'vue'
import { emptyTradeHistoryFilters, type TradeHistoryFilters } from '../model/trade-history-presentation'

defineProps<{ accounts: TradingAccount[]; loading: boolean }>()
const accountId = defineModel<string>('accountId', { required: true })
const filters = defineModel<TradeHistoryFilters>('filters', { required: true })
const emit = defineEmits<{ apply: []; reset: [] }>()
const advancedOpen = ref(Boolean(filters.value.side || filters.value.source || filters.value.outcome || filters.value.from || filters.value.to))
const side = computed({ get: () => filters.value.side || 'all', set: (value: string) => { filters.value.side = value === 'all' ? '' : value as TradeHistoryFilters['side'] } })
const source = computed({ get: () => filters.value.source || 'all', set: (value: string) => { filters.value.source = value === 'all' ? '' : value as TradeHistoryFilters['source'] } })
const outcome = computed({ get: () => filters.value.outcome || 'all', set: (value: string) => { filters.value.outcome = value === 'all' ? '' : value as TradeHistoryFilters['outcome'] } })
const activeCount = computed(() => Object.values(filters.value).filter(Boolean).length)

function reset() { filters.value = emptyTradeHistoryFilters(); advancedOpen.value = false; emit('reset') }
</script>

<template>
  <Card class="shadow-none">
    <CardHeader class="gap-1 pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <CardTitle class="flex items-center gap-2 text-base"><Filter class="size-4 text-primary" />查看范围</CardTitle>
        <CardDescription class="mt-1">账户是数据边界；其余条件只影响当前统计与列表。</CardDescription>
      </div>
      <Badge v-if="activeCount" variant="secondary">{{ activeCount }} 个筛选条件</Badge>
    </CardHeader>
    <CardContent class="grid gap-4 pt-0">
      <div class="grid gap-4 lg:grid-cols-[minmax(16rem,1.35fr)_minmax(10rem,.65fr)_minmax(12rem,.85fr)_auto] lg:items-end">
        <Field>
          <FieldLabel>交易账户</FieldLabel>
          <Select v-model="accountId" :disabled="loading || !accounts.length">
            <SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="选择账户" /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem v-for="account in accounts" :key="account.id" :value="account.id">{{ account.platform.toUpperCase() }} · {{ account.login }} · {{ account.server }}</SelectItem></SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field><FieldLabel>品种</FieldLabel><Input v-model="filters.symbol" class="min-h-11" maxlength="64" placeholder="例如 XAUUSD" @keyup.enter="emit('apply')" /></Field>
        <Field><FieldLabel>订单 / 持仓号</FieldLabel><Input v-model="filters.query" class="min-h-11" maxlength="64" placeholder="输入精确编号" @keyup.enter="emit('apply')" /></Field>
        <div class="flex gap-2"><Button class="min-h-11 flex-1 lg:flex-none" :disabled="loading" @click="emit('apply')"><Search data-icon="inline-start" />查询</Button><Button variant="outline" size="icon-lg" :disabled="loading || !activeCount" aria-label="重置筛选" @click="reset"><RotateCcw /></Button></div>
      </div>
      <Separator />
      <Button type="button" variant="ghost" class="h-9 w-fit px-2 text-muted-foreground" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">更多筛选<ChevronDown :class="['size-4 transition-transform', advancedOpen && 'rotate-180']" /></Button>
      <div v-if="advancedOpen" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Field><FieldLabel>方向</FieldLabel><Select v-model="side"><SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部方向" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部方向</SelectItem><SelectItem value="buy">买入</SelectItem><SelectItem value="sell">卖出</SelectItem></SelectGroup></SelectContent></Select></Field>
        <Field><FieldLabel>来源</FieldLabel><Select v-model="source"><SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部来源" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部来源</SelectItem><SelectItem value="system">系统策略</SelectItem><SelectItem value="manual">手动交易</SelectItem><SelectItem value="other_ea">其他 EA</SelectItem><SelectItem value="mixed">混合来源</SelectItem><SelectItem value="unknown">待核实</SelectItem></SelectGroup></SelectContent></Select></Field>
        <Field><FieldLabel>结果</FieldLabel><Select v-model="outcome"><SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部结果" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部结果</SelectItem><SelectItem value="profit">盈利</SelectItem><SelectItem value="loss">亏损</SelectItem><SelectItem value="breakeven">持平</SelectItem></SelectGroup></SelectContent></Select></Field>
        <Field><FieldLabel>开始日期</FieldLabel><Input v-model="filters.from" class="min-h-11" type="date" /></Field>
        <Field><FieldLabel>结束日期</FieldLabel><Input v-model="filters.to" class="min-h-11" type="date" /></Field>
      </div>
    </CardContent>
  </Card>
</template>
