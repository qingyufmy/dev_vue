import { applyPublicSnapshot, mergePublicHistory } from './public-market-state'
import { preferredOnlineAccount, runContextCommand, recoverContextCommand, contextCommandState } from '~/features/trading-context'
import { applyAccountSnapshot, activeMarketSymbol, applyTerminalMarketObservation } from '~/features/trading-context'
import { applyPublicDisplayClock, observerChannels, tradingAccounts, tradingContext, applyTradingContext, applyTradingAccounts, applyObserverChannels, createRequestScope } from '~/features/trading-context'
import { ApiClientError, createApiClient } from '@aurum/api-client'
import { computed, reactive, ref, watch } from 'vue'
import type { MarketAnalysisSummary, StrategySummary, TerminalMarketSymbol, Timeframe } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth'
import { accountSnapshot, marketSourceKey, clearAccountRuntime, marketCandles, marketQuote, marketStructure, openPositions, pendingOrders, resourceRevisions } from './home-runtime'
import { startTradingRealtime, stopTradingRealtime } from './trading-realtime'
import { preferredGoldSymbol } from './terminal-market-workspace'
import { applyTerminalMarketSnapshot, mergeTerminalMarketHistory } from './terminal-market-state'
import { defaultStructureLayers, readHomePreferences, writeHomePreferences, type StructureLayers } from './home-preferences'

const client = createApiClient()

