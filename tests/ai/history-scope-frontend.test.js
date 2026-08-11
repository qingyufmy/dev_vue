import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

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

  it('sends an early platform start only after the server has established the allowed floor', () => {
    const params = loadRangeParamsHarness({
      from:'2020-01-01',
      meta:{ allowedStartDate:'2000-01-01', systemStartDate:'2024-01-01', actualEndDate:'2026-08-11' },
      starts:{ platform:'2020-01-01' },
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
    expect(filters.match(/resetHistoryCursorState\(null, \{ preserveRange:true \}\)/g)?.length).toBe(2)
    expect(filters).toContain('loadHistoryViews({ forceRefresh:false, tableOnly:true })')

    const applyStart = app.indexOf("document.getElementById('historyRangeApply')")
    const applyEnd = app.indexOf("document.getElementById('historyRangeSave')", applyStart)
    expect(app.slice(applyStart, applyEnd)).toContain('resetHistoryCursorState(null)')
    const restoreStart = app.indexOf("document.getElementById('historyRangeRestore')")
    const restoreEnd = app.indexOf('updateHistoryRangeUI();', restoreStart)
    expect(app.slice(restoreStart, restoreEnd)).toContain('resetHistoryCursorState(null)')

    const chartStart = app.indexOf('function loadHistoryChart')
    const chartEnd = app.indexOf('function loadHistoryViews', chartStart)
    const chart = app.slice(chartStart, chartEnd)
    expect(chart).toContain('range_start_utc_msc:_historyCursorState.rangeStart')
    expect(chart).toContain('range_end_utc_msc:_historyCursorState.rangeEnd')
    expect(chart).not.toContain('history_snapshot_id')
  })
})
