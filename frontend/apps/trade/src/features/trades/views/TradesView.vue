<script setup lang="ts">
import { AlertCircle, Clock3, DatabaseZap, RefreshCw } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import TradeDetailSheet from '../components/TradeDetailSheet.vue'
import TradeHistoryFilterBar from '../components/TradeHistoryFilters.vue'
import TradeHistoryTable from '../components/TradeHistoryTable.vue'
import TradePnlChart from '../components/TradePnlChart.vue'
import TradeSummaryCards from '../components/TradeSummaryCards.vue'
import { useTradeHistoryWorkspace } from '../composables/use-trade-history-workspace'
import { emptyTradeHistoryFilters, type TradeHistoryFilters } from '../model/trade-history-presentation'

const route = useRoute(); const router = useRouter()
const text = (value: unknown) => typeof value === 'string' ? value : ''
const accountId = ref(text(route.query.account_id))
const filters = ref<TradeHistoryFilters>({ symbol: text(route.query.symbol).toUpperCase(), side: ['buy', 'sell'].includes(text(route.query.side)) ? text(route.query.side) as TradeHistoryFilters['side'] : '', source: ['system', 'manual', 'other_ea', 'mixed', 'unknown'].includes(text(route.query.source)) ? text(route.query.source) as TradeHistoryFilters['source'] : '', outcome: ['profit', 'loss', 'breakeven'].includes(text(route.query.outcome)) ? text(route.query.outcome) as TradeHistoryFilters['outcome'] : '', from: text(route.query.from), to: text(route.query.to), query: text(route.query.q) })
const workspace = useTradeHistoryWorkspace(accountId, filters)
const detailOpen = computed(() => Boolean(workspace.selected.value || workspace.detailLoading.value || workspace.detailError.value))
const currency = computed(() => workspace.selectedAccount.value?.currency ?? 'USD')
const realtimeLabel = computed(() => ({ idle: '未连接', connecting: '连接中', live: '实时同步', recovering: '恢复中', offline: '快照模式' })[workspace.realtime.value])
const freshnessLabel = computed(() => ({ empty: '等待历史数据', syncing: '历史同步中', ready: '历史已就绪', stale: '历史可能滞后', failed: '历史同步失败' })[workspace.freshness.value.status])

async function applyFilters() {
  const clean = { ...filters.value }
  filters.value = clean
  const query: Record<string, string> = { account_id: accountId.value }
  if (clean.symbol) query.symbol = clean.symbol.toUpperCase(); if (clean.side) query.side = clean.side; if (clean.source) query.source = clean.source; if (clean.outcome) query.outcome = clean.outcome; if (clean.from) query.from = clean.from; if (clean.to) query.to = clean.to; if (clean.query) query.q = clean.query
  await router.replace({ path: '/trades', query }); await workspace.load(true)
}
async function resetFilters() { filters.value = emptyTradeHistoryFilters(); await router.replace({ path: '/trades', query: { account_id: accountId.value } }); await workspace.load(true) }
function openDetail(id: string) { void router.replace({ path: '/trades', query: { ...route.query, record_id: id } }); void workspace.loadDetail(id) }
function closeDetail() { workspace.closeDetail(); const query = { ...route.query }; delete query.record_id; void router.replace({ path: '/trades', query }) }
watch(() => route.query.record_id, (value) => { const id = text(value); if (id && id !== workspace.selected.value?.id) void workspace.loadDetail(id) }, { immediate: true })
watch(accountId, (value) => {
  if (!value || text(route.query.account_id) === value) return
  void router.replace({ path: '/trades', query: { ...route.query, account_id: value } })
})
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1680px] gap-5 p-4 sm:p-6 lg:p-8">
    <header class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div><div class="flex items-center gap-2 text-xs font-medium text-primary"><DatabaseZap class="size-4" />账户档案 · 终端事实</div><h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">交易记录</h1><p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">按当前交易账户查看已结算交易、费用和来源链。执行受理不等于终端成交，只有终端历史事实会进入这里。</p></div>
      <div class="flex flex-wrap items-center gap-2"><Badge variant="outline"><span :class="['size-1.5 rounded-full', workspace.realtime.value === 'live' ? 'bg-system-ok' : 'bg-muted-foreground']" />{{ realtimeLabel }}</Badge><Badge variant="outline"><Clock3 class="size-3.5" />{{ freshnessLabel }}</Badge><Button variant="outline" class="min-h-11" :disabled="workspace.loading.value" @click="workspace.load(true)"><RefreshCw :class="workspace.loading.value ? 'animate-spin motion-reduce:animate-none' : ''" />刷新</Button></div>
    </header>

    <Alert v-if="workspace.error.value" variant="destructive" role="alert"><AlertCircle /><AlertTitle>交易记录暂时不可用</AlertTitle><AlertDescription>{{ workspace.error.value }}。不会显示本地模拟数据，也不会因此发起任何终端操作。</AlertDescription></Alert>
    <Alert v-else-if="workspace.freshness.value.status === 'stale' || workspace.freshness.value.status === 'syncing'"><Clock3 /><AlertTitle>{{ freshnessLabel }}</AlertTitle><AlertDescription>当前页面仍可查看最近一次已确认快照；新成交会在历史投影封口后通过轻量实时事件触发刷新。</AlertDescription></Alert>

    <TradeHistoryFilterBar v-model:account-id="accountId" v-model:filters="filters" :accounts="workspace.accounts.value" :loading="workspace.loading.value" @apply="applyFilters" @reset="resetFilters" />
    <TradeSummaryCards :summary="workspace.summary.value" :currency="currency" :loading="workspace.loading.value" />
    <TradePnlChart :points="workspace.daily.value" :currency="currency" />
    <TradeHistoryTable :items="workspace.items.value" :currency="currency" :loading="workspace.loading.value" :loading-more="workspace.loadingMore.value" :has-more="Boolean(workspace.nextCursor.value)" @select="openDetail" @more="workspace.load(false)" />
    <TradeDetailSheet :open="detailOpen" :detail="workspace.selected.value" :loading="workspace.detailLoading.value" :error="workspace.detailError.value" :currency="currency" @update:open="value => { if (!value) closeDetail() }" />
  </div>
</template>
