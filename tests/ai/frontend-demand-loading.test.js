import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')

function block(startMarker, endMarker) {
  const start = app.indexOf(startMarker)
  const end = app.indexOf(endMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return app.slice(start, end)
}

function loadHistoryRangeFromError() {
  const start = app.indexOf('function historyRangeFromError')
  const end = app.indexOf('function historyRetryContextKey', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`${app.slice(start, end)}\nreturn historyRangeFromError;`)()
}

function loadHistorySummaryReadyPredicate() {
  const start = app.indexOf('function historySummaryReadyForRequestedRange')
  const end = app.indexOf('function historyCursorRangeIsFixed', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    const state = { bridgePlatform:'mt5' }
    ${app.slice(start, end)}
    return historySummaryReadyForRequestedRange
  `)()
}

async function runHistoryCursorScenario() {
  const helperStart = app.indexOf('function historyCursorRangeIsFixed')
  const helperEnd = app.indexOf('function markHistoryDirty', helperStart)
  const tableStart = app.indexOf('function loadHistory(forceRefresh')
  const tableEnd = app.indexOf('function _applyHistoryData', tableStart)
  const dirtyStart = app.indexOf('function markHistoryDirty', helperStart)
  const dirtyEnd = app.indexOf('function scheduleHistoryFreshnessRetry', dirtyStart)
  expect(helperStart).toBeGreaterThanOrEqual(0)
  expect(helperEnd).toBeGreaterThan(helperStart)
  expect(tableStart).toBeGreaterThanOrEqual(0)
  expect(tableEnd).toBeGreaterThan(tableStart)
  expect(dirtyStart).toBeGreaterThanOrEqual(0)
  expect(dirtyEnd).toBeGreaterThan(dirtyStart)
  const harness = new Function(`
    const responses = [
      {
        status:'success', orders:[],
        history_range:{ range_start_utc_msc:1000, range_end_utc_msc:2000 },
        history_sync:{ freshness_state:'refreshing', summary_status:'ready', requested_range_complete:false },
        statistics:{ total_profit:999 },
      },
      {
        status:'success', orders:[], history_snapshot_id:'snapshot-new',
        history_range:{ range_start_utc_msc:1000, range_end_utc_msc:2000 },
        history_sync:{ freshness_state:'fresh', summary_status:'ready', requested_range_complete:true },
        statistics:{ total_profit:123 },
      },
      {
        status:'success', orders:[], history_snapshot_id:'snapshot-dirty',
        history_range:{ range_start_utc_msc:1000, range_end_utc_msc:3000 },
        history_sync:{ freshness_state:'fresh', summary_status:'ready', requested_range_complete:true },
        statistics:{ total_profit:456 },
      },
    ]
    const requests = []
    let _historyCache = null
    let _historyChartCache = null
    let _historyCursorState = {
      key:null, snapshotId:null, rangeStart:null, rangeEnd:null,
      pageCursors:new Map([[1, null]]),
    }
    const _historyTableFlights = new Map()
    const state = {
      historyFilters:{ page:1, pageSize:20 },
      bridgePlatform:'mt5',
      bridgeAccountIdentity:{ brokerServerKey:'DEMO', loginAccount:'42' },
    }
    const document = { getElementById:() => ({ value:'' }) }
    function getHistoryRangeParams() { return { history_scope:'all' } }
    function historyFlightKey(kind, options) { return \`\${kind}:\${Boolean(options.forceRefresh)}\` }
    function historyCircuitAllows() {}
    function clearHistoryCircuit() {}
    function historyErrorCode() { return '' }
    function historyRangeFromError(error) {
      const range = error?.history_range
      if (!range) return null
      const rangeStart = Number(range.range_start_utc_msc)
      const rangeEnd = Number(range.range_end_utc_msc)
      return Number.isSafeInteger(rangeStart) && Number.isSafeInteger(rangeEnd)
        && rangeStart > 0 && rangeStart < rangeEnd ? { rangeStart, rangeEnd } : null
    }
    function isHistoryCursorRangeIncomplete() { return false }
    function rememberHistoryFailure() {}
    function notifyHistoryFailure() {}
    function loadSignalTickets() { return Promise.resolve() }
    function loadCloseSignalTickets() { return Promise.resolve() }
    function _applyHistoryData() {}
    function cancelHistoryRangeRetry() {}
    function resetHistoryCursorState(key = null) {
      _historyCursorState = { key, snapshotId:null, rangeStart:null, rangeEnd:null, pageCursors:new Map([[1, null]]) }
    }
    function wsApi(action, params) {
      requests.push({ action, params:{ ...params } })
      return Promise.resolve(responses.shift())
    }
    ${app.slice(helperStart, helperEnd)}
    ${app.slice(dirtyStart, dirtyEnd)}
    ${app.slice(tableStart, tableEnd)}
    return (async () => {
      await loadHistory(true)
      const first = requests[0]
      resetHistorySnapshotState({ preserveRange:true })
      await loadHistory(false)
      const second = requests[1]
      markHistoryDirty({ refreshActive:false })
      await loadHistory(true)
      const dirty = requests[2]
      return {
        first, second, dirty,
        firstRange:{ start:_historyCursorState.rangeStart, end:_historyCursorState.rangeEnd },
      }
    })()
  `)
  return harness()
}

describe('AI laboratory demand-driven frontend loading contract', () => {
  it('loads the dashboard in status, symbols, then dashboard-data order', () => {
    const initial = block('async function loadInitialDashboard()', 'let _refreshAllPromise')
    expect(initial.indexOf('loadStatus()')).toBeLessThan(initial.indexOf('loadSymbolsWhenReady()'))
    expect(initial.indexOf('loadSymbolsWhenReady()')).toBeLessThan(initial.indexOf('loadAccount()'))
    expect(initial.indexOf('loadSymbolsWhenReady()')).toBeLessThan(initial.indexOf('refreshQuote()'))
    expect(initial.indexOf('loadSymbolsWhenReady()')).toBeLessThan(initial.indexOf('loadKlineData()'))
    expect(initial).toContain('loadSignals({ limit:1, summaryOnly:true, skipResultRender:true })')
    for (const hiddenLoader of ['loadHistory()', 'loadHistoryChart()', 'loadSignalTable()', 'loadStrategyCatalog()']) {
      expect(initial).not.toContain(hiddenLoader)
    }
    const symbols = block('async function loadSymbols()', 'async function loadAccount()')
    expect(symbols).toContain('setGlobalSymbol(preferred.name, { refreshData:false })')
  })

  it('keeps bootstrap free of global refresh and starts dashboard timers explicitly', () => {
    const bootstrap = block('async function bootstrap()', 'async function loadInitialDashboard()')
    expect(bootstrap).not.toContain('refreshAll()')
    expect(bootstrap).not.toContain('refreshTabData(activeTabId())')
    expect(bootstrap).toContain('await loadInitialDashboard()')
    expect(bootstrap).toContain('if (marketReady)')
    expect(bootstrap).toContain('startKlineRefreshTimer()')
    expect(bootstrap).toContain('startKlineVolumeRefreshTimer()')
  })

  it('suppresses legacy bridge-wide recovery while the initial dashboard is loading', () => {
    const personalRecovery = block('function schedulePersonalBridgeRefresh()', 'function notifyObserverChannelSelection()')
    expect(personalRecovery).toContain('if (_initialDashboardBootstrapInFlight) return')
    const heartbeat = block('function handleHeartbeat(msg)', '// Handle bridge disconnect notification')
    expect(heartbeat).toContain('!_initialDashboardBootstrapInFlight')
    const bootstrap = block('async function bootstrap()', 'async function loadInitialDashboard()')
    expect(bootstrap).toContain('_initialDashboardBootstrapInFlight = true')
    expect(bootstrap.match(/_initialDashboardBootstrapInFlight = false/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('does not turn a one-row dashboard summary into detail or table requests', () => {
    const signals = block('async function loadSignals(options = {})', '// Load signal table data')
    expect(signals).toContain('const summaryOnly = options.summaryOnly === true')
    expect(signals).toContain('const loadTable = options.loadTable === true')
    expect(signals).toContain('if (summaryOnly)')
    expect(signals).toContain('if (!options.append && loadTable) await loadSignalTable()')
    expect(signals).not.toContain('if (!options.append) loadSignalTable()')
  })

  it('loads analyst history on entry, while records view owns the paginated table', () => {
    const tabRefresh = block('async function refreshTabData(tabId, options = {})', 'async function withBusy')
    expect(tabRefresh).toContain('{ selectLatest:true, loadDashboard:false }')
    expect(tabRefresh).toContain('{ skipResultRender:true, loadDashboard:false }')
    expect(tabRefresh).toContain('if (state.analystView === "records")')
    expect(tabRefresh).toContain('await loadSignalTable()')
    expect(tabRefresh).toContain('startLiveQuoteRefreshTimer()')
    const analystView = block('function setAnalystView(target, options = {})', 'function setModelStrategySubtab')
    expect(analystView).toContain('options.loadData !== false')
    expect(app).toContain('"refresh-signals": () => state.analystView === "records"')
  })

  it('hydrates the analyst history page on ticket navigation without expanding dashboard loading', () => {
    const ensureHistory = block('async function ensureAnalysisHistoryPageLoaded()', 'function renderAnalysisDetailLoading')
    expect(ensureHistory).toContain('if (state.analysisHistoryPageLoaded) return')
    expect(ensureHistory).toContain('if (_analysisHistoryLoadPromise) return _analysisHistoryLoadPromise')
    expect(ensureHistory).toContain('limit: ANALYSIS_HISTORY_PAGE_SIZE')
    expect(ensureHistory).toContain('skipResultRender: true')
    expect(ensureHistory).toContain('loadDashboard: false')
    const signals = block('async function loadSignals(options = {})', '// Load signal table data')
    expect(signals).toContain('state.analysisHistoryPageLoaded = !summaryOnly && limit >= ANALYSIS_HISTORY_PAGE_SIZE')

    const openDetail = block('async function openAnalysisFromHistory(signalId, options = {})', 'function renderSignalRows()')
    expect(openDetail).toContain('if (navigate) {')
    expect(openDetail).toContain('await ensureAnalysisHistoryPageLoaded()')
    expect(openDetail).toContain('signal = mergeSignalListSummary(')
    expect(openDetail).toContain('state.signals.find(item => String(item.id) === requestedId)')
    expect(openDetail.indexOf('await ensureAnalysisHistoryPageLoaded()')).toBeLessThan(openDetail.indexOf('wsApi("signal_detail"'))

    const byTicket = block('async function navigateToSignalByTicket(ticket)', 'async function cancelPendingOrder(ticket)')
    expect(byTicket).toContain('await openAnalysisFromHistory(signal.id, { source:"ticket", forcePinned:true })')
    expect(byTicket).not.toContain('setTab("ai-analyze")')

    const initial = block('async function loadInitialDashboard()', 'let _refreshAllPromise')
    expect(initial).toContain('loadSignals({ limit:1, summaryOnly:true, skipResultRender:true })')
    expect(initial).not.toContain('ensureAnalysisHistoryPageLoaded()')
    expect(html).toContain('/ai/app.js?v=20260810inferencefix1&build=signalbandwidth1')
  })

  it('uses summary-only updates outside the analyst page and preserves selected details there', () => {
    const execution = block("} else if (msg.type === 'signal_execution_updated')", "} else if (msg.type === 'weekly_flatten_state')")
    expect(execution).toContain('{ limit:1, summaryOnly:true, skipResultRender:true }')
    expect(execution).toContain('{ skipResultRender:true, loadDashboard:false }')
    expect(execution).toContain('openAnalysisFromHistory(msg.signal_id')
    const refresh = block('async function refreshForNewSignal(signalId', '// UI-only timer')
    expect(refresh).toContain('{ limit:1, summaryOnly:true, skipResultRender:true, announceDashboardSignal:true }')
    expect(refresh).toContain('{ skipResultRender:true, loadDashboard:false }')
  })

  it('refreshes only the active page and avoids quoting before symbol discovery', () => {
    const binding = block('$("refreshAllBtn").addEventListener', '$("gatewayMode")')
    expect(binding).toContain('const tabId = activeTabId()')
    expect(binding).toContain('refreshTabData(tabId, { manualRefresh:true })')
    expect(binding).not.toContain('refreshAll()')
    const timer = block('function startLiveQuoteRefreshTimer()', 'async function syncDefaultPlatformQuote')
    expect(timer).toContain('!state.symbols.length')
  })

  it('keeps an incomplete history cursor in a bounded pending retry state', () => {
    const retry = block('function scheduleHistoryRangeRetry', 'function resetHistoryCursorState')
    const views = block('function loadHistoryViews(', 'function historyProtectionCell')
    const table = block('function loadHistory(forceRefresh', 'function _applyHistoryData')

    expect(app).toContain("history_cursor_range_incomplete: \"正在准备所选范围的交易记录，请稍后刷新\"")
    expect(app).toContain("const HISTORY_RANGE_RETRY_INTERVAL_MS = 3000")
    expect(app).toContain("const HISTORY_RANGE_RETRY_MAX_ATTEMPTS = 20")
    expect(app).toContain('error.history_range = msg.history_range || msg.details?.history_range || null')
    expect(app).toContain('range_start_utc_msc:_historyCursorState.rangeStart')
    expect(app).toContain('range_end_utc_msc:_historyCursorState.rangeEnd')
    expect(table).toContain('if (!incomplete) console.error("loadHistory:", e)')
    expect(table).toContain('if (!incomplete) notifyHistoryFailure(key, e)')
    expect(retry).toContain('retry.timer || retry.inFlight')
    expect(retry).toContain('historyRetryAttempt:true')
    expect(retry).toContain('forceRefresh:false')
    expect(retry).toContain('retry.attempts += 1')
    expect(views).toContain('if (manualRefresh) cancelHistoryRangeRetry()')
    expect(views).toContain('_historyRangeRetryState.contextKey !== currentRetryContext')
    expect(views).toContain('finishHistoryRangeRetry(_historyRangeRetryState)')
    expect(views.indexOf('await loadHistory(effectiveForceRefresh')).toBeLessThan(views.indexOf('await loadHistoryChart(false'))
    expect(views).toContain('return { historyPending:true }')
    const leaveHistory = block('if (tabId !== "history") {', 'closeMobileNav(')
    expect(leaveHistory).toContain('cancelHistoryRangeRetry()')
    expect(leaveHistory).toContain('clearHistoryFreshnessRetry()')
    expect(app).toContain('function resetHistoryCursorState(key = null) {\n  cancelHistoryRangeRetry()')
  })

  it('accepts only a safe fixed range from an incomplete-history response', () => {
    const historyRangeFromError = loadHistoryRangeFromError()
    expect(historyRangeFromError({ history_range:{ range_start_utc_msc:1000, range_end_utc_msc:2000 } }))
      .toEqual({ rangeStart:1000, rangeEnd:2000 })
    expect(historyRangeFromError({ details:{ history_range:{ range_start_utc_msc:0, range_end_utc_msc:2000 } } }))
      .toBeNull()
    expect(historyRangeFromError({ history_range:{ range_start_utc_msc:'bad', range_end_utc_msc:2000 } }))
      .toBeNull()
  })

  it('keeps closed-position history dirty until the bridge proves a fresh revision', () => {
    const push = block('function handleBridgeData(msg)', 'const BRIDGE_DATA_REFRESH_DELAY_MS')
    const dirty = block('function clearHistoryFreshnessRetry()', 'async function handleBridgeReconnected')
    const views = block('function loadHistoryViews(', 'function historyProtectionCell')
    const apply = block('function _applyHistoryData(data)', '// Chart and summary use')

    expect(push).toContain('markHistoryDirty({ refreshActive:true })')
    expect(push).not.toContain('loadHistoryViews().catch(() => {})')
    expect(dirty).toContain("['refreshing', 'stale']")
    expect(dirty).toContain('loadHistoryViews({ forceRefresh:true })')
    expect(dirty).not.toContain('loadHistoryViews({ forceRefresh:true, historyRetryAttempt:true })')
    expect(views).toContain('if (sync.freshness_state === "fresh") _historyDirty = false')
    expect(views).toContain('scheduleHistoryFreshnessRetry(tableData)')
    expect(views).toContain('tableData?.chart_data')
    expect(views).toContain('_renderHistoryChart(tableData.chart_data)')
    expect(views).toContain('Number(state.historyFilters?.page || 1) > 1 && _historyChartCache')
    expect(apply).toContain('已显示 ${rows.length} 笔 · 全量统计准备中')
    expect(apply).toContain('historySummaryReadyForRequestedRange(sync)')
    expect(app).toContain('sync.requested_range_complete !== false')
    expect(app).toContain('sync.terminal_visible_history_complete === true')
  })

  it('keeps freshness retries on one fixed range while dropping stale snapshots', () => {
    const freshness = block('function scheduleHistoryFreshnessRetry', 'async function handleBridgeReconnected')
    const views = block('function loadHistoryViews(', 'function historyProtectionCell')
    const table = block('function loadHistory(forceRefresh', 'function _applyHistoryData')
    expect(freshness).toContain('const rangePending = sync.requested_range_complete === false')
    expect(freshness).toContain('loadHistoryViews({ forceRefresh:false, historyRetryAttempt:true })')
    expect(freshness).not.toContain('loadHistoryViews({ forceRefresh:true')
    expect(views).toContain('const automaticRetry = historyRetryAttempt === true && manualRefresh !== true')
    expect(views).toContain('const effectiveForceRefresh = Boolean(!automaticRetry && (forceRefresh || _historyDirty))')
    expect(views).toContain('resetHistorySnapshotState({ preserveRange:true })')
    expect(views).toContain('loadHistory(effectiveForceRefresh, { manualRefresh:effectiveManualRefresh })')
    expect(table).toContain('range_start_utc_msc:_historyCursorState.rangeStart')
    expect(table).toContain('range_end_utc_msc:_historyCursorState.rangeEnd')

    const start = app.indexOf('function historyCursorRangeIsFixed')
    const end = app.indexOf('function markHistoryDirty', start)
    const resetState = new Function(`
      let _historyCache = { filters:'old' }
      let _historyChartCache = { filters:'old' }
      let _historyCursorState = {
        key:'scope:all', snapshotId:'snapshot-old', rangeStart:1000, rangeEnd:2000,
        pageCursors:new Map([[1, null], [2, 'cursor-old']]),
      }
      const state = { historyFilters:{ page:2 } }
      ${app.slice(start, end)}
      resetHistorySnapshotState({ preserveRange:true })
      return { _historyCache, _historyChartCache, _historyCursorState, page:state.historyFilters.page }
    `)()
    expect(resetState._historyCache).toBeNull()
    expect(resetState._historyChartCache).toBeNull()
    expect(resetState._historyCursorState).toMatchObject({
      key:'scope:all', snapshotId:null, rangeStart:1000, rangeEnd:2000,
    })
    expect([...resetState._historyCursorState.pageCursors.entries()]).toEqual([[1, null]])
    expect(resetState.page).toBe(1)
  })

  it('regresses partial success, fixed-endpoint retry, and dirty-push recapture', async () => {
    const { first, second, dirty, firstRange } = await runHistoryCursorScenario()
    expect(first.params.force_refresh).toBe(true)
    expect(first.params).not.toHaveProperty('range_start_utc_msc')
    expect(first.params).not.toHaveProperty('range_end_utc_msc')
    expect(second.params.force_refresh).toBe(false)
    expect(second.params.range_start_utc_msc).toBe(1000)
    expect(second.params.range_end_utc_msc).toBe(2000)
    expect(second.params).not.toHaveProperty('history_snapshot_id')
    expect(dirty.params.force_refresh).toBe(true)
    expect(dirty.params).not.toHaveProperty('range_start_utc_msc')
    expect(dirty.params).not.toHaveProperty('range_end_utc_msc')
    expect(firstRange).toEqual({ start:1000, end:3000 })

    const apply = block('function _applyHistoryData(data)', '// Chart and summary use')
    expect(apply).toContain('const stats = summaryReady && data.statistics')
    expect(apply).toContain('已显示 ${rows.length} 笔 · 全量统计准备中')
    const summaryReady = loadHistorySummaryReadyPredicate()
    expect(summaryReady({ summary_status:'ready', requested_range_complete:false })).toBe(false)
    expect(summaryReady({ summary_status:'ready', requested_range_complete:true })).toBe(true)
  })

  it('deduplicates evidence requests, fetches each timeframe once, and ignores stale responses', async () => {
    const start = app.indexOf('const _signalEvidenceCache = new Map()')
    const end = app.indexOf('function chanSummaryForTimeframe', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const harness = new Function(`
      const requests = []
      const pending = []
      const renderCalls = []
      const state = {
        selectedSignal:{ id:7 }, inferenceChartTimeframe:'M5',
      }
      const nodes = { analysisResult:{ dataset:{ signalId:'7', renderVersion:'1' } } }
      function $(id) { return nodes[id] }
      function signalMarketData() { return {} }
      function wsApi(action, params) {
        requests.push({ action, params })
        return new Promise(resolve => pending.push(resolve))
      }
      function renderInferenceChart(signal) { renderCalls.push({ id:signal?.id, timeframe:state.inferenceChartTimeframe }) }
      ${app.slice(start, end)}
      return (async () => {
        const signal = { id:7, inference_snapshot:{ id:2, available_timeframes:['M5','M15'] } }
        const first = ensureInferenceEvidence(signal, 'M5', 1)
        const duplicate = ensureInferenceEvidence(signal, 'M5', 1)
        const sameFlight = requests.length
        pending.shift()({ status:'success', evidence:{ id:2, klines:[{ time:1, open:1, high:2, low:1, close:2 }] } })
        await Promise.all([first, duplicate])
        const second = ensureInferenceEvidence(signal, 'M15', 1)
        const stale = ensureInferenceEvidence({ id:8, inference_snapshot:{ id:3, available_timeframes:['M5'] } }, 'M5', 1)
        pending.shift()({ status:'success', evidence:{ id:2, klines:[{ time:2, open:1, high:2, low:1, close:2 }] } })
        state.selectedSignal = { id:8 }
        pending.shift()({ status:'success', evidence:{ id:3, klines:[{ time:3, open:1, high:2, low:1, close:2 }] } })
        await Promise.all([second, stale])
        const again = ensureInferenceEvidence(signal, 'M5', 1)
        return { requests, sameFlight, renders:renderCalls, again:await again }
      })()
    `)()
    const result = await harness
    expect(result.sameFlight).toBe(1)
    expect(result.requests.map(item => item.params.timeframe)).toEqual(['M5', 'M15', 'M5'])
    expect(result.renders).toEqual([{ id:7, timeframe:'M5' }])
    expect(result.again.klines[0].time).toBe(1)
  })

  it('bounds evidence and detail caches with LRU eviction without touching flights', async () => {
    const start = app.indexOf('const _signalEvidenceCache = new Map()')
    const end = app.indexOf('function chanSummaryForTimeframe', start)
    const harness = new Function(`
      ${app.slice(start, end)}
      for (let index = 0; index < SIGNAL_EVIDENCE_CACHE_LIMIT; index += 1) {
        setSignalCacheEntry(_signalEvidenceCache, 'e' + index, { index }, SIGNAL_EVIDENCE_CACHE_LIMIT)
      }
      getSignalCacheEntry(_signalEvidenceCache, 'e0')
      setSignalCacheEntry(_signalEvidenceCache, 'e-extra', { index: 'extra' }, SIGNAL_EVIDENCE_CACHE_LIMIT)
      for (let index = 0; index < SIGNAL_DETAIL_CACHE_LIMIT; index += 1) {
        setSignalCacheEntry(_signalDetailCache, 'd' + index, { index }, SIGNAL_DETAIL_CACHE_LIMIT)
      }
      setSignalCacheEntry(_signalDetailCache, 'd-extra', { index: 'extra' }, SIGNAL_DETAIL_CACHE_LIMIT)
      _signalEvidenceFlights.set('active-evidence', Promise.resolve())
      _signalDetailFlights.set('active-detail', Promise.resolve())
      return {
        evidenceSize: _signalEvidenceCache.size,
        detailSize: _signalDetailCache.size,
        evidenceTouched: getSignalCacheEntry(_signalEvidenceCache, 'e0')?.index,
        evidenceEvicted: getSignalCacheEntry(_signalEvidenceCache, 'e1'),
        evidenceFlightCount: _signalEvidenceFlights.size,
        detailFlightCount: _signalDetailFlights.size,
      }
    `)()
    const result = await harness
    expect(result.evidenceSize).toBe(64)
    expect(result.detailSize).toBe(128)
    expect(result.evidenceTouched).toBe(0)
    expect(result.evidenceEvicted).toBeNull()
    expect(result.evidenceFlightCount).toBe(1)
    expect(result.detailFlightCount).toBe(1)
  })

  it('reuses ordinary signal details while allowing explicit lightweight refresh', async () => {
    const start = app.indexOf('function signalSnapshotRevision(signal)')
    const end = app.indexOf('// The dashboard deliberately keeps only a one-row signal summary', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const harness = new Function(`
      const detailCache = new Map()
      const detailFlights = new Map()
      const evidenceCache = new Map()
      const responses = []
      const requests = []
      const state = { signals:[{ id:7, symbol:'XAUUSD' }] }
      function wsApi(action, params) {
        requests.push({ action, params })
        return new Promise(resolve => responses.push(resolve))
      }
      const _signalDetailCache = detailCache
      const _signalDetailFlights = detailFlights
      const _signalEvidenceCache = evidenceCache
      const SIGNAL_DETAIL_CACHE_LIMIT = 128
      function getSignalCacheEntry(cache, key) {
        if (!cache.has(key)) return null
        const value = cache.get(key)
        cache.delete(key)
        cache.set(key, value)
        return value
      }
      function setSignalCacheEntry(cache, key, value, limit) {
        cache.delete(key)
        cache.set(key, value)
        while (cache.size > limit) cache.delete(cache.keys().next().value)
        return value
      }
      function clearSignalEvidence() {}
      ${app.slice(start, end)}
      return (async () => {
        const first = loadSignalDetail(7)
        const duplicate = loadSignalDetail(7)
        responses.shift()({ status:'success', signal:{ id:7, inference_snapshot:{ id:4 }, analysis:'first' } })
        const firstResult = await first
        const duplicateResult = await duplicate
        const cached = await loadSignalDetail(7)
        const refreshed = loadSignalDetail(7, { forceRefresh:true })
        responses.shift()({ status:'success', signal:{ id:7, inference_snapshot:{ id:4 }, analysis:'refreshed' } })
        await refreshed
        return { requests, firstResult, duplicateResult, cached, refreshed:detailCache.get('7') }
      })()
    `)()
    const result = await harness
    expect(result.requests).toHaveLength(2)
    expect(result.firstResult.analysis).toBe('first')
    expect(result.duplicateResult.analysis).toBe('first')
    expect(result.cached.analysis).toBe('first')
    expect(result.refreshed.analysis).toBe('refreshed')
  })

  it('merges the current list execution state over a cached detail without losing detail fields', async () => {
    const start = app.indexOf('function signalSnapshotRevision(signal)')
    const end = app.indexOf('function renderSignalRows()', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const harness = new Function(`
      let _analysisDetailRequestVersion = 0
      const detailCache = new Map([['7', {
        id:7, detail_loaded:true, analysis:'cached detail', pending_ticket:'old-ticket',
        pending_state:'pending', inference_snapshot:{ id:4 }, market_data:{ latest_price:2000 },
      }]])
      const detailFlights = new Map()
      const evidenceCache = new Map()
      const state = {
        signals:[{ id:7, symbol:'XAUUSD', pending_ticket:'new-ticket', pending_state:'filled', is_executed:true }],
        selectedSignal:null,
      }
      const _signalDetailCache = detailCache
      const _signalDetailFlights = detailFlights
      const _signalEvidenceCache = evidenceCache
      const SIGNAL_DETAIL_CACHE_LIMIT = 128
      function getSignalCacheEntry(cache, key) {
        if (!cache.has(key)) return null
        const value = cache.get(key)
        cache.delete(key)
        cache.set(key, value)
        return value
      }
      function setSignalCacheEntry(cache, key, value, limit) {
        cache.delete(key)
        cache.set(key, value)
        while (cache.size > limit) cache.delete(cache.keys().next().value)
        return value
      }
      function clearSignalEvidence() {}
      function setAnalysisSelectionIntent() {}
      function highlightActiveAnalysis() {}
      function setTab() {}
      function ensureAnalysisHistoryPageLoaded() { return Promise.resolve() }
      function renderAnalysisDetailLoading() {}
      function renderAnalysisHistory() {}
      function renderSignal(signal) { state.rendered = signal }
      function toast() {}
      const document = { querySelector() { return null } }
      function wsApi() { throw new Error('detail should not refetch') }
      ${app.slice(start, end)}
      return openAnalysisFromHistory(7, { navigate:false }).then(() => ({
        selected:state.selectedSignal,
        rendered:state.rendered,
        requests:detailFlights.size,
      }))
    `)()
    const result = await harness
    expect(result.requests).toBe(0)
    expect(result.selected).toMatchObject({
      id:7, pending_ticket:'new-ticket', pending_state:'filled', is_executed:true,
      analysis:'cached detail', inference_snapshot:{ id:4 }, market_data:{ latest_price:2000 },
    })
    expect(result.rendered).toMatchObject({ pending_ticket:'new-ticket', pending_state:'filled' })
  })
})
