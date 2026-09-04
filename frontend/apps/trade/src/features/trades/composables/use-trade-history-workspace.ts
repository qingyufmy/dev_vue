import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { TradeHistoryRecord, TradeHistorySummary, TradeRecordDetail, TradingAccount } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth/session'
import { tradeHistoryApi } from '../api/trade-history-api'
import { createTradeHistoryRealtime, type TradeHistoryRealtimeState } from '../realtime/trade-history-realtime'
import type { TradeHistoryFilters } from '../model/trade-history-presentation'

const emptySummary: TradeHistorySummary = { tradeCount: 0, winningCount: 0, losingCount: 0, breakevenCount: 0, winRatePercent: null, grossProfit: '0', commission: '0', swap: '0', fee: '0', netProfit: '0', profitFactor: null }

export function useTradeHistoryWorkspace(accountId: Ref<string>, filters: Ref<TradeHistoryFilters>) {
  const { session } = useTradeSession(); const accounts = ref<TradingAccount[]>([]); const items = ref<TradeHistoryRecord[]>([]); const summary = ref(emptySummary)
  const daily = ref<Array<{ businessDate: string; tradeCount: number; netProfit: string; cumulativeNetProfit: string }>>([])
  const freshness = ref<{ status: 'empty' | 'syncing' | 'ready' | 'stale' | 'failed'; historyRevision: number; freshThrough: string | null; lastSuccessAt: string | null }>({ status: 'empty', historyRevision: 0, freshThrough: null, lastSuccessAt: null })
  const selected = ref<TradeRecordDetail | null>(null); const nextCursor = ref<string | null>(null); const loading = ref(false); const loadingMore = ref(false); const detailLoading = ref(false); const error = ref(''); const detailError = ref(''); const realtime = ref<TradeHistoryRealtimeState>('idle')
  let generation = 0; let detailGeneration = 0; let realtimeController: ReturnType<typeof createTradeHistoryRealtime> | null = null; let refreshTimer: number | null = null
  const selectedAccount = computed(() => accounts.value.find((item) => item.id === accountId.value) ?? null)

  async function initialise() {
    loading.value = true; error.value = ''
    try {
      const [context, list] = await Promise.all([tradeHistoryApi.getContext(), tradeHistoryApi.listAccounts()]); accounts.value = list.data.items
      if (!accounts.value.some((item) => item.id === accountId.value)) accountId.value = context.data.accountId && accounts.value.some((item) => item.id === context.data.accountId) ? context.data.accountId : accounts.value[0]?.id ?? ''
      if (accountId.value) await load(true)
    } catch (reason) { error.value = readable(reason, '交易记录暂时无法读取') } finally { loading.value = false }
  }

  async function load(reset = true) {
    if (!accountId.value) return
    const current = ++generation; if (reset) loading.value = true; else loadingMore.value = true; error.value = ''
    try {
      const value = filters.value
      const response = await tradeHistoryApi.list({ accountId: accountId.value, ...(value.symbol ? { symbol: value.symbol } : {}), ...(value.side ? { side: value.side } : {}), ...(value.source ? { source: value.source } : {}), ...(value.outcome ? { outcome: value.outcome } : {}), ...(value.from ? { fromDate: value.from } : {}), ...(value.to ? { toDate: value.to } : {}), ...(value.query ? { query: value.query } : {}), cursor: reset ? null : nextCursor.value, pageSize: 50 })
      if (current !== generation) return
      items.value = reset ? response.data.items : [...items.value, ...response.data.items]; nextCursor.value = response.data.nextCursor; summary.value = response.data.summary; daily.value = response.data.daily; freshness.value = response.data.freshness
    } catch (reason) { if (current === generation) error.value = readable(reason, '交易记录读取失败') } finally { if (current === generation) { loading.value = false; loadingMore.value = false } }
  }

  async function loadDetail(id: string) { const current = ++detailGeneration; detailLoading.value = true; detailError.value = ''; selected.value = null; try { const response = await tradeHistoryApi.detail(id); if (current === detailGeneration) selected.value = response.data } catch (reason) { if (current === detailGeneration) detailError.value = readable(reason, '交易详情读取失败') } finally { if (current === detailGeneration) detailLoading.value = false } }
  function closeDetail() { selected.value = null; detailError.value = ''; detailGeneration += 1 }
  function connectRealtimeForAccount() { realtimeController?.stop(); realtimeController = null; if (!session.value || !accountId.value) return; realtimeController = createTradeHistoryRealtime({ session: session.value, accountId: accountId.value, onState: value => { realtime.value = value }, onChanged: () => { if (refreshTimer !== null) clearTimeout(refreshTimer); refreshTimer = window.setTimeout(() => void load(true), 350) }, resync: () => load(true) }) }
  watch(accountId, () => { items.value = []; nextCursor.value = null; selected.value = null; void load(true); connectRealtimeForAccount() })
  onMounted(() => void initialise().then(connectRealtimeForAccount)); onBeforeUnmount(() => { realtimeController?.stop(); if (refreshTimer !== null) clearTimeout(refreshTimer) })
  return { accounts, selectedAccount, items, summary, daily, freshness, selected, nextCursor, loading, loadingMore, detailLoading, error, detailError, realtime, load, loadDetail, closeDetail }
}

function readable(reason: unknown, fallback: string) { return reason instanceof Error && reason.message ? reason.message : fallback }
