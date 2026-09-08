import { applyAccountSnapshot } from '~/features/trading-context'
import { observerChannels, tradingAccounts, tradingContext, applyTradingContext, applyTradingAccounts, applyObserverChannels, createRequestScope } from '~/features/trading-context'
import { ApiClientError, createApiClient } from '@aurum/api-client'
import { computed, ref } from 'vue'
import type { MarketAnalysisSummary, StrategySummary, Timeframe } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth'
import { accountSnapshot, clearAccountRuntime, marketCandles, marketQuote, openPositions, pendingOrders, resourceRevisions } from './home-runtime'
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
  let contextRequest = 0
  const requests = createRequestScope(() => JSON.stringify([scopeVersion, session.value?.user.id, session.value?.authenticated_at]))

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
    const request = ++contextRequest
    stop()
    const scope = scopeVersion
    const userId = session.value?.user.id
    loading.value = true; error.value = ''
    try {
      const [contextResponse, accountResponse, observerResponse] = await Promise.all([client.getTradingContext(), client.listTradingAccounts(), client.listObserverChannels(), loadLatestAnalysis(true)])
      if (scope !== scopeVersion || request !== contextRequest || userId !== session.value?.user.id) return
      applyTradingContext(contextResponse.data); applyTradingAccounts(accountResponse.data.items); applyObserverChannels(observerResponse.data.items)
      const context = contextResponse.data
      const observer = context.mode === 'observer' ? observerChannels.value.find((item) => item.id === context.observerChannelId) : null
      if (context.mode === 'observer' && !observer) throw new Error('当前观摩授权已失效，请退出观摩后重新选择')
      const selected = observer?.sourceAccountId ?? context.accountId ?? tradingAccounts.value[0]?.id ?? null
      if (!selected) { activeAccountId.value = null; clearAccountRuntime(); return }
      if (context.mode !== 'observer' && selected !== context.accountId && session.value) {
        const selectedContext = (await client.selectTradingAccount(session.value.csrf_token, selected, context.revision)).data
        if (scope !== scopeVersion || request !== contextRequest || userId !== session.value?.user.id) return
        applyTradingContext(selectedContext)
      }
      await loadAccount(selected, true, observer?.id ?? null)
    } catch (reason) {
      if (request !== contextRequest) return
      error.value = reason instanceof Error ? reason.message : '交易工作区加载失败'
      clearAccountRuntime()
    } finally { if (request === contextRequest) loading.value = false }
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
    applyAccountSnapshot(workspace.snapshot); openPositions.value = workspace.positions.items; pendingOrders.value = workspace.pendingOrders.items
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
    const { csrf_token } = session.value
    const revision = tradingContext.value.revision
    await changeContext(() => client.selectTradingAccount(csrf_token, accountId, revision), accountId, null)
  }

  async function selectObserver(observerChannelId: string) {
    if (!session.value || !tradingContext.value) return
    const channel = observerChannels.value.find((item) => item.id === observerChannelId && item.active)
    if (!channel) return
    const { csrf_token } = session.value
    const revision = tradingContext.value.revision
    await changeContext(() => client.enterObserverMode(csrf_token, observerChannelId, revision), channel.sourceAccountId, observerChannelId)
  }

  async function leaveObserver() {
    if (!session.value || !tradingContext.value || tradingContext.value.mode !== 'observer') return
    const { csrf_token } = session.value
    const revision = tradingContext.value.revision
    await changeContext(() => client.leaveObserverMode(csrf_token, revision), null, null)
  }

  async function changeContext(
    write: () => ReturnType<typeof client.getTradingContext>, accountId: string | null, observerChannelId: string | null,
  ) {
    const request = ++contextRequest
    stop(); clearAccountRuntime(); activeAccountId.value = null
    const scope = scopeVersion
    const userId = session.value?.user.id
    loading.value = true; error.value = ''
    try {
      const result = await write()
      if (request !== contextRequest || scope !== scopeVersion || userId !== session.value?.user.id) return
      applyTradingContext(result.data)
      const selected = accountId ?? result.data.accountId
      if (selected) await loadAccount(selected, true, observerChannelId)
    } catch (reason) {
      if (request === contextRequest) error.value = reason instanceof Error ? reason.message : '切换失败，请刷新后重试'
      throw reason
    } finally { if (request === contextRequest) loading.value = false }
  }

  async function selectSymbol(value: string) { symbol.value = value; await loadMarket() }
  async function selectTimeframe(value: Timeframe) { timeframe.value = value; await loadMarket() }

  async function loadLatestAnalysis(includeStrategies = false) {
    const current = requests.begin('analysis')
    const currentStrategies = includeStrategies ? requests.begin('analysis-strategies') : null
    analysisLoading.value = true
    analysisError.value = ''
    try {
      const [analyses, strategies] = await Promise.all([
        client.listMarketAnalyses(1),
        includeStrategies ? client.listStrategies('analysis') : Promise.resolve(null),
      ])
      if (strategies && currentStrategies?.()) analysisStrategies.value = strategies.data.items
      if (!current()) return
      latestAnalysis.value = analyses.data.items[0] ?? null
    } catch (reason) {
      if (current()) analysisError.value = reason instanceof Error ? reason.message : '最新分析暂时无法读取'
    } finally { if (current()) analysisLoading.value = false }
  }

  return { loading, error, symbol, symbols, timeframe, marketHistoryVersion, accounts: tradingAccounts, observers: observerChannels, context: tradingContext,
    snapshot: accountSnapshot, quote: marketQuote, candles: marketCandles, positions: openPositions, pendingOrders,
    latestAnalysis, analysisStrategies, analysisLoading, analysisError,
    hasAccount: computed(() => Boolean(activeAccountId.value)), load, selectAccount, selectObserver, leaveObserver, selectSymbol, selectTimeframe, stop }
}
