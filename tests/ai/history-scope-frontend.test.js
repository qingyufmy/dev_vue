import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

function loadRangeParamsHarness({ mode = 'platform', from = '', to = '', meta = null, starts = {} } = {}) {
  const start = app.indexOf('function getHistoryRangeParams()')
  const end = app.indexOf('function historyPreparationMessage', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    const HISTORY_DEFAULT_SCOPE = 'platform'
    const HISTORY_ABSOLUTE_FLOOR_DATE = '2000-01-01'
    const state = {
      historyRangeMeta:${JSON.stringify(meta)},
      historyRangePreferences:{ starts:${JSON.stringify(starts)} },
    }
    const nodes = {
      historyRangeMode:{ value:${JSON.stringify(mode)} },
      historyRangeFrom:{ value:${JSON.stringify(from)} },
      historyRangeTo:{ value:${JSON.stringify(to)} },
    }
    function $(id) { return nodes[id] }
    function validHistoryBusinessDate(value) {
      const text = String(value || '').trim()
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) return false
      const parsed = new Date(text + 'T00:00:00Z')
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    }
    function historyPreferenceStart(scope) {
      return state.historyRangePreferences?.starts?.[scope] || ''
    }
    ${app.slice(start, end)}
    return getHistoryRangeParams()
  `)()
}

function loadScopeMeta(data) {
  const start = app.indexOf('function historyRangeNumber')
  const end = app.indexOf('function applyHistoryScopeResponse', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    const state = { mt5TimezoneOffsetMinutes:null }
    const nodes = { historyRangeMode:{ value:'platform' } }
    function $(id) { return nodes[id] }
    function validHistoryBusinessDate(value) {
      const text = String(value || '').trim()
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) return false
      const parsed = new Date(text + 'T00:00:00Z')
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    }
    ${app.slice(start, end)}
    return historyScopeMetaFromResponse(${JSON.stringify(data)})
  `)()
}

function loadHistoryPrepareReady(data) {
  const start = app.indexOf('function historySyncMetadata')
  const end = app.indexOf('function historyQueryIsCurrent', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    ${app.slice(start, end)}
    return historyPrepareReady(${JSON.stringify(data)})
  `)()
}

function loadPreparedRange(data) {
  const start = app.indexOf('function historyPrepareRangeFromResponse')
  const end = app.indexOf('function historyPrepareReady', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    ${app.slice(start, end)}
    return historyPrepareRangeFromResponse(${JSON.stringify(data)})
  `)()
}

function loadHistoryQuerySingleReadHarness() {
  const start = app.indexOf('async function runHistoryQuery')
  const end = app.indexOf('function historySummaryReadyForRequestedRange', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    const HISTORY_PREPARE_UNSUPPORTED_CODE = 'history_prepare_status_unsupported'
    const state = { historyQueryGeneration:1 }
    let _historyQueryGeneration = 1
    let reads = 0
    const statuses = []
    const query = {
      generation:1, accountKey:'account', promise:null, includeAccount:false,
      status:'preparing_time', fullReadCount:0,
    }
    function historyQueryIsCurrent() { return true }
    async function runHistoryPrepare() { return true }
    function isHistoryCursorRangeIncomplete(error) { return error?.code === 'history_cursor_range_incomplete' }
    function loadHistoryViewsLegacy() {
      reads += 1
      const error = new Error('incomplete')
      error.code = 'history_cursor_range_incomplete'
      return Promise.reject(error)
    }
    function renderHistorySyncStatus(message, options) { statuses.push({ message, options }) }
    function clearHistoryPresentation() {}
    function apiErrorMessage(code) { return String(code) }
    function historyErrorCode(error) { return String(error?.code || '') }
    ${app.slice(start, end)}
    return runHistoryQuery(query).catch(error => ({
      reads,
      fullReadCount:query.fullReadCount,
      status:query.status,
      code:error.code,
      message:statuses[statuses.length - 1]?.message || '',
    }))
  `)()
}

function loadHistoryLegacyFallbackHarness(result, options = {}) {
  const start = app.indexOf('async function runHistoryLegacyFallback')
  const end = app.indexOf('async function runHistoryQuery', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    const state = { historyQueryGeneration:1 }
    let _historyQueryGeneration = 1
    const statuses = []
    let legacyOptions = null
    const query = { generation:1, accountKey:'account', status:'preparing_time', fullReadCount:0 }
    function normalizeBridgePlatform(value) { return String(value || '').trim().toLowerCase() === 'mt4' ? 'mt4' : 'mt5' }
    function historyQueryIsCurrent() { return true }
    function renderHistorySyncStatus(message, options) { statuses.push({ message, options }) }
    async function loadHistoryViewsLegacy(options) { legacyOptions = options; return ${JSON.stringify(result)} }
    ${app.slice(start, end)}
    return runHistoryLegacyFallback(query, ${JSON.stringify(options)}).then(data => ({
      data,
      legacyOptions,
      status:query.status,
      fullReadCount:query.fullReadCount,
      message:statuses[statuses.length - 1]?.message || '',
      tone:statuses[statuses.length - 1]?.options?.tone || '',
    }))
  `)()
}

