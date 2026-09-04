<script setup lang="ts">
import { RotateCcw, Search } from '@lucide/vue'
import type { TradingAccount } from '@aurum/contracts'
import { Button } from '@aurum/ui/button'
import { Card, CardContent } from '@aurum/ui/card'
import { Field, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { emptyTradeHistoryFilters, type TradeHistoryFilters } from '../model/trade-history-presentation'
import { computed } from 'vue'

defineProps<{ accounts: TradingAccount[]; loading: boolean }>()
const accountId = defineModel<string>('accountId', { required: true })
const filters = defineModel<TradeHistoryFilters>('filters', { required: true })
const emit = defineEmits<{ apply: []; reset: [] }>()
const side = computed({ get: () => filters.value.side || 'all', set: (value: string) => { filters.value.side = value === 'all' ? '' : value as TradeHistoryFilters['side'] } })
const source = computed({ get: () => filters.value.source || 'all', set: (value: string) => { filters.value.source = value === 'all' ? '' : value as TradeHistoryFilters['source'] } })
const outcome = computed({ get: () => filters.value.outcome || 'all', set: (value: string) => { filters.value.outcome = value === 'all' ? '' : value as TradeHistoryFilters['outcome'] } })

function reset() { filters.value = emptyTradeHistoryFilters(); emit('reset') }
</script>

<template>
  <Card class="shadow-none">
    <CardContent class="grid gap-4 p-4 lg:grid-cols-[minmax(13rem,1.25fr)_repeat(3,minmax(8rem,.7fr))_auto] lg:items-end">
      <Field>
        <FieldLabel>交易账户</FieldLabel>
        <Select v-model="accountId" :disabled="loading || !accounts.length">
          <SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="选择账户" /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem v-for="account in accounts" :key="account.id" :value="account.id">{{ account.platform.toUpperCase() }} · {{ account.login }} · {{ account.server }}</SelectItem></SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field><FieldLabel>方向</FieldLabel><Select v-model="side"><SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部方向" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部方向</SelectItem><SelectItem value="buy">买入</SelectItem><SelectItem value="sell">卖出</SelectItem></SelectGroup></SelectContent></Select></Field>
      <Field><FieldLabel>来源</FieldLabel><Select v-model="source"><SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部来源" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部来源</SelectItem><SelectItem value="system">系统策略</SelectItem><SelectItem value="manual">手动交易</SelectItem><SelectItem value="other_ea">其他 EA</SelectItem><SelectItem value="mixed">混合来源</SelectItem><SelectItem value="unknown">待核实</SelectItem></SelectGroup></SelectContent></Select></Field>
      <Field><FieldLabel>结果</FieldLabel><Select v-model="outcome"><SelectTrigger class="min-h-11 w-full"><SelectValue placeholder="全部结果" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">全部结果</SelectItem><SelectItem value="profit">盈利</SelectItem><SelectItem value="loss">亏损</SelectItem><SelectItem value="breakeven">持平</SelectItem></SelectGroup></SelectContent></Select></Field>
      <div class="flex gap-2"><Button class="min-h-11 flex-1 lg:flex-none" :disabled="loading" @click="emit('apply')"><Search data-icon="inline-start" />筛选</Button><Button variant="outline" size="icon-lg" :disabled="loading" aria-label="重置筛选" @click="reset"><RotateCcw /></Button></div>
      <Field class="lg:col-span-2"><FieldLabel>品种</FieldLabel><Input v-model="filters.symbol" class="min-h-11" maxlength="64" placeholder="例如 XAUUSD" /></Field>
      <Field><FieldLabel>开始日期</FieldLabel><Input v-model="filters.from" class="min-h-11" type="date" /></Field>
      <Field><FieldLabel>结束日期</FieldLabel><Input v-model="filters.to" class="min-h-11" type="date" /></Field>
      <Field class="lg:col-span-1"><FieldLabel>订单 / 持仓号</FieldLabel><Input v-model="filters.query" class="min-h-11" maxlength="64" placeholder="精确查询" @keyup.enter="emit('apply')" /></Field>
    </CardContent>
  </Card>
</template>
