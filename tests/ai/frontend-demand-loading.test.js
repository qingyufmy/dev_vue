import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

function block(startMarker, endMarker) {
  const start = app.indexOf(startMarker)
  const end = app.indexOf(endMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return app.slice(start, end)
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
    const tabRefresh = block('async function refreshTabData(tabId)', 'async function withBusy')
    expect(tabRefresh).toContain('{ selectLatest:true, loadDashboard:false }')
    expect(tabRefresh).toContain('{ skipResultRender:true, loadDashboard:false }')
    expect(tabRefresh).toContain('if (state.analystView === "records")')
    expect(tabRefresh).toContain('await loadSignalTable()')
    expect(tabRefresh).toContain('startLiveQuoteRefreshTimer()')
    const analystView = block('function setAnalystView(target, options = {})', 'function setModelStrategySubtab')
    expect(analystView).toContain('options.loadData !== false')
    expect(app).toContain('"refresh-signals": () => state.analystView === "records"')
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
})
