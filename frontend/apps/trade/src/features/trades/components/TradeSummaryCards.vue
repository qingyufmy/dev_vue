<script setup lang="ts">
import { CircleDollarSign, Percent, ReceiptText, Trophy } from '@lucide/vue'
import type { TradeHistorySummary } from '@aurum/contracts'
import { Card, CardContent } from '@aurum/ui/card'
import { computed } from 'vue'
import { money, moneyStatusLabel } from '../model/trade-history-presentation'

const props = defineProps<{ summary: TradeHistorySummary; loading: boolean }>()
const pnlTone = computed(() => Number(props.summary.netProfit) > 0 ? 'text-trade-up' : Number(props.summary.netProfit) < 0 ? 'text-trade-down' : 'text-foreground')
</script>

<template>
  <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="交易统计摘要">
    <Card class="shadow-none"><CardContent class="flex items-start justify-between p-4"><div><p class="text-xs text-muted-foreground">净盈亏</p><strong :class="['mt-2 block font-mono text-xl tabular-nums', pnlTone]">{{ money(summary.netProfit, summary.accountCurrency) }}</strong><p class="mt-1 text-xs text-muted-foreground">{{ moneyStatusLabel(summary.moneyStatus) }}</p></div><CircleDollarSign class="size-5 text-muted-foreground" /></CardContent></Card>
    <Card class="shadow-none"><CardContent class="flex items-start justify-between p-4"><div><p class="text-xs text-muted-foreground">胜率</p><strong class="mt-2 block font-mono text-xl tabular-nums">{{ summary.winRatePercent ?? '--' }}<span v-if="summary.winRatePercent">%</span></strong><p class="mt-1 text-xs text-muted-foreground">{{ summary.winningCount }} 盈 · {{ summary.losingCount }} 亏 · {{ summary.breakevenCount }} 平</p></div><Trophy class="size-5 text-muted-foreground" /></CardContent></Card>
    <Card class="shadow-none"><CardContent class="flex items-start justify-between p-4"><div><p class="text-xs text-muted-foreground">交易笔数</p><strong class="mt-2 block font-mono text-xl tabular-nums">{{ summary.tradeCount }}</strong><p class="mt-1 text-xs text-muted-foreground">当前筛选范围内的已结算记录</p></div><ReceiptText class="size-5 text-muted-foreground" /></CardContent></Card>
    <Card class="shadow-none"><CardContent class="flex items-start justify-between p-4"><div><p class="text-xs text-muted-foreground">盈利因子</p><strong class="mt-2 block font-mono text-xl tabular-nums">{{ summary.profitFactor ?? '--' }}</strong><p class="mt-1 text-xs text-muted-foreground">盈利总额 ÷ 亏损总额绝对值</p></div><Percent class="size-5 text-muted-foreground" /></CardContent></Card>
  </section>
</template>