export function useHomeWorkspace() {
  const loading = ref(false)
  const error = ref('')
  const marketLoading = ref(false)
  const marketError = ref('')
  const symbol = ref('')
  watch(symbol, value => { if (value) activeMarketSymbol.value = value })
  const symbols = ref<string[]>([])
  const timeframe = ref<Timeframe>('M5')
  const chartLayers = reactive(defaultStructureLayers())
  const marketHistoryVersion = ref(0)
  const historyLoading = ref(false)
  const historyMessage = ref('')
  const symbolDirectoryNotice = ref('')
  let publicSymbolCatalog = new Set<string>()
  let terminalDirectoryAccount = ''
  let terminalDirectory: TerminalMarketSymbol[] = []
  let terminalDirectoryRetryAt = 0
  let exhaustedBefore = ''
  let historyRetryAt = 0
  let preferenceScope = ''

  function restorePreferences(accountId: string, observerChannelId: string | null) {
    preferenceScope = observerChannelId ? `observer:${observerChannelId}` : `account:${accountId}`
    const userId = String(session.value?.user.id ?? '')
    let stored = null
    try { if (userId) stored = readHomePreferences(localStorage, userId, preferenceScope) } catch { /* Storage is optional. */ }
    symbol.value = stored?.symbol ?? ''
    timeframe.value = stored?.timeframe ?? 'M5'
    Object.assign(chartLayers, stored?.layers ?? defaultStructureLayers())
  }

  function persistPreferences() {
    const userId = String(session.value?.user.id ?? '')
    if (!userId || !preferenceScope) return
    try { writeHomePreferences(localStorage, userId, preferenceScope, {
      symbol: symbol.value, timeframe: timeframe.value, layers: { ...chartLayers },
    }) } catch { /* Storage is optional. */ }
  }
  async function loadOlderHistory() {
    const before = marketCandles.value[0]?.openTime
    if (Date.now() < historyRetryAt || !before || historyLoading.value || exhaustedBefore === before || marketLoading.value) return
    const current = requests.begin('older-history'), source = marketSourceKey.value
    const requestedSymbol = symbol.value, requestedTimeframe = timeframe.value
    historyLoading.value = true; historyMessage.value = ''; historyRetryAt = Date.now() + 750
    try {
      if (source?.startsWith('terminal:') && activeAccountId.value) {
        const result = await client.getTerminalMarketWindow(activeAccountId.value, requestedSymbol, requestedTimeframe, Date.parse(before), 200)
        if (!current() || requestedSymbol !== symbol.value || requestedTimeframe !== timeframe.value || source !== marketSourceKey.value) return
        if (!result.data.items.length) { exhaustedBefore = before; historyMessage.value = '已到终端可读取的最早历史'; return }
        mergeTerminalMarketHistory(activeAccountId.value, requestedSymbol, requestedTimeframe, result.data.items, result.data.structure)
        marketHistoryVersion.value += 1
        return
      }
      const result = await client.getPublicMarketSnapshot(requestedSymbol, requestedTimeframe, 200, before)
      if (!current() || requestedSymbol !== symbol.value || requestedTimeframe !== timeframe.value || source !== marketSourceKey.value) return
      if (result.data.source_key !== source) { await refreshMarket(); return }
      if (!result.data.candles.length) { exhaustedBefore = before; historyMessage.value = '已到当前缓存最早历史'; return }
      mergePublicHistory(result.data)
      marketHistoryVersion.value += 1
    } catch { if (current()) { historyRetryAt = Date.now() + 3000; historyMessage.value = '历史加载失败，可重试' } }
    finally { historyLoading.value = false }
  }
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
    marketLoading.value = false
    stopTradingRealtime()
    applyTerminalMarketObservation(null)
  }

  function clearForbiddenSnapshot(reason: unknown, scope: number) {
    if (scope === scopeVersion && reason instanceof ApiClientError && (reason.status === 401 || reason.status === 403)) {
      stop()
      clearAccountRuntime()
      activeAccountId.value = null
      symbol.value = ''; symbols.value = []
      error.value = '当前数据访问权限已失效，请重新选择账户或观摩频道'
    }
  }

  async function load() {
    stop()
    terminalDirectoryAccount = ''; terminalDirectory = []; terminalDirectoryRetryAt = 0; publicSymbolCatalog = new Set()
    const current = requests.begin('context')
    loading.value = true; error.value = ''; marketError.value = ''
    try {
      if (session.value) await recoverContextCommand(session.value)
      if (!current()) return
      const [contextResponse, accountResponse, observerResponse, strategiesResponse] = await Promise.all([
        client.getTradingContext(), client.listTradingAccounts(), client.listObserverChannels(), client.listStrategies('analysis').catch(() => null),
      ])
      if (!current()) return
      applyTradingContext(contextResponse.data); applyTradingAccounts(accountResponse.data.items); applyObserverChannels(observerResponse.data.items)
      if (strategiesResponse) analysisStrategies.value = strategiesResponse.data.items
      const context = contextResponse.data
      let observer = context.mode === 'observer' ? observerChannels.value.find((item) => item.id === context.observerChannelId && item.active) : null
      if (context.mode === 'observer' && !observer) throw new Error('当前观摩授权已失效，请退出观摩后重新选择')
      let selected = observer?.sourceAccountId ?? preferredOnlineAccount(tradingAccounts.value, context.accountId)
      if (!selected) { activeAccountId.value = null; clearAccountRuntime(); await Promise.all([loadMarket('', true, null), loadLatestAnalysis()]); return }
      if (context.mode !== 'observer' && selected !== context.accountId && session.value) {
        const selectedContext = (await runContextCommand(session.value, 'select_account', selected, context.revision)).data
        if (!current()) return
        applyTradingContext(selectedContext)
        observer = selectedContext.mode === 'observer' ? observerChannels.value.find(item => item.id === selectedContext.observerChannelId && item.active) : null
        selected = observer?.sourceAccountId ?? selectedContext.accountId
        if (!selected) { activeAccountId.value = null; clearAccountRuntime(); await Promise.all([loadMarket('', true, null), loadLatestAnalysis()]); return }
      }
      await loadAccount(selected, true, observer?.id ?? null)
    } catch (reason) {
      if (!current()) return
      error.value = workspaceError(reason, '交易工作区暂时无法读取，请刷新重试')
      clearAccountRuntime()
      activeAccountId.value = null
    } finally { if (current()) loading.value = false }
  }

  async function loadAccount(accountId: string, reset = true, observerChannelId: string | null = tradingContext.value?.mode === 'observer' ? tradingContext.value.observerChannelId ?? null : null) {
    if (reset) clearAccountRuntime()
    const current = requests.begin('account-load')
    const scope = scopeVersion
    activeAccountId.value = accountId
    restorePreferences(accountId, observerChannelId)
    await syncAccountSnapshot(accountId, observerChannelId, scope)
    if (!current()) return
    await loadLatestAnalysis()
    if (session.value && symbol.value) await startTradingRealtime(session.value, accountId, symbol.value, timeframe.value, observerChannelId, () => syncAccountSnapshot(accountId, observerChannelId, scope), () => { void loadLatestAnalysis() }, marketSource(accountId, observerChannelId))
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
    await loadMarket(accountId, false, observerChannelId, scope)
  }

  async function loadMarket(accountId = activeAccountId.value ?? '', reconnect = true, observerChannelId: string | null = tradingContext.value?.mode === 'observer' ? tradingContext.value.observerChannelId ?? null : null, scope = scopeVersion) {
    if (scope !== scopeVersion) return
    const current = requests.begin('market')
    marketError.value = ''
    const [publicResult, terminalResult] = await Promise.allSettled([
      client.getPublicMarketSymbols(),
      accountId && observerChannelId === null && (terminalDirectoryAccount !== accountId || !terminalDirectory.length && Date.now() >= terminalDirectoryRetryAt)
        ? client.getTerminalMarketSymbols(accountId)
        : Promise.resolve(null),
    ])
    if (!current()) return
    if (publicResult.status === 'fulfilled') {
      applyPublicDisplayClock(publicResult.value.data.timezone ?? null)
      publicSymbolCatalog = new Set(publicResult.value.data.items)
    } else if (!accountId || observerChannelId !== null) throw publicResult.reason
    if (terminalResult.status === 'fulfilled' && terminalResult.value) {
      terminalDirectoryAccount = accountId
      terminalDirectory = terminalResult.value.data.items
      terminalDirectoryRetryAt = 0
      symbolDirectoryNotice.value = ''
    } else if (terminalResult.status === 'rejected') {
      terminalDirectoryAccount = accountId
      terminalDirectory = []
      terminalDirectoryRetryAt = Date.now() + 5_000
      symbolDirectoryNotice.value = '终端品种同步失败，当前仅显示平台公共品种'
    }
    if (!accountId || observerChannelId !== null) symbolDirectoryNotice.value = ''
    const terminalSymbols = terminalDirectoryAccount === accountId
      ? terminalDirectory.filter(item => item.trade_mode !== 0).map(item => item.symbol)
      : []
    symbols.value = [...new Set([...publicSymbolCatalog, ...terminalSymbols])]
    if (!symbols.value.includes(symbol.value)) {
      const preferred = terminalSymbols.length ? preferredGoldSymbol(terminalDirectory) : null
      symbol.value = symbols.value.includes('XAUUSD') ? 'XAUUSD'
        : preferred && symbols.value.includes(preferred) ? preferred : symbols.value[0] ?? ''
    }
    if (!symbol.value) return
    persistPreferences()
    const requestedSymbol = symbol.value, requestedTimeframe = timeframe.value
    const source = marketSource(accountId, observerChannelId)
    if (source === 'terminal') {
      const [windowResult, quoteResult] = await Promise.all([
        client.getTerminalMarketWindow(accountId, requestedSymbol, requestedTimeframe, Date.now(), 500),
        client.getMarketQuote(accountId, requestedSymbol).catch(() => ({ data: null })),
      ])
      if (!current() || requestedSymbol !== symbol.value || requestedTimeframe !== timeframe.value) return
      exhaustedBefore = ''; historyMessage.value = ''
      applyTerminalMarketSnapshot({ accountId, symbol: requestedSymbol, timeframe: requestedTimeframe, candles: windowResult.data.items, quote: quoteResult.data, structure: windowResult.data.structure })
      marketHistoryVersion.value += 1
      if (reconnect && session.value) await startTradingRealtime(session.value, accountId, requestedSymbol, requestedTimeframe, observerChannelId,
        () => syncAccountSnapshot(accountId, observerChannelId, scope), () => { void loadLatestAnalysis() }, 'terminal')
      return
    }
    // The Chan engine uses a much longer private calculation window. Keep a
    // bounded two-day-ish public context so the latest forming segment can
    // remain visible without exposing the whole internal history.
    const result = await client.getPublicMarketSnapshot(requestedSymbol, requestedTimeframe, 500)
      .catch(reason => { if (!current()) return null; clearForbiddenSnapshot(reason, scope); throw reason })
    if (!result || !current() || requestedSymbol !== symbol.value || requestedTimeframe !== timeframe.value) return
    exhaustedBefore = ''; historyMessage.value = ''
    applyPublicSnapshot(result.data)
    marketHistoryVersion.value += 1
    if (reconnect && session.value) await startTradingRealtime(session.value, accountId, symbol.value, timeframe.value, observerChannelId,
      () => accountId ? syncAccountSnapshot(accountId, observerChannelId, scope) : loadMarket('', false, null, scope), () => { void loadLatestAnalysis() }, 'public')
  }

  function marketSource(accountId: string, observerChannelId: string | null): 'public' | 'terminal' {
    return accountId && observerChannelId === null && !publicSymbolCatalog.has(symbol.value) ? 'terminal' : 'public'
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
    loading.value = true; error.value = ''; marketError.value = ''
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
      error.value = workspaceError(reason, '账户切换未完成，请查看切换确认提示或刷新重试')
    } finally { if (current()) loading.value = false }
  }

  async function refreshMarket() {
    const current = requests.begin('market-selection')
    stopTradingRealtime()
    applyTerminalMarketObservation(null)
    marketQuote.value = null; marketCandles.value = []; marketStructure.value = null
    resourceRevisions.value.quote = 0; resourceRevisions.value.candle = 0
    marketLoading.value = true; marketError.value = ''
    try { await loadMarket() }
    catch (reason) {
      if (current()) marketError.value = workspaceError(reason, '行情暂时无法读取，请重试')
    } finally { if (current()) marketLoading.value = false }
  }
  async function selectSymbol(value: string) {
    if (!symbols.value.includes(value) || value === symbol.value) return
    symbol.value = value
    latestAnalysis.value = null
    persistPreferences()
    await Promise.all([refreshMarket(), loadLatestAnalysis()])
  }
  async function selectTimeframe(value: Timeframe) {
    if (value === timeframe.value) return
    timeframe.value = value
    persistPreferences()
    await refreshMarket()
  }
  function toggleChartLayer(layer: keyof StructureLayers) {
    chartLayers[layer] = !chartLayers[layer]
    persistPreferences()
  }

  function workspaceError(reason: unknown, fallback: string) {
    if (reason instanceof ApiClientError) {
      if (reason.status === 401) return '登录状态已失效，请重新登录'
      if (reason.status === 403) return '当前数据访问权限已失效，请重新选择账户或观摩频道'
      if (reason.status === 409) return '账户状态已变化，请刷新后重新选择'
    }
    return fallback
  }

  async function loadLatestAnalysis() {
    const current = requests.begin('analysis')
    analysisLoading.value = true
    analysisError.value = ''
    try {
      const analyses = await client.listMarketAnalyses(symbol.value ? { pageSize: 1, symbol: symbol.value } : 1)
      if (!current()) return
      latestAnalysis.value = analyses.data.items[0] ?? null
    } catch (reason) {
      if (current()) analysisError.value = reason instanceof ApiClientError && reason.status === 401
        ? '登录状态已失效，请重新登录后查看最新分析'
        : reason instanceof ApiClientError && reason.status === 403
          ? '当前账号没有查看此分析的权限'
          : '最新分析暂时无法读取，请稍后刷新重试'
    } finally { if (current()) analysisLoading.value = false }
  }

  watch(() => session.value, () => {
    stop()
    clearAccountRuntime()
    applyTradingContext(null); applyTradingAccounts([]); applyObserverChannels([])
    activeAccountId.value = null
    preferenceScope = ''
    symbol.value = ''; symbols.value = []; symbolDirectoryNotice.value = ''
    timeframe.value = 'M5'; Object.assign(chartLayers, defaultStructureLayers())
    latestAnalysis.value = null; analysisStrategies.value = []
    error.value = ''; analysisError.value = ''; marketError.value = ''
    if (session.value) void load()
  }, { flush: 'sync' })

  return { marketSourceKey, historyLoading, historyMessage, symbolDirectoryNotice, loadOlderHistory, loading, error, symbol, symbols, timeframe, chartLayers, toggleChartLayer, marketHistoryVersion, accounts: tradingAccounts, observers: observerChannels, context: tradingContext,
    positionsConfirmed: computed(() => resourceRevisions.value.positions > 0), ordersConfirmed: computed(() => resourceRevisions.value.pendingOrders > 0),
    snapshot: accountSnapshot, quote: marketQuote, candles: marketCandles, structure: marketStructure, positions: openPositions, pendingOrders,
    latestAnalysis, analysisStrategies, analysisLoading, analysisError, marketLoading, marketError, refreshMarket,
    hasAccount: computed(() => Boolean(activeAccountId.value)), load, selectAccount, selectObserver, leaveObserver, selectSymbol, selectTimeframe, stop }
}