function loadHistoryContextHarness({ currentAccountContextGeneration = 1 } = {}) {
  const currentStart = app.indexOf('function historyQueryIsCurrent')
  const currentEnd = app.indexOf('function historyPrepareMessage', currentStart)
  const contextStart = app.indexOf('function historyRangeContextMatches')
  const contextEnd = app.indexOf('function historyPreparationMessage', contextStart)
  const keyStart = app.indexOf('function historyRefreshContextKey')
  const keyEnd = app.indexOf('function historyErrorCode', keyStart)
  expect(currentStart).toBeGreaterThanOrEqual(0)
  expect(contextEnd).toBeGreaterThan(contextStart)
  expect(keyEnd).toBeGreaterThan(keyStart)
  return new Function(`
    const state = {
      historyQueryGeneration:7,
      _accountContextGeneration:${Number(currentAccountContextGeneration)},
      bridgePlatform:'mt4',
      bridgeAccountIdentity:{ platform:'mt4', brokerServerKey:'Broker', loginAccount:'123' },
      historyRangeMeta:{ allowedStartDate:'2000-01-01', systemStartDate:'2026-07-01', actualEndDate:'2026-08-17' },
      historyFilters:{ page:1, pageSize:20 },
    }
    const nodes = {
      historyRangeMode:{ value:'platform' },
      historyRangeFrom:{ value:'2026-07-31' },
      historyRangeTo:{ value:'' },
      filterEntryFrom:{ value:'' },
      filterEntryTo:{ value:'' },
      filterCloseFrom:{ value:'' },
      filterCloseTo:{ value:'' },
      filterDirection:{ value:'' },
      filterProfit:{ value:'' },
    }
    let _historyQueryGeneration = 7
    function $(id) { return nodes[id] }
    function activeTabId() { return 'history' }
    function normalizeBridgePlatform(value) { return String(value || '').toLowerCase() === 'mt4' ? 'mt4' : 'mt5' }
    function historyStableAccountKey() { return 'mt4|broker|123' }
    function historyPreferenceStart() { return '' }
    function validHistoryBusinessDate(value) { return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(value || '')) }
    ${app.slice(currentStart, currentEnd)}
    ${app.slice(contextStart, contextEnd)}
    ${app.slice(keyStart, keyEnd)}
    const query = {
      generation:7,
      accountContextGeneration:1,
      accountKey:'mt4|broker|123',
      platform:'mt4',
      scopeParams:{ history_scope:'platform' },
      tableFilters:{ page:1, pageSize:20, entry_from:'', entry_to:'', filter_close_from:'', filter_close_to:'', direction:'', profit_filter:'' },
    }
    const requestKey = historyRefreshContextKey({ query })
    state.historyRangeMeta = null
    nodes.historyRangeFrom.value = '2026-07-31'
    state.historyRangeMeta = { allowedStartDate:'2000-01-01', systemStartDate:'2026-07-31', actualEndDate:'2026-08-17' }
    nodes.historyRangeFrom.value = '2026-07-31'
    return {
      matchesAfterResponseMeta:historyRangeContextMatches(requestKey, query.accountContextGeneration, { query }),
      requestKey,
      responseKey:historyRefreshContextKey({ query }),
      current:historyQueryIsCurrent(query),
    }
  `)()
}

