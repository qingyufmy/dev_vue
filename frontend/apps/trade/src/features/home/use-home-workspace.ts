import { runContextCommand, recoverContextCommand, contextCommandState } from '~/features/trading-context'
import { applyAccountSnapshot } from '~/features/trading-context'
import { observerChannels, tradingAccounts, tradingContext, applyTradingContext, applyTradingAccounts, applyObserverChannels, createRequestScope } from '~/features/trading-context'
import { ApiClientError, createApiClient } from '@aurum/api-client'
import { computed, ref, watch } from 'vue'
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
  const requests = createRequestScope(() => JSON.stringify([scopeVersion, session.value?.user.id, session.value?.authenticated_at]))

  function stop() {
    scopeVersion += 1
    loading.value = false
    analysisLoading.value = false
    stopTradingRealtime()
  }

  function clearForbiddenSnapshot(reason: unknown, scope: number) {
    if (scope === scopeVersion && reason instanceof ApiClientError && (reason.status === 401 || reason.status === 403)) {
      clearAccountRuntime()
      error.value = '当前数据访问权限已失效，请重新选择账户或观摩频道'
    }
  }

  async function load() {
    stop()
    const current = requests.begin('context')
    loading.value = true; error.value = ''
    try {
      if (session.value) await recoverContextCommand(session.value)
      if (!current()) return
      const [contextResponse, accountResponse, observerResponse] = await Promise.all([client.getTradingContext(), client.listTradingAccounts(), client.listObserverChannels(), loadLatestAnalysis(true)])
      if (!current()) return
      applyTradingContext(contextResponse.data); applyTradingAccounts(accountResponse.data.items); applyObserverChannels(observerResponse.data.items)
      const context = contextResponse.data
      let observer = context.mode === 'observer' ? observerChannels.value.find((item) => item.id === context.observerChannelId) : null
      if (context.mode === 'observer' && !observer) throw new Error('当前观摩授权已失效，请退出观摩后重新选择')
      let selected = observer?.sourceAccountId ?? context.accountId ?? tradingAccounts.value[0]?.id ?? null
      if (!selected) { activeAccountId.value = null; clearAccountRuntime(); return }
      if (context.mode !== 'observer' && selected !== context.accountId && session.value) {
        const selectedContext = (await runContextCommand(session.value, 'select_account', selected, context.revision)).data
        if (!current()) return
        applyTradingContext(selectedContext)
        observer = selectedContext.mode === 'observer' ? observerChannels.value.find(item => item.id === selectedContext.observerChannelId && item.active) : null
        selected = observer?.sourceAccountId ?? selectedContext.accountId
        if (!selected) { activeAccountId.value = null; clearAccountRuntime(); return }
      }
      await loadAccount(selected, true, observer?.id ?? null)
    } catch (reason) {
      if (!current()) return
      error.value = reason instanceof Error ? reason.message : '交易工作区加载失败'
      clearAccountRuntime()
    } finally { if (current()) loading.value = false }
  }

  async function loadAccount(accountId: string, reset = true, observerChannelId: string | null = tradingContext.value?.mode === 'observer' ? tradingContext.value.observerChannelId ?? null : null) {
    if (reset) clearAccountRuntime()
    const current = requests.begin('account-load')
    const scope = scopeVersion
    activeAccountId.value = accountId
    await syncAccountSnapshot(accountId, observerChannelId, scope)
    if (!current()) return
    if (session.value && symbol.value) await startTradingRealtime(session.value, accountId, symbol.value, timeframe.value, observerChannelId, () => syncAccountSnapshot(accountId, observerChannelId, scope), () => { void loadLatestAnalysis() })
  }

  async function syncAccountSnapshot(accountId: string, observerChannelId: string | null, scope = scopeVersion) {
    if (scope !== scopeVersion) return
    const current = requests.begin('snapshot')
    let workspace: Awaited<ReturnType<typeof client.getTradingWorkspace>>['data']
    try { workspace = (await client.getTradingWorkspace(accountId, observerChannelId)).data }
    catch (reason) {
      if (!current()) return
      clearForbiddenSnapshot(reason, scope)
      throw reason
    }
    if (!current()) return
    error.value = ''
    applyAccountSnapshot(workspace.snapshot); openPositions.value = workspace.positions.items; pendingOrders.value = workspace.pendingOrders.items
    resourceRevisions.value.account = workspace.snapshot?.revision ?? 0; resourceRevisions.value.positions = workspace.positions.revision; resourceRevisions.value.pendingOrders = workspace.pendingOrders.revision
    symbols.value = workspace.symbols
    if (!symbol.value || !workspace.symbols.includes(symbol.value)) symbol.value = workspace.symbols[0] ?? ''
    if (symbol.value) await loadMarket(accountId, false, observerChannelId, scope)
  }

  async function loadMarket(accountId = activeAccountId.value ?? '', reconnect = true, observerChannelId: string | null = tradingContext.value?.mode === 'observer' ? tradingContext.value.observerChannelId ?? null : null, scope = scopeVersion) {
    if (!accountId || !symbol.value || scope !== scopeVersion) return
    const current = requests.begin('market')
    const requestedSymbol = symbol.value
    const requestedTimeframe = timeframe.value
    const result = await Promise.all([
      client.getMarketQuote(accountId, requestedSymbol, observerChannelId), client.getMarketCandles(accountId, requestedSymbol, requestedTimeframe, 200, observerChannelId),
    ]).catch(reason => { if (!current()) return null; clearForbiddenSnapshot(reason, scope); throw reason })
    if (!result || !current() || accountId !== activeAccountId.value
      || requestedSymbol !== symbol.value || requestedTimeframe !== timeframe.value) return
    const [quote, candles] = result
    marketQuote.value = quote.data; marketCandles.value = candles.data.items; marketHistoryVersion.value += 1
    resourceRevisions.value.quote = quote.data?.revision ?? 0; resourceRevisions.value.candle = candles.data.items.at(-1)?.revision ?? 0
    if (reconnect && session.value) await startTradingRealtime(session.value, accountId, symbol.value, timeframe.value, observerChannelId, () => syncAccountSnapshot(accountId, observerChannelId, scope), () => { void loadLatestAnalysis() })
  }

  async function selectAccount(accountId: string) {
    if (contextCommandState.value.busy) return
    if (!session.value || !tradingContext.value || (tradingContext.value.mode === 'full' && accountId === tradingContext.value.accountId)) return
    const commandSession = session.value
    const revision = tradingContext.value.revision
    await changeContext(() => runContextCommand(commandSession, 'select_account', accountId, revision))
  }

  async function selectObserver(observerChannelId: string) {
    if (contextCommandState.value.busy) return
    if (!session.value || !tradingContext.value) return
    const channel = observerChannels.value.find((item) => item.id === observerChannelId && item.active)
    if (!channel) return
    const commandSession = session.value
    const revision = tradingContext.value.revision
    await changeContext(() => runContextCommand(commandSession, 'enter_observer', observerChannelId, revision))
  }

  async function leaveObserver() {
    if (contextCommandState.value.busy) return
    if (!session.value || !tradingContext.value || tradingContext.value.mode !== 'observer') return
    const commandSession = session.value
    const revision = tradingContext.value.revision
    await changeContext(() => runContextCommand(commandSession, 'leave_observer', null, revision))
  }

  async function changeContext(
    write: () => ReturnType<typeof runContextCommand>,
  ) {
    stop(); clearAccountRuntime(); activeAccountId.value = null
    const current = requests.begin('context')
    loading.value = true; error.value = ''
    try {
      const result = await write()
      if (!current()) return
      applyTradingContext(result.data)
      const observer = result.data.mode === 'observer' ? observerChannels.value.find(item => item.id === result.data.observerChannelId && item.active) : null
      if (result.data.mode === 'observer' && !observer) throw new Error('当前观摩授权已失效，请重新读取账户')
      const selected = observer?.sourceAccountId ?? result.data.accountId
      if (selected) await loadAccount(selected, true, observer?.id ?? null)
    } catch (reason) {
      if (!current()) return
      error.value = reason instanceof Error ? reason.message : '切换失败，请刷新后重试'
      throw reason
    } finally { if (current()) loading.value = false }
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

  watch(() => session.value, () => {
    stop()
    clearAccountRuntime()
    applyTradingContext(null); applyTradingAccounts([]); applyObserverChannels([])
    activeAccountId.value = null
    symbol.value = ''; symbols.value = []
    latestAnalysis.value = null; analysisStrategies.value = []
    error.value = ''; analysisError.value = ''
    if (session.value) void load()
  }, { flush: 'sync' })

  return { loading, error, symbol, symbols, timeframe, marketHistoryVersion, accounts: tradingAccounts, observers: observerChannels, context: tradingContext,
    snapshot: accountSnapshot, quote: marketQuote, candles: marketCandles, positions: openPositions, pendingOrders,
    latestAnalysis, analysisStrategies, analysisLoading, analysisError,
    hasAccount: computed(() => Boolean(activeAccountId.value)), load, selectAccount, selectObserver, leaveObserver, selectSymbol, selectTimeframe, stop }
}
