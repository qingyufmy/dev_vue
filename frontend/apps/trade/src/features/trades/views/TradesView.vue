<script setup lang="ts">
import { AlertCircle, Clock3, DatabaseZap, Radio, RefreshCw } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent } from '@aurum/ui/card'
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
const realtimeLabel = computed(() => ({ idle: '未连接', connecting: '连接中', live: '实时同步', recovering: '恢复中', offline: '快照模式' })[workspace.realtime.value])
const freshnessLabel = computed(() => workspace.freshness.value.blockingReason === 'terminal_clock_unavailable' ? '等待终端校准'
  : workspace.freshness.value.blockingReason === 'terminal_connection_unavailable' ? '等待智桥连接'
    : ({ empty: '等待历史数据', syncing: '历史同步中', ready: '历史已就绪', stale: '历史可能滞后', failed: '历史同步失败' })[workspace.freshness.value.status])
const hasFilters = computed(() => Object.values(filters.value).some(Boolean))
const selectedAccountLabel = computed(() => workspace.selectedAccount.value
  ? `${workspace.selectedAccount.value.platform.toUpperCase()} · ${workspace.selectedAccount.value.login}` : '尚未选择账户')
const freshnessDetail = computed(() => {
  const value = workspace.freshness.value
  if (value.blockingReason === 'terminal_clock_unavailable') return '量见智桥在线，但终端服务器时区尚未校准。历史任务会等待有效时钟，避免成交日期和统计失真。'
  if (value.blockingReason === 'terminal_connection_unavailable') return '量见智桥当前不在线；已保留历史任务，连接恢复后会自动继续。'
  if (value.status === 'syncing') return value.lastSuccessAt ? '后台正在拉取增量历史，当前仍展示最近一次已确认快照。' : '采集任务已建立，正在等待终端时钟校准后读取首批历史。'
  if (value.status === 'ready') return value.freshThrough ? `终端历史已确认至 ${new Date(value.freshThrough).toLocaleString('zh-CN', { hour12: false })}` : '终端历史已完成校验。'
  if (value.status === 'stale') return '当前展示最近一次已确认快照，后台将继续补齐。'
  if (value.status === 'failed') return '同步任务未完成，已确认的历史证据不会被覆盖。'
  return '尚未形成该账户的终端历史快照。'
})

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
      <div><div class="flex items-center gap-2 text-xs font-medium text-primary"><DatabaseZap class="size-4" />交易档案</div><h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">交易记录</h1><p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">核对已平仓交易、真实费用与决策来源。所有统计都以当前账户的终端历史证据为准。</p></div>
      <Button variant="outline" class="min-h-11 self-start xl:self-auto" :disabled="workspace.loading.value" @click="workspace.load(true)"><RefreshCw :class="workspace.loading.value ? 'animate-spin motion-reduce:animate-none' : ''" />刷新数据</Button>
    </header>

    <Alert v-if="workspace.error.value" variant="destructive" role="alert"><AlertCircle /><AlertTitle>交易记录暂时不可用</AlertTitle><AlertDescription>{{ workspace.error.value }}。不会显示本地模拟数据，也不会因此发起任何终端操作。</AlertDescription></Alert>
    <Alert v-else-if="workspace.freshness.value.status === 'failed'" variant="destructive"><AlertCircle /><AlertTitle>{{ freshnessLabel }}</AlertTitle><AlertDescription>{{ freshnessDetail }}</AlertDescription></Alert>

    <Card class="overflow-hidden shadow-none">
      <CardContent class="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div class="flex min-w-0 items-start gap-3">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><DatabaseZap class="size-5" /></span>
          <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><strong class="truncate text-base">{{ selectedAccountLabel }}</strong><Badge variant="outline"><Clock3 class="size-3.5" />{{ freshnessLabel }}</Badge></div><p class="mt-1 text-sm leading-6 text-muted-foreground">{{ freshnessDetail }}</p><p v-if="workspace.selectedAccount.value" class="mt-1 truncate text-xs text-muted-foreground">{{ workspace.selectedAccount.value.server }}</p></div>
        </div>
        <div class="flex items-center gap-2 md:justify-end"><Badge variant="secondary"><Radio class="size-3.5" /><span :class="['size-1.5 rounded-full', workspace.realtime.value === 'live' ? 'bg-system-ok' : 'bg-muted-foreground']" />{{ realtimeLabel }}</Badge><span class="text-xs tabular-nums text-muted-foreground">版本 {{ workspace.freshness.value.historyRevision }}</span></div>
      </CardContent>
    </Card>

    <TradeHistoryFilterBar v-model:account-id="accountId" v-model:filters="filters" :accounts="workspace.accounts.value" :loading="workspace.loading.value" @apply="applyFilters" @reset="resetFilters" />
    <TradeSummaryCards :summary="workspace.summary.value" :loading="workspace.loading.value" :freshness-status="workspace.freshness.value.status" />
    <TradePnlChart v-if="workspace.summary.value.tradeCount" :points="workspace.daily.value" :summary="workspace.summary.value" />
    <TradeHistoryTable :items="workspace.items.value" :loading="workspace.loading.value" :loading-more="workspace.loadingMore.value" :has-more="Boolean(workspace.nextCursor.value)" :freshness-status="workspace.freshness.value.status" :blocking-reason="workspace.freshness.value.blockingReason" :has-filters="hasFilters" @select="openDetail" @more="workspace.load(false)" @reset="resetFilters" @refresh="workspace.load(true)" />
    <TradeDetailSheet :open="detailOpen" :detail="workspace.selected.value" :loading="workspace.detailLoading.value" :error="workspace.detailError.value" @update:open="value => { if (!value) closeDetail() }" />
  </div>
</template>