function loadHistoryRequestSnapshotHarness() {
  const start = app.indexOf('function loadHistory(forceRefresh')
  const end = app.indexOf('function _applyHistoryData', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    const state = {
      historyFilters:{ page:1, pageSize:20 },
      _accountContextGeneration:1,
      bridgePlatform:'mt4',
      bridgeAccountIdentity:null,
      historyQueryGeneration:1,
    }
    const query = {
      generation:1,
      accountContextGeneration:1,
      accountKey:'mt4|broker|123',
      platform:'mt4',
      scopeParams:{ history_scope:'platform' },
      tableFilters:{ page:1, pageSize:20, entry_from:'2026-08-01', entry_to:'', filter_close_from:'2026-08-02', filter_close_to:'2026-08-03', direction:'buy', profit_filter:'loss' },
      legacyFallback:true,
      frozenRange:null,
    }
    const calls = []
    let _historyCache = null
    let _historyQueryState = query
    const _historyTableFlights = new Map()
    let _historyCursorState = { key:null, snapshotId:null, rangeStart:null, rangeEnd:null, pageCursors:new Map([[1,null]]), preserveRangeOnKeyChange:false }
    function historyFlightKey() { return 'table-flight' }
    function historyRefreshContextKey() { return 'history-context' }
    function historyTableFiltersSnapshot() { throw new Error('mutable table controls must not be read') }
    function getHistoryRangeParams() { throw new Error('mutable history range must not be read') }
    function historyQueryRangeParams() { return {} }
    function historyRangeContextMatches() { return true }
    function historyCursorRangeIsFixed() { return false }
    function resetHistoryCursorState(key) { _historyCursorState = { key, snapshotId:null, rangeStart:null, rangeEnd:null, pageCursors:new Map([[1,null]]), preserveRangeOnKeyChange:false } }
    function historyPrepareRangeFromResponse() { return null }
    function historyQueryIsCurrent() { return true }
    function historyRangeFromError() { return null }
    function isHistoryCursorRangeIncomplete() { return false }
    function historyCircuitAllows() {}
    function clearInvalidHistoryRangePreference() {}
    function rememberHistoryFailure() {}
    function notifyHistoryFailure() {}
    function clearHistoryCircuit() {}
    async function loadHistoryTicketMapsForData() {}
    function applyHistoryScopeResponse() {}
    function _applyHistoryData() {}
    async function wsApi(action, params) {
      calls.push({ action, params })
      return { status:'success', orders:[], pagination:{ current_page:1, page_size:20, total_count:0 }, history_sync:{ requested_range_complete:true, terminal_visible_history_complete:true, summary_status:'ready' } }
    }
    ${app.slice(start, end)}
    return loadHistory(false, { query }).then(() => calls[0])
  `)()
}

function loadCursorResetHarness() {
  const fixedStart = app.indexOf('function historyCursorRangeIsFixed')
  const resetStart = app.indexOf('function resetHistoryCursorState', fixedStart)
  const fixedEnd = app.indexOf('\n}', fixedStart) + 2
  const resetEnd = app.indexOf('\n}', resetStart) + 2
  expect(fixedStart).toBeGreaterThanOrEqual(0)
  expect(resetStart).toBeGreaterThan(fixedStart)
  expect(fixedEnd).toBeGreaterThan(fixedStart)
  expect(resetEnd).toBeGreaterThan(resetStart)
  return new Function(`
    let _historyRangeRetryState = null
    let cancelCount = 0
    let _historyCursorState = {
      key:'scope-old', snapshotId:'snapshot-old', rangeStart:1000, rangeEnd:5000,
      pageCursors:new Map([[1, null], [2, 'cursor-old']]),
    }
    const state = { historyFilters:{ page:2 } }
    function cancelHistoryRangeRetry() { cancelCount += 1 }
    ${app.slice(fixedStart, fixedEnd)}
    ${app.slice(resetStart, resetEnd)}
    resetHistoryCursorState(null, { preserveRange:true })
    const handoff = {
      rangeStart:_historyCursorState.rangeStart,
      rangeEnd:_historyCursorState.rangeEnd,
      snapshotId:_historyCursorState.snapshotId,
      cursors:[..._historyCursorState.pageCursors.entries()],
      preserveRangeOnKeyChange:_historyCursorState.preserveRangeOnKeyChange,
    }
    resetHistoryCursorState('scope-new-filter', { preserveRange:handoff.preserveRangeOnKeyChange })
    return {
      handoff,
      next:{
        key:_historyCursorState.key,
        rangeStart:_historyCursorState.rangeStart,
        rangeEnd:_historyCursorState.rangeEnd,
        snapshotId:_historyCursorState.snapshotId,
        cursors:[..._historyCursorState.pageCursors.entries()],
        preserveRangeOnKeyChange:_historyCursorState.preserveRangeOnKeyChange,
      },
      cancelCount,
    }
  `)()
}

function loadHistoryLegacySummaryRetryHarness({ platform = 'mt4', responses = [] } = {}) {
  const start = app.indexOf('function cancelHistoryLegacySummaryRetry')
  const end = app.indexOf('function historySyncMetadata', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return new Function(`
    const state = { bridgePlatform:${JSON.stringify(platform)} }
    let _historyLegacySummaryRetry = null
    const timers = []
    const calls = []
    const statuses = []
    const pending = ${JSON.stringify(responses)}.slice()
    const HISTORY_LEGACY_SUMMARY_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000, 60000, 90000]
    const HISTORY_LEGACY_SUMMARY_RETRY_MAX_ATTEMPTS = HISTORY_LEGACY_SUMMARY_RETRY_DELAYS_MS.length
    const query = { generation:1, accountKey:'account', includeAccount:false, status:'unavailable' }
    function normalizeBridgePlatform(value) { return String(value || '').trim().toLowerCase() === 'mt4' ? 'mt4' : 'mt5' }
    function historyQueryIsCurrent() { return true }
    function historyStableAccountKey() { return 'account' }
    function activeTabId() { return 'history' }
    function renderHistorySyncStatus(message, options) { statuses.push({ message, options }) }
    function toast() {}
    function setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length }
    function clearTimeout() {}
    function loadHistoryViews(options) {
      calls.push(options)
      return Promise.resolve(pending.shift() || {})
    }
    ${app.slice(start, end)}
    return (async () => {
      scheduleHistoryLegacySummaryRetry(query)
      const delays = []
      while (timers.length) {
        const timer = timers.shift()
        delays.push(timer.delay)
        await timer.callback()
        if (!pending.length && !_historyLegacySummaryRetry) break
      }
      return { delays, calls, statuses, queryStatus:query.status, retryActive:Boolean(_historyLegacySummaryRetry) }
    })()
  `)()
}

describe('history scope frontend contract', () => {
  it('restores foreground timers without referencing table-only request state', () => {
    const visibilityStart = app.indexOf('document.addEventListener("visibilitychange"')
    const visibilityEnd = app.indexOf('\n});', visibilityStart)
    expect(visibilityStart).toBeGreaterThanOrEqual(0)
    expect(visibilityEnd).toBeGreaterThan(visibilityStart)
    const handler = app.slice(visibilityStart, visibilityEnd)
    expect(handler).not.toContain('tableOnly')
    expect(handler).toContain('startLiveQuoteRefreshTimer()')
  })

  it('does not send a start override for the confirmed default platform range', () => {
    const params = loadRangeParamsHarness({
      from:'2024-01-01',
      meta:{ allowedStartDate:'2000-01-01', systemStartDate:'2024-01-01', actualEndDate:'2026-08-11' },
    })
    expect(params).toEqual({ history_scope:'platform' })
  })

  it('does not resend the confirmed all-history floor when an older preference exists', () => {
    const params = loadRangeParamsHarness({
      mode:'all',
      from:'2000-01-01',
      meta:{ allowedStartDate:'2000-01-01', systemStartDate:'2000-01-01', actualEndDate:'2026-08-11' },
      starts:{ all:'2020-01-01' },
    })
    expect(params).toEqual({ history_scope:'all' })
  })

  it('does not convert the all-history allowed floor into a timezone-sensitive override', () => {
    const params = loadRangeParamsHarness({
      mode:'all',
      from:'2000-01-01',
      meta:{ allowedStartDate:'2000-01-01', systemStartDate:'', actualEndDate:'2026-08-11' },
    })
    expect(params).toEqual({ history_scope:'all' })
  })

  it('does not resend a server-confirmed account preference as a transient override', () => {
    const params = loadRangeParamsHarness({
      from:'2020-01-01',
      meta:{ allowedStartDate:'2000-01-01', systemStartDate:'2024-01-01', actualEndDate:'2026-08-11' },
      starts:{ platform:'2020-01-01' },
    })
    expect(params).toEqual({ history_scope:'platform' })
  })

  it('still sends an unsaved date edit as a transient range override', () => {
    const params = loadRangeParamsHarness({
      from:'2020-01-01',
      meta:{ allowedStartDate:'2000-01-01', systemStartDate:'2024-01-01', actualEndDate:'2026-08-11' },
      starts:{ platform:'2021-01-01' },
    })
    expect(params).toMatchObject({ history_scope:'platform', scope_start_override:'2020-01-01' })
  })

  it('reads allowed, system and effective ranges nested under history_range', () => {
    const start = Date.UTC(2024, 0, 1, 0, 0, 0) - 8 * 60 * 60 * 1000
    const end = Date.UTC(2026, 7, 11, 0, 0, 0) - 8 * 60 * 60 * 1000
    const meta = loadScopeMeta({
      history_scope:'platform',
      history_sync:{ timezone_offset_minutes:480 },
      history_range:{
        allowed_range:{ range_start_utc_msc:start },
        system_range:{ range_start_utc_msc:Date.UTC(2024, 5, 1, 0, 0, 0) - 8 * 60 * 60 * 1000 },
        effective_range:{ range_start_utc_msc:Date.UTC(2023, 11, 1, 0, 0, 0) - 8 * 60 * 60 * 1000, range_end_utc_msc:end },
      },
    })
    expect(meta.allowedStartDate).toBe('2024-01-01')
    expect(meta.systemStartDate).toBe('2024-06-01')
    expect(meta.actualStartDate).toBe('2023-12-01')
    expect(meta.actualEndDate).toBe('2026-08-11')
    expect(meta.timezoneOffsetMinutes).toBe(480)
  })

  it('reads the persisted source-account start returned by the server', () => {
    const meta = loadScopeMeta({
      history_scope:'platform',
      preference:{ scope:'platform', start_date:'2026-06-01', source:'server_account' },
      history_range:{
        allowed_range:{ range_start_utc_msc:Date.UTC(2000, 0, 1) },
        system_range:{ range_start_utc_msc:Date.UTC(2026, 6, 27) },
        effective_range:{ range_start_utc_msc:Date.UTC(2026, 5, 1), range_end_utc_msc:Date.UTC(2026, 7, 11) },
      },
    })
    expect(meta.preferenceKnown).toBe(true)
    expect(meta.savedStartDate).toBe('2026-06-01')
    expect(meta.preferenceSource).toBe('server_account')
  })

  it('stores history starts only through the server and hides mutation controls in observer mode', () => {
    expect(app).not.toContain('aurum.ai.history-range')
    expect(app).not.toContain('historyPreferenceStorageKey')
    expect(app).not.toContain('readHistoryRangePreferences')
    expect(app).not.toContain('writeHistoryRangePreferences')
    expect(app).toContain('wsApi("history_range_preference_set"')
    expect(app).toContain('start_date:null')
    expect(app).toContain('save.hidden = custom || observer')
    expect(app).toContain('restore.hidden = custom || observer')
    expect(styles).toContain('.history-range-save[hidden],')
    expect(styles).toContain('.history-range-restore[hidden]')
    expect(styles).toContain('display: none !important;')
    expect(app).toContain('开始日期由观摩源账户设置')
    expect(app).not.toContain('"history_range_preference_set", "pending_list"')
  })

  it('keeps a frozen scope range while handing a filter change a fresh cursor key', () => {
    const result = loadCursorResetHarness()
    expect(result.handoff).toMatchObject({
      rangeStart:1000,
      rangeEnd:5000,
      snapshotId:null,
      preserveRangeOnKeyChange:true,
    })
    expect(result.handoff.cursors).toEqual([[1, null]])
    expect(result.next).toMatchObject({
      key:'scope-new-filter',
      rangeStart:1000,
      rangeEnd:5000,
      snapshotId:null,
      preserveRangeOnKeyChange:false,
    })
    expect(result.next.cursors).toEqual([[1, null]])

    const loadStart = app.indexOf('function loadHistory(forceRefresh')
    const loadEnd = app.indexOf('function _applyHistoryData', loadStart)
    const load = app.slice(loadStart, loadEnd)
    expect(load).toContain('const preserveFrozenRange = !forceRefresh')
    expect(load).toContain('preserveRange:preserveFrozenRange')
    expect(load).toContain('history_snapshot_id:_historyCursorState.snapshotId')
    expect(load).toContain('range_start_utc_msc:_historyCursorState.rangeStart')
    expect(load).toContain('range_end_utc_msc:_historyCursorState.rangeEnd')
    expect(load).toContain('(query || _historyQueryState)?.legacyFallback === true')
    expect(load).toContain('page === 1')
    expect(load).not.toContain('&& !_historyQueryState.frozenRange')
    expect(load).toContain('const legacyFrozenRange = historyPrepareRangeFromResponse(data)')
    expect(load).toContain('(query || _historyQueryState).frozenRange = legacyFrozenRange')
    expect(app).toContain('captured_end_utc_msc:Number(range.captured_end_utc_msc)')
  })

  it('starts table filter and chart drilldown requests with a new snapshot but preserves the scope endpoint', () => {
    const drillStart = app.indexOf('function applyHistoryChartDrilldown')
    const drillEnd = app.indexOf('function bindHistoryChartKeyboard', drillStart)
    const drill = app.slice(drillStart, drillEnd)
    expect(drill).toContain('resetHistoryCursorState(null, { preserveRange:true })')
    expect(drill).toContain('loadHistoryViews({ tableOnly:true })')

    const filterStart = app.indexOf("document.getElementById('historyFilterApply')")
    const filterEnd = app.indexOf('document.addEventListener("DOMContentLoaded"', filterStart)
    const filters = app.slice(filterStart, filterEnd)
    expect(filters).toContain('historyFilterApply')
    expect(filters).toContain('historyFilterReset')
    expect(filters).toContain('loadHistoryViews({ newQuery:true, trigger:"filter"')
    expect(filters).toContain('loadHistoryViews({ newQuery:true, trigger:"reset"')

    const applyStart = app.indexOf("document.getElementById('historyRangeApply')")
    const applyEnd = app.indexOf("document.getElementById('historyRangeSave')", applyStart)
    expect(app.slice(applyStart, applyEnd)).toContain('loadHistoryViews({ newQuery:true, trigger:"apply"')
    const restoreStart = app.indexOf("document.getElementById('historyRangeRestore')")
    const restoreEnd = app.indexOf('updateHistoryRangeUI();', restoreStart)
    expect(app.slice(restoreStart, restoreEnd)).toContain('loadHistoryViews({ newQuery:true, trigger:"reset"')

    const scopeStart = app.indexOf("document.getElementById('historyRangeMode')?.addEventListener('change'")
    const scopeEnd = app.indexOf("document.getElementById('historyRangeApply')", scopeStart)
    const scopeChange = app.slice(scopeStart, scopeEnd)
    expect(scopeStart).toBeGreaterThanOrEqual(0)
    expect(scopeEnd).toBeGreaterThan(scopeStart)
    expect(scopeChange).toContain('loadHistoryViews({ newQuery:true, trigger:"scope", forceRefresh:false })')
    expect(scopeChange).not.toContain('updateHistoryRangeUI({ pending:false })')

    const chartStart = app.indexOf('function loadHistoryChart')
    const chartEnd = app.indexOf('function loadHistoryViews', chartStart)
    const chart = app.slice(chartStart, chartEnd)
    expect(chart).toContain('range_start_utc_msc:_historyCursorState.rangeStart')
    expect(chart).toContain('range_end_utc_msc:_historyCursorState.rangeEnd')
    expect(chart).not.toContain('history_snapshot_id')
  })

  it('disables range mutation actions while a frozen range is being prepared', () => {
    const start = app.indexOf('function updateHistoryRangeUI')
    const end = app.indexOf('function historyRefreshContextKey', start)
    const update = app.slice(start, end)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(update).toContain('if (apply) apply.disabled = Boolean(pending)')
    expect(update).toContain('if (save) save.disabled = Boolean(pending)')
    expect(update).toContain('if (restore) restore.disabled = Boolean(pending)')
  })

  it('keeps chart bars and summary cards on the complete selected history scope', () => {
    const normalizeStart = app.indexOf('function normalizeHistoryChartData')
    const renderStart = app.indexOf('function _renderHistoryChart', normalizeStart)
    expect(normalizeStart).toBeGreaterThanOrEqual(0)
    expect(renderStart).toBeGreaterThan(normalizeStart)
    const normalize = app.slice(normalizeStart, renderStart)
    expect(normalize).toContain('data?.chart_data')
    expect(normalize).not.toContain('chart_30d')
    expect(normalize).not.toContain('daily.length > 30')
    expect(html).toContain('>总交易<')
    expect(html).toContain('>胜率<')
    expect(html).toContain('>盈亏比<')
    expect(html).toContain('>最大回撤<')
    expect(html).not.toContain('30天')
    expect(html).not.toContain('最近 30 天')
    expect(html).not.toContain('history-chart-heading')
    expect(html).not.toContain('historyChartTitle')
    expect(html).not.toContain('historyChartRange')
    expect(app).not.toContain('setText("historyChartRange"')
  })

  it('uses one frozen prepare/status generation before the single full history read', () => {
    expect(app).toContain('history_prepare_status_v1')
    expect(app).toContain('HISTORY_PREPARE_RETRY_DELAYS_MS = [200, 400, 800, 1000]')
    expect(app).toContain('historyPrepareParams(query)')
    expect(app).toContain('query.frozenRange = frozen')
    expect(app).toContain('disableFreshnessRetry:true')
    expect(app).toContain('loadHistoryViewsLegacy({\n          forceRefresh:false')
    expect(app).toContain('history_prepare_status_unsupported')
    expect(app).toContain('runHistoryLegacyFallback')
  })

  it('keeps an MT4 fallback response current after the server rehydrates range metadata', () => {
    const result = loadHistoryContextHarness()
    expect(result.matchesAfterResponseMeta).toBe(true)
    expect(result.responseKey).toBe(result.requestKey)
    expect(result.current).toBe(true)
  })

  it('invalidates a frozen history query when only the account context generation changes', () => {
    const result = loadHistoryContextHarness({ currentAccountContextGeneration:2 })
    expect(result.matchesAfterResponseMeta).toBe(false)
    expect(result.current).toBe(false)
  })

  it('sends MT4 history through the explicit query snapshot instead of mutable range and filter controls', async () => {
    const result = await loadHistoryRequestSnapshotHarness()
    expect(result).toMatchObject({
      action:'history',
      params:{
        history_scope:'platform',
        entry_from:'2026-08-01',
        filter_close_from:'2026-08-02',
        filter_close_to:'2026-08-03',
        direction:'buy',
        profit_filter:'loss',
      },
    })
    expect(result.params).not.toHaveProperty('scope_start_override')
  })

  it('does not report fallback success for an empty or stale result', async () => {
    const empty = await loadHistoryLegacyFallbackHarness(null)
    expect(empty.data).toBeNull()
    expect(empty.status).toBe('loading_snapshot')
    expect(empty.message).not.toContain('历史记录已更新')

    const stale = await loadHistoryLegacyFallbackHarness({ historyPending:false, historyStale:true })
    expect(stale.data).toBeNull()
    expect(stale.status).toBe('loading_snapshot')
    expect(stale.message).not.toContain('历史记录已更新')
  })

  it('fails closed until prepare status proves both exact range and summary readiness', () => {
    expect(loadHistoryPrepareReady({ history_sync:{} })).toBe(false)
    expect(loadHistoryPrepareReady({ history_sync:{ requested_range_complete:true } })).toBe(false)
    expect(loadHistoryPrepareReady({ history_sync:{ summary_status:'ready' } })).toBe(false)
    expect(loadHistoryPrepareReady({ history_sync:{ requested_range_complete:false, summary_status:'ready' } })).toBe(false)
    expect(loadHistoryPrepareReady({ history_sync:{ requested_range_complete:true, summary_status:'pending' } })).toBe(false)
    expect(loadHistoryPrepareReady({ history_sync:{ requested_range_complete:true, summary_status:'ready', history_revision:7, summary_revision:7 } })).toBe(true)
    expect(loadHistoryPrepareReady({ history_sync:{ requested_range_complete:true, summary_status:'complete', history_revision:0, summary_revision:0 } })).toBe(true)
    expect(loadHistoryPrepareReady({ history_sync:{ requested_range_complete:true, summary_status:'ready', history_revision:7, summary_revision:6 } })).toBe(false)
    expect(loadHistoryPrepareReady({ history_sync:{ requested_range_complete:true, summary_status:'ready', history_revision:'bad', summary_revision:7 } })).toBe(false)
    expect(app).toContain('sync.requested_range_complete !== true')
    expect(app).toContain('summary_status || ""')
    expect(app).toContain('Number.isSafeInteger(historyRevision)')
    expect(app).toContain('historyRevision !== summaryRevision')
  })

  it('preserves custom captured endpoint separately from system and effective ends', () => {
    const range = loadPreparedRange({
      history_range:{
        range_start_utc_msc:1000,
        range_end_utc_msc:2000,
        captured_end_utc_msc:3000,
        allowed_range:{ start_utc_msc:500, end_utc_msc:4000 },
        system_range:{ start_utc_msc:700, end_utc_msc:5000 },
        effective_range:{ start_utc_msc:1000, end_utc_msc:2000, captured_end_utc_msc:3000 },
      },
      history_sync:{ requested_range_complete:true, summary_status:'ready' },
    })
    expect(range).toMatchObject({
      range_start_utc_msc:1000,
      range_end_utc_msc:2000,
      captured_end_utc_msc:3000,
      system_range:{ start_utc_msc:700, end_utc_msc:5000 },
      effective_range:{ start_utc_msc:1000, end_utc_msc:2000, captured_end_utc_msc:3000 },
    })
    expect(app).toContain('Preserve server-provided allowed/system/effective ends')
  })

  it('preserves the server-confirmed start override on opaque cursor continuations', () => {
    const range = loadPreparedRange({
      history_range:{
        scope:'platform',
        range_start_utc_msc:1000,
        range_end_utc_msc:3000,
        captured_end_utc_msc:3000,
        allowed_start_utc_msc:500,
        system_start_utc_msc:2000,
        effective_start_utc_msc:1000,
        scope_start_override:'2026-07-27',
      },
    })
    expect(range).toMatchObject({ scope_start_override:'2026-07-27' })
    expect(app).toContain('{ scope_start_override:String(range.scope_start_override) }')
  })

  it('never retries a second full history package after a ready-read range race', async () => {
    const result = await loadHistoryQuerySingleReadHarness()
    expect(result).toMatchObject({
      reads:1,
      fullReadCount:1,
      status:'unavailable',
      code:'history_cursor_range_incomplete',
    })
    expect(result.message).toContain('读取期间历史范围发生变化')
    const query = app.slice(app.indexOf('async function runHistoryQuery'), app.indexOf('function historySummaryReadyForRequestedRange'))
    const race = query.slice(query.indexOf('if (isHistoryCursorRangeIncomplete(error)'), query.indexOf('if (!historyQueryIsCurrent(query)) return null;', query.indexOf('if (isHistoryCursorRangeIncomplete(error)')))
    expect(race).not.toContain('loadHistoryViewsLegacy(')
  })

  it('does not report legacy fallback success while range statistics are still pending', async () => {
    const result = await loadHistoryLegacyFallbackHarness({ historyPending:false, summaryPending:true })
    expect(result).toMatchObject({
      status:'unavailable',
      fullReadCount:1,
      tone:'warning',
    })
    expect(result.message).toContain('交易记录已显示')
    expect(result.message).toContain('范围统计仍在准备中')
  })

  it('reads the local MT4 archive for entry and range changes but preserves explicit refresh', async () => {
    const enter = await loadHistoryLegacyFallbackHarness({ historyPending:false, summaryPending:false })
    expect(enter.legacyOptions).toMatchObject({ forceRefresh:false, manualRefresh:false })

    const refresh = await loadHistoryLegacyFallbackHarness(
      { historyPending:false, summaryPending:false },
      { forceRefresh:true, manualRefresh:true },
    )
    expect(refresh.legacyOptions).toMatchObject({ forceRefresh:true, manualRefresh:true })
  })

  it('auto-retries only the MT4 legacy summary on a bounded backoff', async () => {
    const result = await loadHistoryLegacySummaryRetryHarness({
      platform:'mt4',
      responses:[{ historyPending:false, summaryPending:true }, { historyPending:false, summaryPending:false }],
    })
    expect(result.delays).toEqual([2000, 5000])
    expect(result.calls).toHaveLength(2)
    expect(result.calls[0]).toMatchObject({ forceRefresh:false, historyRetryAttempt:true, skipPrepare:true })
    expect(result.calls[0]).not.toHaveProperty('manualRefresh', true)
    expect(result.queryStatus).toBe('ready')
    expect(result.retryActive).toBe(false)
    expect(result.statuses.at(-1).message).toContain('范围统计已完成')
    expect(app).toContain('HISTORY_LEGACY_SUMMARY_RETRY_MAX_ATTEMPTS = HISTORY_LEGACY_SUMMARY_RETRY_DELAYS_MS.length')
    expect(app).toContain('[2000, 5000, 10000, 20000, 30000, 60000, 90000]')
  })

  it('does not schedule the legacy summary retry for MT5', async () => {
    const result = await loadHistoryLegacySummaryRetryHarness({
      platform:'mt5',
      responses:[{ historyPending:false, summaryPending:true }],
    })
    expect(result.delays).toEqual([])
    expect(result.calls).toEqual([])
    expect(result.retryActive).toBe(false)
  })

  it('does not treat an empty or stale retry response as success', async () => {
    const result = await loadHistoryLegacySummaryRetryHarness({
      platform:'mt4',
      responses:[null, { historyPending:false, summaryPending:false, historyStale:true }, { historyPending:false, summaryPending:false, historyStale:false }],
    })
    expect(result.delays).toEqual([2000, 5000, 10000])
    expect(result.calls).toHaveLength(3)
    expect(result.queryStatus).toBe('ready')
    expect(result.retryActive).toBe(false)
  })

  it('stops after seven pending legacy summary attempts', async () => {
    const result = await loadHistoryLegacySummaryRetryHarness({
      platform:'mt4',
      responses:Array.from({ length:7 }, () => ({ historyPending:false, summaryPending:true })),
    })
    expect(result.delays).toEqual([2000, 5000, 10000, 20000, 30000, 60000, 90000])
    expect(result.calls).toHaveLength(7)
    expect(result.queryStatus).toBe('unavailable')
    expect(result.retryActive).toBe(false)
    expect(result.statuses.at(-1).message).toContain('准备时间较长')
  })

  it('advances generations only for explicit history operations and invalidates stale responses', () => {
    expect(app).toContain('historyQueryGeneration: 0')
    expect(app).toContain('history_query_generation:Number(query?.generation ?? state.historyQueryGeneration ?? 0)')
    expect(app).toContain('loadHistoryViews({ newQuery:true, trigger:"enter"')
    expect(app).toContain('loadHistoryViews({ newQuery:true, trigger:"apply"')
    expect(app).toContain('loadHistoryViews({ newQuery:true, trigger:"filter"')
    expect(app).toContain('loadHistoryViews({ newQuery:true, trigger:"reset"')
    expect(app).toContain('activeTabId() === "history"')
    expect(app).toContain('clearHistoryPresentation({ syncing:true })')
  })

  it('does not reuse a snapshot on page one and keeps ticket maps out of status checks', () => {
    expect(app).toContain('page > 1 && _historyCursorState.snapshotId')
    const pagerStart = app.indexOf('if (pagerButton && !pagerButton.disabled)')
    const pagerEnd = app.indexOf('if (actionButton)', pagerStart)
    const pager = app.slice(pagerStart, pagerEnd)
    expect(pager).toContain('page === 1 && previousPage > 1')
    expect(pager).toContain('_historyCursorState.snapshotId = null')
    expect(pager).toContain('_historyCursorState.pageCursors = new Map([[1, null]])')
    const prepareStart = app.indexOf('async function runHistoryPrepare')
    const prepareEnd = app.indexOf('async function runHistoryLegacyFallback', prepareStart)
    const prepare = app.slice(prepareStart, prepareEnd)
    expect(prepare).not.toContain('loadSignalTickets')
    expect(prepare).not.toContain('loadCloseSignalTickets')
    expect(app).toContain('_historyTicketMapCache')
    expect(app).toContain('_historyTicketMapFlights')
    const ticketBindingStart = app.indexOf('async function loadHistoryTicketMapsForData')
    const ticketBindingEnd = app.indexOf('function historyPrepareRangeFromResponse', ticketBindingStart)
    const ticketBinding = app.slice(ticketBindingStart, ticketBindingEnd)
    expect(ticketBinding).toContain('Promise.all([')
    expect(ticketBinding).toContain('loader({ historyRevision })')
    expect(ticketBinding).toContain('loadMap(loadSignalTickets)')
    expect(ticketBinding).toContain('loadMap(loadCloseSignalTickets)')
    const tableStart = app.indexOf('function loadHistory(forceRefresh')
    const tableEnd = app.indexOf('function _applyHistoryData', tableStart)
    const table = app.slice(tableStart, tableEnd)
    expect(table).toContain('await loadHistoryTicketMapsForData(cachedData)')
    expect(table).toContain('await loadHistoryTicketMapsForData(data)')
    expect(table.indexOf('await loadHistoryTicketMapsForData(cachedData)')).toBeLessThan(table.indexOf('_applyHistoryData(cachedData'))
    expect(table.indexOf('await loadHistoryTicketMapsForData(data)')).toBeLessThan(table.indexOf('_applyHistoryData(data'))
  })
})
