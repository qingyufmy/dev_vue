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
    expect(openDetail).toContain("signal = state.signals.find(item => String(item.id) === requestedId) || signal")
    expect(openDetail.indexOf('await ensureAnalysisHistoryPageLoaded()')).toBeLessThan(openDetail.indexOf('wsApi("signal_detail"'))

    const byTicket = block('async function navigateToSignalByTicket(ticket)', 'async function cancelPendingOrder(ticket)')
    expect(byTicket).toContain('await openAnalysisFromHistory(signal.id, { source:"ticket", forcePinned:true })')
    expect(byTicket).not.toContain('setTab("ai-analyze")')

    const initial = block('async function loadInitialDashboard()', 'let _refreshAllPromise')
    expect(initial).toContain('loadSignals({ limit:1, summaryOnly:true, skipResultRender:true })')
    expect(initial).not.toContain('ensureAnalysisHistoryPageLoaded()')
    expect(html).toContain('/ai/app.js?v=20260809history30d1')
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
    expect(views.indexOf('await loadHistory(forceRefresh')).toBeLessThan(views.indexOf('await loadHistoryChart(false'))
    expect(views).toContain('return { historyPending:true }')
    expect(app).toContain('if (tabId !== "history") cancelHistoryRangeRetry()')
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
})
