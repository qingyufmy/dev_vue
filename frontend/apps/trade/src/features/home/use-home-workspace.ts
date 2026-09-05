import { ApiClientError, createApiClient } from '@aurum/api-client'
import { computed, ref } from 'vue'
import type { MarketAnalysisSummary, StrategySummary, Timeframe } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth/session'
import { accountSnapshot, clearAccountRuntime, marketCandles, marketQuote, observerChannels, openPositions, pendingOrders, resourceRevisions, tradingAccounts, tradingContext } from './home-runtime'
import { startTradingRealtime, stopTradingRealtime } from './trading-realtime'

const client = createApiClient()

export function useHomeWorkspace() {
  const loading = ref(false)
  const error = ref('')
  const symbol = ref('')
  const symbols = ref<string[]>([])
  const timeframe = ref<Timeframe>('M5')
  const marketHistoryVersion = ref(0)
  const activeAccountId = ref<string | null>(null)
  const latestAnalysis = ref<MarketAnalysisSummary | null>(null)
  const analysisStrategies = ref<StrategySummary[]>([])
  const analysisLoading = ref(false)
  const analysisError = ref('')
  const { session } = useTradeSession()
  let scopeVersion = 0
  let snapshotRequest = 0
  let marketRequest = 0

  function stop() {
    scopeVersion += 1
    stopTradingRealtime()
  }

  function clearForbiddenSnapshot(reason: unknown, scope: number) {
    if (scope === scopeVersion && reason instanceof ApiClientError && (reason.status === 401 || reason.status === 403)) {
      clearAccountRuntime()
      error.value = '当前数据访问权限已失效，请重新选择账户或观摩频道'
    }
  }

  async function load() {
    loading.value = true; error.value = ''
    try {
      const [contextResponse, accountResponse, observerResponse] = await Promise.all([client.getTradingContext(), client.listTradingAccounts(), client.listObserverChannels(), loadLatestAnalysis(true)])
      tradingContext.value = contextResponse.data; tradingAccounts.value = accountResponse.data.items; observerChannels.value = observerResponse.data.items
      const observer = tradingContext.value.mode === 'observer' ? observerChannels.value.find((item) => item.id === tradingContext.value?.observerChannelId) : null
      if (tradingContext.value.mode === 'observer' && !observer) throw new Error('当前观摩授权已失效，请退出观摩后重新选择')
      const selected = observer?.sourceAccountId ?? tradingContext.value.accountId ?? tradingAccounts.value[0]?.id ?? null
      if (!selected) { activeAccountId.value = null; clearAccountRuntime(); return }
      if (tradingContext.value.mode !== 'observer' && selected !== tradingContext.value.accountId && session.value) {
        tradingContext.value = (await client.selectTradingAccount(session.value.csrf_token, selected, tradingContext.value.revision)).data
      }
      await loadAccount(selected, true, observer?.id ?? null)
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '交易工作区加载失败'
      clearAccountRuntime()
    } finally { loading.value = false }
  }

  async function loadAccount(accountId: string, reset = true, observerChannelId: string | null = tradingContext.value?.mode === 'observer' ? tradingContext.value.observerChannelId ?? null : null) {
    stop(); if (reset) clearAccountRuntime()
    const scope = scopeVersion
    activeAccountId.value = accountId
    await syncAccountSnapshot(accountId, observerChannelId, scope)
    if (scope !== scopeVersion) return
    if (session.value && symbol.value) await startTradingRealtime(session.value, accountId, symbol.value, timeframe.value, observerChannelId, () => syncAccountSnapshot(accountId, observerChannelId, scope), () => { void loadLatestAnalysis() })
  }

  async function syncAccountSnapshot(accountId: string, observerChannelId: string | null, scope = scopeVersion) {
    if (scope !== scopeVersion) return
    const request = ++snapshotRequest
    const userId = session.value?.user.id
    let workspace: Awaited<ReturnType<typeof client.getTradingWorkspace>>['data']
    try { workspace = (await client.getTradingWorkspace(accountId, observerChannelId)).data }
    catch (reason) {
      if (request === snapshotRequest) clearForbiddenSnapshot(reason, scope)
      throw reason
    }
    if (scope !== scopeVersion || request !== snapshotRequest || session.value?.user.id !== userId) return
    error.value = ''
    accountSnapshot.value = workspace.snapshot; openPositions.value = workspace.positions.items; pendingOrders.value = workspace.pendingOrders.items
    resourceRevisions.value.account = workspace.snapshot?.revision ?? 0; resourceRevisions.value.positions = workspace.positions.revision; resourceRevisions.value.pendingOrders = workspace.pendingOrders.revision
    symbols.value = workspace.symbols
    if (!symbol.value || !workspace.symbols.includes(symbol.value)) symbol.value = workspace.symbols[0] ?? ''
    if (symbol.value) await loadMarket(accountId, false, observerChannelId, scope)
  }

  async function loadMarket(accountId = activeAccountId.value ?? '', reconnect = true, observerChannelId: string | null = tradingContext.value?.mode === 'observer' ? tradingContext.value.observerChannelId ?? null : null, scope = scopeVersion) {
    if (!accountId || !symbol.value || scope !== scopeVersion) return
    const request = ++marketRequest
    const requestedSymbol = symbol.value
    const requestedTimeframe = timeframe.value
    const userId = session.value?.user.id
    const [quote, candles] = await Promise.all([
      client.getMarketQuote(accountId, requestedSymbol, observerChannelId), client.getMarketCandles(accountId, requestedSymbol, requestedTimeframe, 200, observerChannelId),
    ]).catch(reason => { if (request === marketRequest) clearForbiddenSnapshot(reason, scope); throw reason })
    if (scope !== scopeVersion || request !== marketRequest || accountId !== activeAccountId.value
      || requestedSymbol !== symbol.value || requestedTimeframe !== timeframe.value || session.value?.user.id !== userId) return
    marketQuote.value = quote.data; marketCandles.value = candles.data.items; marketHistoryVersion.value += 1
    resourceRevisions.value.quote = quote.data?.revision ?? 0; resourceRevisions.value.candle = candles.data.items.at(-1)?.revision ?? 0
    if (reconnect && session.value) await startTradingRealtime(session.value, accountId, symbol.value, timeframe.value, observerChannelId, () => syncAccountSnapshot(accountId, observerChannelId, scope), () => { void loadLatestAnalysis() })
  }

  async function selectAccount(accountId: string) {
    if (!session.value || !tradingContext.value || (tradingContext.value.mode === 'full' && accountId === tradingContext.value.accountId)) return
    loading.value = true
    try {
      tradingContext.value = (await client.selectTradingAccount(session.value.csrf_token, accountId, tradingContext.value.revision)).data
      await loadAccount(accountId)
    } finally { loading.value = false }
  }

  async function selectObserver(observerChannelId: string) {
    if (!session.value || !tradingContext.value) return
    const channel = observerChannels.value.find((item) => item.id === observerChannelId && item.active)
    if (!channel) return
    loading.value = true
    try {
      tradingContext.value = (await client.enterObserverMode(session.value.csrf_token, observerChannelId, tradingContext.value.revision)).data
      await loadAccount(channel.sourceAccountId, true, observerChannelId)
    } finally { loading.value = false }
  }

  async function leaveObserver() {
    if (!session.value || !tradingContext.value || tradingContext.value.mode !== 'observer') return
    loading.value = true
    try {
      tradingContext.value = (await client.leaveObserverMode(session.value.csrf_token, tradingContext.value.revision)).data
      const accountId = tradingContext.value.accountId
      if (accountId) await loadAccount(accountId)
      else { stop(); activeAccountId.value = null; clearAccountRuntime() }
    } finally { loading.value = false }
  }

  async function selectSymbol(value: string) { symbol.value = value; await loadMarket() }
  async function selectTimeframe(value: Timeframe) { timeframe.value = value; await loadMarket() }

  async function loadLatestAnalysis(includeStrategies = false) {
    analysisLoading.value = true
    analysisError.value = ''
    try {
      const [analyses, strategies] = await Promise.all([
        client.listMarketAnalyses(1),
        includeStrategies ? client.listStrategies('analysis') : Promise.resolve(null),
      ])
      latestAnalysis.value = analyses.data.items[0] ?? null
      if (strategies) analysisStrategies.value = strategies.data.items
    } catch (reason) {
      analysisError.value = reason instanceof Error ? reason.message : '最新分析暂时无法读取'
    } finally { analysisLoading.value = false }
  }

  return { loading, error, symbol, symbols, timeframe, marketHistoryVersion, accounts: tradingAccounts, observers: observerChannels, context: tradingContext,
    snapshot: accountSnapshot, quote: marketQuote, candles: marketCandles, positions: openPositions, pendingOrders,
    latestAnalysis, analysisStrategies, analysisLoading, analysisError,
    hasAccount: computed(() => Boolean(activeAccountId.value)), load, selectAccount, selectObserver, leaveObserver, selectSymbol, selectTimeframe, stop }
}
