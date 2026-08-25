import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { readFileSync } from 'node:fs'

vi.mock('../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-06 22:00:00'),
}))

vi.mock('../server/config.js', () => ({
  JWT_SECRET: 'test-secret',
  DEFAULT_API_BASE_URL: 'https://api.deepseek.com',
  ADMIN_CACHE_TTL_MS: 300000,
  CORS_ORIGINS: ['localhost:3000', '192.168.1.254', 'cnfxtrade.com'],
}))

vi.mock('../server/redis.js', () => ({
  getRedis: vi.fn(),
  isRedisAvailable: vi.fn(() => false),
}))

vi.mock('../server/middleware/auth.js', () => ({
  tokenVersionMatches:vi.fn((decoded, user) => Number(decoded?.tokenVersion || 0) === Number(user?.token_version || 0)),
  authMiddleware:vi.fn((req, res, next) => next?.()),
}))

const mockWs = {
  readyState: 1,
  send: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  ping: vi.fn(),
  _userId: null,
}

const mockWss = {
  on: vi.fn(),
  emit: vi.fn(),
  handleUpgrade: vi.fn((req, socket, head, cb) => cb(mockWs)),
}

vi.mock('ws', () => ({
  WebSocketServer: vi.fn(() => mockWss),
}))

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(() => ({ userId: 42 })),
  },
}))

const { mockBridgeV3Business, mockHistoryReadsEnabled } = vi.hoisted(() => ({
  mockHistoryReadsEnabled: vi.fn(() => true),
  mockBridgeV3Business: {
    hasConnectedTerminal: vi.fn(() => false),
    isTradeEnabled: vi.fn(() => false),
    connectedTerminals: vi.fn(() => []),
    connectedUsers: vi.fn(() => []),
    getGeneration: vi.fn(() => null),
    supports: vi.fn(() => false),
    execute: vi.fn(),
  },
}))

vi.mock('../server/bridge-v3/business-adapter.js', () => ({
  createBridgeV3BusinessAdapter: vi.fn(() => mockBridgeV3Business),
  isBridgeHistoryReadsEnabled: mockHistoryReadsEnabled,
  bridgeHistoryTemporarilyUnavailableResult: vi.fn(() => ({
    status:'error', code:'bridge_history_temporarily_unavailable',
    error:'bridge_history_temporarily_unavailable', message:'bridge_history_temporarily_unavailable',
  })),
}))

import { WebSocketServer } from 'ws'

import {
  initBridgeWS,
  sendBridgeCommand,
  bindExecutionClockRouteParams,
  isBridgeAlive,
  isTradeEnabled,
  getOwnBridgeMarketState,
  getBridgeTradeMode,
  getAllBridges,
  getConnectedBridgeStats,
  getBridgeDiagnostics,
  sendToBrowsers,
  collectTradeRefs,
  buildSignalRefIndex,
  buildSignalPendingActions,
  normalizeBridgeMarketState,
  recordBridgeMarketState,
  buildBrowserHeartbeatClock,
  applyDefaultObserverClockBootstrap,
  getPlatformMarketClockState,
  getLatestBridgeMt5Clock,
  sendToAdminBrowsers,
  disconnectUserSockets,
  broadcastAdminEvent,
  browserSessionToken,
  BRIDGE_WS_LIMITS,
  isAllowedBrowserWsOrigin,
  normalizeBridgePage,
  normalizeBridgePageSize,
  boundedHistoryExportPageCount,
  safeHistoryRangeEndUtcMsc,
  isHistoryExportComplete,
  HISTORY_COVERAGE_START_UTC_MSC,
  HISTORY_EXACT_RANGE_CAPABILITY,
  HISTORY_CURSOR_CAPABILITY,
  HISTORY_PREPARE_STATUS_CAPABILITY,
  hasHistoryExactRangeCapability,
  hasHistoryCursorCapability,
  hasHistoryPrepareStatusCapability,
  captureHistoryTerminalNowUtcMsc,
  resolveHistoryRange,
  setHistoryRangePreference,
  historyQueryFloor,
  HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
  mapBridgePerformanceSummaryResult,
  getBridgePerformanceSummary,
  enrichHistoryProtectionRows,
  wsMessageByteLength,
  buildBrowserCommandResult,
  runBrowserAutoExecuteWithModelTask,
  sendNotificationCreatedToUser,
  buildBridgeDataChangedEvent,
  buildObserverBrowserPayload,
  createBrowserAutoExecuteGuard,
  isBrowserSocketRegistered,
  buildBridgeTerminalIdentity,
  classifyBridgeIdentityEvent,
} from '../server/bridge-ws.js'
import { queryOne, withTransaction } from '../server/db.js'

describe('bridge-ws.js – exported API shape', () => {
  it('initBridgeWS is exported as function', () => {
    expect(typeof initBridgeWS).toBe('function')
  })

  it('sendBridgeCommand is exported as function', () => {
    expect(typeof sendBridgeCommand).toBe('function')
  })

  it('preserves the browser correlation id when bridge results contain their own command id', () => {
    expect(buildBrowserCommandResult('ws_42', {
      type:'command_result',
      command_id:'command_v3',
      status:'rejected',
    })).toEqual({ type:'result', command_id:'ws_42', status:'rejected' })
  })

  it('isBridgeAlive is exported as function', () => {
    expect(typeof isBridgeAlive).toBe('function')
  })

  it('isTradeEnabled is exported as function', () => {
    expect(typeof isTradeEnabled).toBe('function')
  })

  it('getOwnBridgeMarketState is exported as function', () => {
    expect(typeof getOwnBridgeMarketState).toBe('function')
  })

  it('getBridgeTradeMode is exported as function', () => {
    expect(typeof getBridgeTradeMode).toBe('function')
  })

  it('getAllBridges is exported as function', () => {
    expect(typeof getAllBridges).toBe('function')
  })

  it('getBridgeDiagnostics is exported as function', () => {
    expect(typeof getBridgeDiagnostics).toBe('function')
  })

  it('sendToBrowsers is exported as function', () => {
    expect(typeof sendToBrowsers).toBe('function')
  })

  it('admin realtime broadcast helpers are exported as functions', () => {
    expect(typeof sendToAdminBrowsers).toBe('function')
    expect(typeof broadcastAdminEvent).toBe('function')
  })
})

describe('history range preference migration contract', () => {
  it('appends migration 179 with source-account scope uniqueness', () => {
    const source = readFileSync(new URL('../server/migrations.js', import.meta.url), 'utf8')
    expect(source).toContain("id: '179_history_range_preferences'")
    expect(source.lastIndexOf("id: '179_history_range_preferences'")).toBeGreaterThan(
      source.lastIndexOf("id: '178_manual_trade_strategy_review'"),
    )
    expect(source).toContain('CREATE TABLE IF NOT EXISTS history_range_preferences')
    expect(source).toContain('start_date DATE NOT NULL')
    expect(source).toContain(
      'UNIQUE KEY uk_history_range_preference_account_scope (user_id, trading_account_id, scope)',
    )
  })

  it('keeps the preference write outside the observer read allowlist', () => {
    const observerAccess = readFileSync(new URL('../server/routes/ai/observer-access.js', import.meta.url), 'utf8')
    expect(observerAccess).not.toContain("'history_range_preference_set'")
  })
})

describe('browser websocket authentication transport', () => {
  it('reads the shared session from the cookie and ignores query JWTs by default', () => {
    const url = new URL('http://localhost/aurum-api/bridge/ws?type=browser&token=query-secret')
    const req = { headers:{ cookie:'theme=dark; ws_token=cookie-secret' } }
    expect(browserSessionToken(req, url)).toBe('cookie-secret')
    expect(browserSessionToken({ headers:{} }, url)).toBeNull()
  })

  it('accepts configured browser origins and rejects missing or foreign origins', () => {
    expect(isAllowedBrowserWsOrigin({ headers:{ origin:'http://localhost:3000' } }, 'browser')).toBe(true)
    expect(isAllowedBrowserWsOrigin({ headers:{ origin:'https://cnfxtrade.com' } }, 'admin')).toBe(true)
    expect(isAllowedBrowserWsOrigin({ headers:{ origin:'http://192.168.1.254' } }, 'browser')).toBe(true)
    expect(isAllowedBrowserWsOrigin({ headers:{ origin:'https://ai.cnfxtrade.com' } }, 'admin')).toBe(true)
    expect(isAllowedBrowserWsOrigin({ headers:{} }, 'browser')).toBe(false)
    expect(isAllowedBrowserWsOrigin({ headers:{ origin:'https://evil.example' } }, 'browser')).toBe(false)
    expect(isAllowedBrowserWsOrigin({ headers:{ origin:'https://evil-cnfxtrade.com' } }, 'browser')).toBe(false)
    expect(isAllowedBrowserWsOrigin({ headers:{} }, 'bridge')).toBe(true)
  })

  it('counts UTF-8 websocket payload bytes accurately', () => {
    expect(wsMessageByteLength('abc')).toBe(3)
    expect(wsMessageByteLength('交易')).toBe(6)
    expect(wsMessageByteLength(Buffer.alloc(7))).toBe(7)
  })
})

describe('bridge history pagination bounds', () => {
  it('normalizes invalid pages and caps browser-requested result sizes', () => {
    expect(normalizeBridgePage('2')).toBe(2)
    expect(normalizeBridgePage('-1')).toBe(1)
    expect(normalizeBridgePage(Number.MAX_SAFE_INTEGER)).toBe(1_000_000)
    expect(normalizeBridgePageSize('50')).toBe(50)
    expect(normalizeBridgePageSize('9999')).toBe(200)
    expect(normalizeBridgePageSize('invalid')).toBe(20)
  })
})

describe('bridge history range/export completeness contract', () => {
  it('rejects synchronous exports that exceed the bounded page budget', () => {
    expect(boundedHistoryExportPageCount(50)).toEqual({ ok:true, total_pages:50 })
    expect(boundedHistoryExportPageCount(51)).toEqual({
      ok:false, code:'history_export_range_too_large', total_pages:51,
    })
    expect(boundedHistoryExportPageCount('invalid')).toEqual({
      ok:false, code:'history_export_pagination_invalid',
    })
  })

  it('accepts only safe positive UTC millisecond bounds', () => {
    expect(safeHistoryRangeEndUtcMsc(1_754_665_920_000)).toBe(1_754_665_920_000)
    expect(safeHistoryRangeEndUtcMsc(0)).toBeNull()
    expect(safeHistoryRangeEndUtcMsc(-1)).toBeNull()
    expect(safeHistoryRangeEndUtcMsc(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
  })

  it('caps an explicit date_to at its exclusive UTC next-day boundary', () => {
    const now = Date.parse('2026-08-08T12:00:00.000Z')
    expect(safeHistoryRangeEndUtcMsc(now, '2026-08-07'))
      .toBe(Date.parse('2026-08-08T00:00:00.000Z'))
    expect(safeHistoryRangeEndUtcMsc(now, '2026-08-08')).toBe(now)
    expect(safeHistoryRangeEndUtcMsc(now, '2026-08-09')).toBe(now)
    expect(safeHistoryRangeEndUtcMsc(now, '2026-02-30')).toBe(now)
    expect(safeHistoryRangeEndUtcMsc(now, 'not-a-date')).toBe(now)
  })

  it('uses requested range completeness for explicit platform/custom ranges', () => {
    expect(isHistoryExportComplete({
      range:{ scope:'platform', date_from:'2026-01-01' },
      historySync:{ requested_range_complete:true, archive_complete:false, complete:false },
    })).toBe(true)
    expect(isHistoryExportComplete({
      range:{ scope:'custom', date_from:'2026-01-01' },
      historySync:{ requested_range_complete:false, archive_complete:true, complete:true },
    })).toBe(false)
  })

  it('falls back to legacy complete when new range fields are absent', () => {
    expect(isHistoryExportComplete({
      range:{ scope:'custom', date_from:'2026-01-01' },
      historySync:{ complete:true },
    })).toBe(true)
    expect(isHistoryExportComplete({
      range:{ scope:'custom', date_from:'2026-01-01' },
      historySync:{ complete:false },
    })).toBe(false)
  })

  it('requires archive completeness for all-time exports', () => {
    expect(isHistoryExportComplete({
      range:{ scope:'all', date_from:null },
      historySync:{ archive_complete:true, complete:false },
    })).toBe(true)
    expect(isHistoryExportComplete({
      range:{ scope:'all', date_from:null },
      historySync:{ archive_complete:false, complete:true },
    })).toBe(false)
    expect(isHistoryExportComplete({
      range:{ scope:'all', date_from:null },
      historySync:{ complete:true },
    })).toBe(true)
  })

  it('fails closed when the bridge reports truncated evidence', () => {
    expect(isHistoryExportComplete({
      range:{ scope:'custom', date_from:'2026-01-01' },
      historySync:{ requested_range_complete:true, evidence_truncated:true },
    })).toBe(false)
    expect(isHistoryExportComplete({
      range:{ scope:'all' },
      historySync:{ archive_complete:true },
      result:{ evidence_truncated:true },
    })).toBe(false)
  })

  it('captures one fixed exact range outside the pagination loop without date fallback', () => {
    const source = readFileSync(new URL('../server/bridge-ws.js', import.meta.url), 'utf8')
    const start = source.indexOf("case 'export_history'")
    const end = source.indexOf("case 'toggle_close'", start)
    const block = source.slice(start, end)
    expect(block).not.toContain('safeHistoryRangeEndUtcMsc(')
    expect(block).toContain('resolveHistoryRange(expUserId, params, exportRoute, exportNowUtcMsc)')
    expect(block).toContain('range_start_utc_msc: exportRange.range_start_utc_msc')
    expect(block).toContain('range_end_utc_msc: exportRange.range_end_utc_msc')
    expect(block.indexOf('exportRange =')).toBeLessThan(block.indexOf('for (let page'))
    expect(block).not.toContain('exportBridgeParams.date_from')
    expect(block).not.toContain('exportBridgeParams.date_to')
    expect(block).toContain("exportCursorMode ? 'history_page' : 'history'")
    expect(block).toContain('{ history_snapshot_id:exportSnapshotId }')
    expect(block).toContain('{ cursor:exportCursor }')
    expect(block).toContain("exportErrorCode = 'history_export_cursor_invalid'")
  })

  it('requires the exact-range route capability', () => {
    expect(HISTORY_EXACT_RANGE_CAPABILITY).toBe('history_exact_range_v1')
    expect(hasHistoryExactRangeCapability({ capabilities:['history_exact_range_v1'] })).toBe(true)
    expect(hasHistoryExactRangeCapability({ capabilities:new Set(['history_exact_range_v1']) })).toBe(true)
    expect(hasHistoryExactRangeCapability({ capabilities:['history_cursor_v1'] })).toBe(false)
    expect(hasHistoryExactRangeCapability(null)).toBe(false)
    expect(HISTORY_CURSOR_CAPABILITY).toBe('history_cursor_v1')
    expect(hasHistoryCursorCapability({ capabilities:['history_cursor_v1'] })).toBe(true)
    expect(hasHistoryCursorCapability({ capabilities:['history_exact_range_v1'] })).toBe(false)
    expect(HISTORY_PREPARE_STATUS_CAPABILITY).toBe('history_prepare_status_v1')
    expect(hasHistoryPrepareStatusCapability({ capabilities:['history_prepare_status_v1'] })).toBe(true)
    expect(hasHistoryPrepareStatusCapability({ capabilities:new Set(['history_prepare_status_v1']) })).toBe(true)
    expect(hasHistoryPrepareStatusCapability({ capabilities:['history_exact_range_v1'] })).toBe(false)
  })

  it('captures history now only when the selected terminal clock is trusted', () => {
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    expect(captureHistoryTerminalNowUtcMsc(42, {
      clock:{ timezone_offset_minutes:180, clock_status:'persisted' },
    }, now)).toBe(now)
    expect(() => captureHistoryTerminalNowUtcMsc(42, {
      clock:{ timezone_offset_minutes:180, clock_status:'unavailable' },
    }, now)).toThrowError('bridge_history_terminal_clock_unavailable')
  })

  it('resolves exact history ranges from the binding coverage start and proves route/account query ownership', async () => {
    const route = {
      terminal_instance_id:'terminal-history-1',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1'],
      history_supported_start_utc_msc:HISTORY_COVERAGE_START_UTC_MSC,
    }
    const registrationStart = Date.parse('2026-01-01T00:00:00.000Z')
    const ownershipStart = Date.parse('2026-08-08T12:30:00.000Z')
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    queryOne.mockResolvedValue({
      first_connected_utc_msc:registrationStart,
      ownership_start_utc_msc:ownershipStart,
      ownership_history_id:77,
    })

    const all = await resolveHistoryRange(42, {}, route, now)
    expect(all).toMatchObject({
      scope:'all', requested_scope:'all',
      range_start_utc_msc:HISTORY_COVERAGE_START_UTC_MSC, range_end_utc_msc:now,
      first_connected_utc_msc:registrationStart,
      ownership_start_utc_msc:ownershipStart, ownership_revision:'77',
    })
    const [query, queryParams] = queryOne.mock.calls.at(-1)
    expect(query).toContain('mt5_account_bindings')
    expect(query).toContain('trading_accounts')
    expect(query).toContain('mt5_account_ownership_history')
    expect(query).toContain('bindings.first_connected_at')
    expect(query).toContain('UNIX_TIMESTAMP(bindings.first_connected_at)')
    expect(query).not.toContain('JOIN users binding_user')
    expect(query).not.toContain('binding_user.created_at')
    expect(query).not.toContain('ta.first_verified_at')
    expect(query).not.toContain('bindings.created_at')
    expect(query).toContain('UPPER(bindings.broker_server_key) = UPPER(?)')
    expect(queryParams).toEqual([42, 'Broker-Demo', '123456'])

    queryOne.mockResolvedValue({
      first_connected_utc_msc:registrationStart,
      ownership_start_utc_msc:ownershipStart,
      ownership_history_id:77,
    })
    const platform = await resolveHistoryRange(42, { history_scope:'platform' }, route, now)
    expect(platform).toMatchObject({
      scope:'platform', range_start_utc_msc:registrationStart,
      range_end_utc_msc:now, first_connected_utc_msc:registrationStart,
      ownership_start_utc_msc:ownershipStart,
    })

    queryOne.mockResolvedValue({
      first_connected_utc_msc:registrationStart,
      ownership_start_utc_msc:ownershipStart,
      ownership_history_id:77,
    })
    const custom = await resolveHistoryRange(42, {
      history_scope:'custom', close_from:'2026-07-01', close_to:'2026-08-09',
    }, route, now)
    expect(custom).toMatchObject({
      scope:'custom', range_start_utc_msc:Date.parse('2026-07-01T00:00:00.000Z'),
      range_end_utc_msc:Date.parse('2026-08-10T00:00:00.000Z'),
    })

    queryOne.mockResolvedValue({
      first_connected_utc_msc:registrationStart,
      ownership_start_utc_msc:ownershipStart,
      ownership_history_id:77,
    })
    await expect(resolveHistoryRange(42, {
      history_scope:'custom', close_from:'2024-12-31', close_to:'2026-01-01',
    }, route, now)).rejects.toMatchObject({ code:'bridge_history_before_supported_start' })

    for (const params of [
      { history_scope:'custom' },
      { history_scope:'custom', close_from:'2026-02-30' },
      { history_scope:'custom', close_from:'2026-08-08', close_to:'2026-08-07' },
      { history_scope:'unknown' },
    ]) {
      queryOne.mockResolvedValue({
        first_connected_utc_msc:registrationStart,
        ownership_start_utc_msc:ownershipStart,
        ownership_history_id:77,
      })
      await expect(resolveHistoryRange(42, params, route, now))
        .rejects.toMatchObject({ code:expect.stringMatching(/^bridge_history_/) })
    }
  })

  it('keeps hidden ownership compatibility separate from platform/all and fails closed without route/ownership', async () => {
    const route = {
      terminal_instance_id:'terminal-history-2',
      account_ref:{ broker_server:'Broker-Demo', login:'654321' },
      capabilities:['history_exact_range_v1'],
    }
    const ownershipStart = Date.parse('2026-08-08T12:30:00.000Z')
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    for (const [scope, expectedStart] of [
      ['ownership', ownershipStart],
      ['platform', Date.parse('2026-01-01T00:00:00.000Z')],
      ['all', HISTORY_ABSOLUTE_FLOOR_UTC_MSC],
    ]) {
      queryOne.mockResolvedValue({
        first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'),
        ownership_start_utc_msc:ownershipStart,
        ownership_history_id:12,
      })
      const range = await resolveHistoryRange(42, { history_scope:scope }, route, now)
      expect(range.range_start_utc_msc).toBe(expectedStart)
      expect(range.range_end_utc_msc).toBe(now)
    }
    await expect(resolveHistoryRange(42, {}, null, now))
      .rejects.toMatchObject({ code:'bridge_history_route_required' })
    queryOne.mockResolvedValue(null)
    await expect(resolveHistoryRange(42, {}, route, now))
      .rejects.toMatchObject({ code:'bridge_history_binding_unavailable' })
  })

  it('does not change all/platform history starts when the current ownership period is newer', async () => {
    const route = {
      terminal_instance_id:'terminal-history-rebound',
      account_ref:{ broker_server:'Broker-Demo', login:'999999' },
      capabilities:['history_exact_range_v1'],
    }
    const firstConnected = Date.parse('2024-03-01T00:00:00.000Z')
    const reboundOwnership = Date.parse('2026-08-08T12:30:00.000Z')
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    queryOne.mockResolvedValue({
      first_connected_utc_msc:firstConnected,
      ownership_start_utc_msc:reboundOwnership,
      ownership_history_id:88,
    })
    const all = await resolveHistoryRange(42, { history_scope:'all' }, route, now)
    const platform = await resolveHistoryRange(42, { history_scope:'platform' }, route, now)
    expect(all.range_start_utc_msc).toBe(HISTORY_ABSOLUTE_FLOOR_UTC_MSC)
    expect(platform.range_start_utc_msc).toBe(firstConnected)
    expect(all.range_start_utc_msc).toBeLessThan(reboundOwnership)
    expect(platform.range_start_utc_msc).toBeLessThan(reboundOwnership)
  })

  it('freezes allowed/system/effective ranges and accepts a bounded pre-binding override', async () => {
    const route = {
      terminal_instance_id:'terminal-history-override', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'555555' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1'],
      history_visible_start_utc_msc:Date.parse('2025-01-01T00:00:00.000Z'),
    }
    const firstConnected = Date.parse('2026-01-10T12:00:00.000Z')
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    queryOne.mockResolvedValue({ first_connected_utc_msc:firstConnected,
      ownership_start_utc_msc:Date.parse('2026-08-08T12:30:00.000Z'), ownership_history_id:77 })

    expect(historyQueryFloor(route)).toBe(HISTORY_COVERAGE_START_UTC_MSC)
    expect(historyQueryFloor({ history_visible_start_utc_msc:Date.parse('2026-01-01T00:00:00.000Z') }))
      .toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(HISTORY_ABSOLUTE_FLOOR_UTC_MSC).toBe(Date.parse('2000-01-01T00:00:00.000Z'))

    const range = await resolveHistoryRange(42, {
      history_scope:'platform', scope_start_override:'2025-02-01',
      filter_close_from:'2025-03-01', filter_close_to:'2025-04-01',
    }, route, now)
    expect(range).toMatchObject({
      allowed_start_utc_msc:HISTORY_COVERAGE_START_UTC_MSC,
      system_start_utc_msc:firstConnected,
      effective_start_utc_msc:Date.parse('2025-02-01T00:00:00.000Z'),
      captured_end_utc_msc:now,
      override_applied:true,
      effective_range:{ start_utc_msc:Date.parse('2025-02-01T00:00:00.000Z'), end_utc_msc:now },
    })
    expect(range.filter_close_from_utc_msc).toBe(Date.parse('2025-03-01T00:00:00.000Z'))
    expect(range.filter_close_to_utc_msc).toBe(Date.parse('2025-04-02T00:00:00.000Z'))

    await expect(resolveHistoryRange(42, {
      history_scope:'platform', scope_start_override:'1999-12-31',
    }, route, now)).rejects.toMatchObject({ code:'bridge_history_scope_start_out_of_range' })
    await expect(resolveHistoryRange(42, {
      history_scope:'platform', scope_start_override:'2026-08-11',
    }, route, now)).rejects.toMatchObject({ code:'bridge_history_scope_start_out_of_range' })
  })

  it('uses requested_range_complete for exact export ranges', () => {
    expect(isHistoryExportComplete({
      range:{ range_start_utc_msc:1_700_000_000_000, range_end_utc_msc:1_700_000_001_000 },
      historySync:{ requested_range_complete:true, complete:false },
    })).toBe(true)
    expect(isHistoryExportComplete({
      range:{ range_start_utc_msc:1_700_000_000_000, range_end_utc_msc:1_700_000_001_000 },
      historySync:{ requested_range_complete:false, complete:true },
    })).toBe(false)
    expect(isHistoryExportComplete({
      range:{ range_start_utc_msc:1_700_000_000_000, range_end_utc_msc:1_700_000_001_000 },
      historySync:{ complete:true },
    })).toBe(false)
    expect(isHistoryExportComplete({
      range:{ range_start_utc_msc:-1, range_end_utc_msc:1_700_000_001_000 },
      historySync:{ archive_complete:true, complete:true },
    })).toBe(false)
  })

  it('resolves date bounds at the terminal business-day boundary for UTC+3 and UTC-5', async () => {
    const now = Date.parse('2026-08-12T12:00:00.000Z')
    const binding = {
      first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'),
      ownership_start_utc_msc:Date.parse('2026-08-01T00:00:00.000Z'), ownership_history_id:77,
    }
    for (const [offset, expectedStart, expectedEnd] of [
      [180, Date.parse('2026-08-09T21:00:00.000Z'), Date.parse('2026-08-10T21:00:00.000Z')],
      [-300, Date.parse('2026-08-10T05:00:00.000Z'), Date.parse('2026-08-11T05:00:00.000Z')],
    ]) {
      const route = {
        terminal_instance_id:`terminal-clock-${offset}`, platform:'mt5',
        account_ref:{ broker_server:'Broker-Demo', login:`${offset}` },
        clock:{ timezone_offset_minutes:offset, clock_status:'persisted' },
        capabilities:['history_exact_range_v1'],
      }
      queryOne.mockResolvedValue(binding)
      const range = await resolveHistoryRange(42, {
        history_scope:'custom', close_from:'2026-08-10', close_to:'2026-08-10',
        filter_close_from:'2026-08-10', filter_close_to:'2026-08-10',
      }, route, now)
      expect(range.range_start_utc_msc).toBe(expectedStart)
      expect(range.range_end_utc_msc).toBe(expectedEnd)
      expect(range.captured_end_utc_msc).toBe(now)
      expect(range.effective_range.end_utc_msc).toBe(expectedEnd)
      expect(range.filter_close_from_utc_msc).toBe(expectedStart)
      expect(range.filter_close_to_utc_msc).toBe(expectedEnd)
      expect(range).toMatchObject({ timezone_offset_minutes:offset, clock_status:'persisted' })
    }
  })

  it('fails closed when date bounds have no trusted terminal clock', async () => {
    queryOne.mockResolvedValue({
      first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'),
      ownership_start_utc_msc:Date.parse('2026-08-01T00:00:00.000Z'), ownership_history_id:77,
    })
    const promise = resolveHistoryRange(42, {
      history_scope:'custom', close_from:'2026-08-10',
    }, {
      terminal_instance_id:'terminal-clock-missing',
      account_ref:{ broker_server:'Broker-Demo', login:'clock-missing' },
      capabilities:['history_exact_range_v1'],
    }, Date.parse('2026-08-12T12:00:00.000Z'))
    await expect(promise)
      .rejects.toMatchObject({ code:'bridge_history_terminal_clock_unavailable' })
  })

  it('applies the current account server preference per all/platform scope', async () => {
    const route = {
      terminal_instance_id:'terminal-preference-scope',
      account_ref:{ broker_server:'Broker-Demo', login:'246810' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1'],
    }
    const now = Date.parse('2026-08-12T12:00:00.000Z')
    queryOne.mockResolvedValue({
      trading_account_id:901,
      first_connected_utc_msc:Date.parse('2026-06-01T00:00:00.000Z'),
      ownership_start_utc_msc:Date.parse('2026-07-01T00:00:00.000Z'),
      ownership_history_id:11,
      saved_all_start_date:'2026-05-01',
      saved_platform_start_date:'2026-07-15',
    })
    const all = await resolveHistoryRange(42, { history_scope:'all' }, route, now)
    expect(all).toMatchObject({
      trading_account_id:901,
      range_start_utc_msc:Date.parse('2026-05-01T00:00:00.000Z'),
      saved_start_date:'2026-05-01', preference_source:'server_account',
      preference_applied:true, preference_invalid:false,
    })

    const platform = await resolveHistoryRange(42, { history_scope:'platform' }, route, now)
    expect(platform).toMatchObject({
      range_start_utc_msc:Date.parse('2026-07-15T00:00:00.000Z'),
      saved_start_date:'2026-07-15', preference_source:'server_account',
      preference_applied:true,
    })
  })

  it('ignores a stale server preference and reports the system fallback', async () => {
    const route = {
      terminal_instance_id:'terminal-preference-invalid',
      account_ref:{ broker_server:'Broker-Demo', login:'135790' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1'],
    }
    const now = Date.parse('2026-08-12T12:00:00.000Z')
    queryOne.mockResolvedValue({
      trading_account_id:902,
      first_connected_utc_msc:Date.parse('2026-06-01T00:00:00.000Z'),
      ownership_start_utc_msc:null,
      ownership_history_id:null,
      saved_all_start_date:'1999-12-31',
    })
    const range = await resolveHistoryRange(42, { history_scope:'all' }, route, now)
    expect(range).toMatchObject({
      trading_account_id:902,
      range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
      saved_start_date:null,
      preference_source:'system', preference_applied:false,
      preference_invalid:true,
      preference_invalid_reason:'out_of_range',
    })
  })

  it('validates, saves, resets, and scopes preference writes to the resolved account', async () => {
    const route = {
      terminal_instance_id:'terminal-preference-write',
      account_ref:{ broker_server:'Broker-Demo', login:'112233' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1'],
    }
    const now = Date.parse('2026-08-12T12:00:00.000Z')
    queryOne.mockResolvedValue({
      trading_account_id:903,
      first_connected_utc_msc:Date.parse('2026-06-01T00:00:00.000Z'),
      ownership_start_utc_msc:null,
      ownership_history_id:null,
    })
    const transactionRun = vi.fn(async sql => String(sql).includes('FOR UPDATE')
      ? [[{ trading_account_id:903 }], []] : [{ affectedRows:1 }, []])
    withTransaction.mockImplementation(async callback => callback(transactionRun))
    const saved = await setHistoryRangePreference(42, route, {
      scope:'platform', start_date:'2026-05-15',
      user_id:999, trading_account_id:999,
    }, now)
    expect(saved).toMatchObject({
      status:'success', preference:{ scope:'platform', start_date:'2026-05-15' },
      history_range:{ range_start_utc_msc:Date.parse('2026-05-15T00:00:00.000Z'),
        saved_start_date:'2026-05-15', preference_source:'server_account' },
    })
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(transactionRun.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(transactionRun.mock.calls[0][0]).toContain('mt5_account_bindings')
    expect(transactionRun.mock.calls[0][0]).toContain('trading_accounts')
    expect(transactionRun.mock.calls[1][0]).toContain('INSERT INTO history_range_preferences')
    expect(transactionRun.mock.calls[1][1]).toEqual([
      42, 903, 'platform', '2026-05-15', expect.any(String), expect.any(String),
    ])

    queryOne.mockResolvedValue({
      trading_account_id:903,
      first_connected_utc_msc:Date.parse('2026-06-01T00:00:00.000Z'),
      ownership_start_utc_msc:null,
      ownership_history_id:null,
      saved_platform_start_date:'2026-05-15',
    })
    const reset = await setHistoryRangePreference(42, route, {
      scope:'platform', start_date:null, user_id:999, trading_account_id:999,
    }, now)
    expect(reset).toMatchObject({
      status:'success', preference:{ scope:'platform', start_date:null },
      history_range:{ range_start_utc_msc:Date.parse('2026-06-01T00:00:00.000Z'),
        saved_start_date:null, preference_source:'system', preference_applied:false },
    })
    expect(withTransaction).toHaveBeenCalledTimes(2)
    expect(transactionRun.mock.calls[2][0]).toContain('FOR UPDATE')
    expect(transactionRun.mock.calls[3][0]).toContain('DELETE FROM history_range_preferences')
    expect(transactionRun.mock.calls[3][1]).toEqual([42, 903, 'platform'])
    await expect(setHistoryRangePreference(42, route,
      { scope:'all', start_date:'2026-02-30' }, now))
      .rejects.toMatchObject({ code:'history_range_preference_date_invalid' })
  })

  it('treats the all-history floor business date as a reset under a positive offset', async () => {
    const route = {
      terminal_instance_id:'terminal-preference-floor-reset',
      account_ref:{ broker_server:'Broker-Demo', login:'445566' },
      clock:{ timezone_offset_minutes:180, clock_status:'persisted' },
      capabilities:['history_exact_range_v1'],
    }
    const now = Date.parse('2026-08-12T12:00:00.000Z')
    queryOne.mockResolvedValue({
      trading_account_id:904,
      first_connected_utc_msc:Date.parse('2026-06-01T00:00:00.000Z'),
      ownership_start_utc_msc:null,
      ownership_history_id:null,
    })
    const transactionRun = vi.fn(async sql => String(sql).includes('FOR UPDATE')
      ? [[{ trading_account_id:904 }], []] : [{ affectedRows:1 }, []])
    withTransaction.mockImplementation(async callback => callback(transactionRun))

    const result = await setHistoryRangePreference(42, route,
      { scope:'all', start_date:'2000-01-01' }, now)
    expect(result).toMatchObject({
      preference:{ scope:'all', start_date:null },
      history_range:{ range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
        saved_start_date:null, preference_source:'system' },
    })
    expect(transactionRun.mock.calls.at(-1)[0]).toContain('DELETE FROM history_range_preferences')
    expect(transactionRun.mock.calls.at(-1)[1]).toEqual([42, 904, 'all'])
  })

  it('maps a ready Bridge SQLite summary without fabricating legacy totals', () => {
    const range = {
      scope:'platform', range_start_utc_msc:Date.parse('2026-08-01T21:00:00.000Z'),
      range_end_utc_msc:Date.parse('2026-08-12T21:00:00.000Z'),
      allowed_start_utc_msc:Date.parse('2000-01-01T00:00:00.000Z'),
      system_start_utc_msc:Date.parse('2026-01-01T21:00:00.000Z'),
      effective_start_utc_msc:Date.parse('2026-08-01T21:00:00.000Z'),
      captured_end_utc_msc:Date.parse('2026-08-12T21:00:00.000Z'),
      timezone_offset_minutes:180, clock_status:'persisted',
    }
    const result = mapBridgePerformanceSummaryResult({
      status:'success',
      statistics:{ account_principal:900, account_balance:1_000, total_profit:25,
        credit:3, deposit:100, withdrawal:20, net_result:108, trade_count:4, total_volume:2.5 },
      history_sync:{ requested_range_complete:true, coverage_complete:true,
        summary_status:'ready', history_revision:9, summary_revision:9 },
    }, range)
    expect(result).toMatchObject({ source:'bridge_sqlite_summary_v2', data_complete:true,
      status:'success', trade_profit:25, realized_net:25, net_account_change:108,
      net_funding:83, exit_deal_count:4, closed_volume:2.5,
      period_start_date:'2026-08-02', period_end_date:'2026-08-12',
      revision:{ history:9, summary:9 } })
    expect(result.performance.source).toBe('bridge_sqlite_summary_v2')
    expect(result.commission).toBeNull()
  })

  it('fails closed for incomplete coverage and mismatched summary revisions', () => {
    const range = { scope:'platform', range_start_utc_msc:1_700_000_000_000,
      range_end_utc_msc:1_700_000_100_000, captured_end_utc_msc:1_700_000_100_000 }
    expect(mapBridgePerformanceSummaryResult({ status:'success', statistics:{ total_profit:0 },
      history_sync:{ requested_range_complete:false, coverage_complete:false,
        summary_status:'ready', history_revision:1, summary_revision:1 } }, range))
      .toMatchObject({ source:'bridge_sqlite_summary_v2', data_complete:false,
        error:'bridge_sqlite_summary_coverage_incomplete' })
    expect(mapBridgePerformanceSummaryResult({ status:'success', statistics:{ total_profit:0 },
      history_sync:{ requested_range_complete:true, coverage_complete:true,
        summary_status:'ready', history_revision:2, summary_revision:1 } }, range))
      .toMatchObject({ source:'bridge_sqlite_summary_v2', data_complete:false,
        error:'bridge_sqlite_summary_not_ready' })
  })

  it('returns an explicit offline summary error and never falls back to MySQL', async () => {
    queryOne.mockClear()
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(false)
    const result = await getBridgePerformanceSummary(42, 77)
    expect(result).toMatchObject({ source:'bridge_sqlite_summary_v2', data_complete:false,
      status:'error', error:'bridge_sqlite_summary_bridge_offline' })
    expect(queryOne).not.toHaveBeenCalled()
  })

  it('classifies an unchanged terminal identity as a reconnect', () => {
    const terminal = {
      terminal_instance_id:'terminal_identity_1',
      account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    }
    const identity = buildBridgeTerminalIdentity({ userId:42, terminal, accountId:7 })
    expect(classifyBridgeIdentityEvent(identity, { ...identity })).toBe('bridge_reconnected')
    expect(classifyBridgeIdentityEvent(identity, {
      ...identity, login:'87654321',
    })).toBe('account_switched')
    expect(classifyBridgeIdentityEvent(null, identity)).toBe('account_switched')
  })

  it('does not schedule legacy performance_daily refreshes during terminal readiness', () => {
    const source = readFileSync(new URL('../server/bridge-ws.js', import.meta.url), 'utf8')
    expect(source).not.toContain('queueAccountPerformanceSync')
    expect(source).not.toContain("'performance_daily'")
    expect(source).toContain('preparePlatformHistoryOnTerminalReady')
    expect(source).toContain('force_refresh:true')
  })
})

describe('history protection display evidence', () => {
  const historyRow = {
    ticket:'702529338', order:'702529338', position_id:'702529338',
    stop_loss:4154.8, take_profit:4179.5,
  }

  it('shows a successful verified platform protection update without mutating raw MT5 entry values', () => {
    const [row] = enrichHistoryProtectionRows([historyRow], [{
      trading_account_id:1,
      entry_order_ticket:'702529338',
      position_id:'702529338',
      target_ticket:'702529338',
      target_status:'succeeded',
      target_result_json:JSON.stringify({ stop_loss:4134.8, take_profit:4190.5 }),
      protection_job_id:7,
      target_completed_at:'2026-08-05 06:30:00',
    }], { tradingAccountId:1 })

    expect(row).toMatchObject({
      stop_loss:4154.8,
      take_profit:4179.5,
      mt5_entry_stop_loss:4154.8,
      mt5_entry_take_profit:4179.5,
      last_verified_stop_loss:4134.8,
      last_verified_take_profit:4190.5,
      display_stop_loss:4134.8,
      display_take_profit:4190.5,
      stop_loss_source:'verified_platform_protection',
      take_profit_source:'verified_platform_protection',
    })
  })

  it('does not override MT5 entry protection with failed, unknown or cross-account evidence', () => {
    const evidence = [
      { trading_account_id:1, target_status:'failed', target_ticket:'702529338', target_result_json:'{"stop_loss":4134.8}' },
      { trading_account_id:2, target_status:'succeeded', target_ticket:'702529338', target_result_json:'{"stop_loss":4100,"take_profit":4200}' },
    ]
    const [row] = enrichHistoryProtectionRows([historyRow], evidence, { tradingAccountId:1 })
    expect(row).toMatchObject({
      display_stop_loss:4154.8,
      display_take_profit:4179.5,
      last_verified_stop_loss:null,
      last_verified_take_profit:null,
      stop_loss_source:'mt5_entry_order',
      take_profit_source:'mt5_entry_order',
    })
  })

  it('applies stop loss and take profit evidence independently', () => {
    const [row] = enrichHistoryProtectionRows([historyRow], [{
      trading_account_id:1,
      target_status:'succeeded',
      target_ticket:'702529338',
      target_result_json:'{"stop_loss":4134.8,"take_profit":0}',
    }], { tradingAccountId:1 })
    expect(row.display_stop_loss).toBe(4134.8)
    expect(row.display_take_profit).toBe(4179.5)
    expect(row.stop_loss_source).toBe('verified_platform_protection')
    expect(row.take_profit_source).toBe('mt5_entry_order')
  })
})

describe('signal pending action presentation', () => {
  it('normalizes successful, superseded and failed pending cancellations', () => {
    expect(buildSignalPendingActions([
      {
        action: 'ai_cancel_pending', status: 'success', created_at: '2026-07-21 10:00:00',
        request_json: JSON.stringify({ ticket: 101, reason: '市场结构已经失效' }),
        result_json: JSON.stringify({ status: 'cancelled', ticket: 101 }),
      },
      {
        action: 'pending_superseded', status: 'info',
        request_json: JSON.stringify({ ticket: 102, pending_type: 'sell_limit' }),
      },
      {
        action: 'ai_cancel_pending_failed', status: 'warning',
        request_json: JSON.stringify({ ticket: 103, error: 'Invalid request' }),
      },
    ])).toEqual([
      expect.objectContaining({ ticket: '101', status: 'cancelled', reason: '市场结构已经失效' }),
      expect.objectContaining({ ticket: '102', status: 'superseded', pending_type: 'sell_limit' }),
      expect.objectContaining({ ticket: '103', status: 'failed', message: 'Invalid request' }),
    ])
  })

  it('ignores unrelated audit actions', () => {
    expect(buildSignalPendingActions([{ action: 'ai_auto_execute', request_json: '{}' }])).toEqual([])
  })

  it('presents a delivery-level cancellation even when the audit uses localized labels', () => {
    expect(buildSignalPendingActions([
      { action:'AI 自动执行', request_json:JSON.stringify({ signal_id:6104 }) },
    ], JSON.stringify({ status:'success', reason:'pending_cancelled', details:{ count:1 } }))).toEqual([
      expect.objectContaining({ status:'cancelled', count:1, reason:expect.stringContaining('系统已取消') }),
    ])
  })

  it('keeps the concrete model basis in a delivery-level cancellation fallback', () => {
    expect(buildSignalPendingActions([], JSON.stringify({
      status:'success', reason:'pending_cancelled',
      details:{ count:1, pending_action_reason:'H1 方向转空且价格跌破 4100 支撑' },
    }))).toEqual([
      expect.objectContaining({ status:'cancelled', count:1, reason:'H1 方向转空且价格跌破 4100 支撑' }),
    ])
  })

  it('accepts localized pending-action audit labels', () => {
    expect(buildSignalPendingActions([{
      action:'AI 取消挂单', status:'成功', request_json:JSON.stringify({ ticket:99, reason:'原挂单逻辑失效' }),
    }])).toEqual([
      expect.objectContaining({ ticket:'99', status:'cancelled', reason:'原挂单逻辑失效' }),
    ])
  })
})

describe('history export signal association', () => {
  it('collects order, position and deal references from MT5 history', () => {
    expect(collectTradeRefs({
      ticket: 1001,
      order: 1001,
      position_id: 2002,
      deal_ticket: 3003,
    })).toEqual(expect.arrayContaining(['1001', '2002', '3003']))
  })

  it('collects references nested in JSON execution results', () => {
    expect(collectTradeRefs({
      trade_ticket: null,
      execution_result: JSON.stringify({ result: { order: 1001, deal: 3003, position: 2002 } }),
    })).toEqual(expect.arrayContaining(['1001', '2002', '3003']))
  })

  it('indexes one inference signal under every known trade reference', () => {
    const index = buildSignalRefIndex([{
      id: 9,
      pending_ticket: '1001',
      execution_result: JSON.stringify({ position_id: '2002', deal_ticket: '3003' }),
      analysis: 'inference result',
    }])
    expect(index.get('1001')?.[0].analysis).toBe('inference result')
    expect(index.get('2002')?.[0].id).toBe(9)
    expect(index.get('3003')?.[0].id).toBe(9)
  })
})

describe('browser auto-execute model-task boundary', () => {
  function deps(tracker) {
    const state = { lastInput:null }
    return {
      createModelTaskTracker:vi.fn(async input => {
        state.lastInput = input
        return tracker
      }),
      modelTaskDeadlines:vi.fn(() => ({ taskDeadlineUtcMs:Date.now() + 60_000, attemptSafetyDeadlineUtcMs:Date.now() + 30_000 })),
      modelProviderProtocol:vi.fn(() => 'chat_completions'),
      state,
    }
  }

  it('creates a durable task, passes taskId and frozen identity, and records signal result ref', async () => {
    const tracker = {
      taskId:'ws-model-task-1', task:{ task_deadline_at_utc_msc:Date.now() + 60_000, result_valid_until_utc_msc:Date.now() + 60_000 },
      signal:new AbortController().signal, persistBudget:vi.fn(), onProviderRequest:vi.fn(), onProviderUsage:vi.fn(),
      onProviderActivity:vi.fn(), onProviderQuiet:vi.fn(), resultReady:vi.fn(), applying:vi.fn(), succeeded:vi.fn(),
      failed:vi.fn(async () => {}), stop:vi.fn(async () => {}),
    }
    const trackerDeps = deps(tracker)
    const guard = { signal:new AbortController().signal, assertConnected:vi.fn() }
    const ai = {
      getAnalyzeApiKey:vi.fn(async () => ({ api_provider:'deepseek', model_name:'deepseek-chat', _model_profile_id:7,
        _protocol:'chat_completions', _credential_source:'user' })),
      handleAnalyze:vi.fn(async (_userId, _params, options) => {
        expect(options.taskId).toBe('ws-model-task-1')
        expect(options.expectedModelIdentity).toEqual({ provider:'deepseek', model:'deepseek-chat', modelProfileId:7,
          protocol:'chat_completions', credentialSource:'user' })
        await options.onProviderRequest({ providerRequestId:'req-1' })
        await options.onProviderUsage({ status:'success', responseReceived:true, httpStatus:200 })
        return { status:'success', signal:{ id:88 } }
      }),
    }
    const result = await runBrowserAutoExecuteWithModelTask(ai, 42,
      { session_id:'s1', symbol:'XAUUSD', strategy_id:3, auto_execute:true }, 'cmd-1', guard, trackerDeps)
    expect(result).toMatchObject({ status:'success', signal:{ id:88 } })
    expect(trackerDeps.createModelTaskTracker).toHaveBeenCalledTimes(1)
    expect(trackerDeps.state.lastInput).toMatchObject({ provider:'deepseek', model:'deepseek-chat', modelProfileId:7,
      protocol:'chat_completions', credentialSource:'user', frozenContext:{ auto_execute:true } })
    expect(tracker.succeeded).toHaveBeenCalledWith({ resultRef:'ai_signals:88' })
    expect(tracker.failed).not.toHaveBeenCalled()
  })

  it('fails the tracker and never succeeds after browser disconnect guard trips', async () => {
    const tracker = {
      taskId:'ws-model-task-closed', task:{ task_deadline_at_utc_msc:Date.now() + 60_000, result_valid_until_utc_msc:Date.now() + 60_000 },
      signal:new AbortController().signal, persistBudget:vi.fn(), onProviderRequest:vi.fn(), onProviderUsage:vi.fn(),
      onProviderActivity:vi.fn(), onProviderQuiet:vi.fn(), resultReady:vi.fn(), applying:vi.fn(), succeeded:vi.fn(),
      failed:vi.fn(async () => {}), stop:vi.fn(async () => {}),
    }
    const trackerDeps = deps(tracker)
    const guard = { signal:new AbortController().signal, assertConnected:vi.fn(() => { throw new Error('manual_auto_execute_request_disconnected') }) }
    const ai = {
      getAnalyzeApiKey:vi.fn(async () => ({ api_provider:'deepseek', model_name:'deepseek-chat', _model_profile_id:7,
        _protocol:'chat_completions', _credential_source:'user' })),
      handleAnalyze:vi.fn(),
    }
    await expect(runBrowserAutoExecuteWithModelTask(ai, 42,
      { session_id:'s1', symbol:'XAUUSD', strategy_id:3, auto_execute:true }, 'cmd-closed', guard, trackerDeps))
      .rejects.toThrow('manual_auto_execute_request_disconnected')
    expect(ai.handleAnalyze).not.toHaveBeenCalled()
    expect(tracker.succeeded).not.toHaveBeenCalled()
    expect(tracker.failed).toHaveBeenCalled()
    expect(tracker.stop).toHaveBeenCalled()
  })

  it('propagates a stale reread identity before provider callbacks', async () => {
    const tracker = {
      taskId:'ws-model-task-stale', task:{ task_deadline_at_utc_msc:Date.now() + 60_000, result_valid_until_utc_msc:Date.now() + 60_000 },
      signal:new AbortController().signal, persistBudget:vi.fn(), onProviderRequest:vi.fn(), onProviderUsage:vi.fn(),
      onProviderActivity:vi.fn(), onProviderQuiet:vi.fn(), resultReady:vi.fn(), applying:vi.fn(), succeeded:vi.fn(),
      failed:vi.fn(async () => {}), stop:vi.fn(async () => {}),
    }
    const trackerDeps = deps(tracker)
    const guard = { signal:new AbortController().signal, assertConnected:vi.fn() }
    const ai = {
      getAnalyzeApiKey:vi.fn(async () => ({ api_provider:'deepseek', model_name:'deepseek-chat', _model_profile_id:7,
        _protocol:'chat_completions', _credential_source:'user' })),
      handleAnalyze:vi.fn(async (_userId, _params, options) => {
        expect(options.expectedModelIdentity.model).toBe('deepseek-chat')
        throw Object.assign(new Error('manual_analysis_model_stale'), { code:'manual_analysis_model_stale' })
      }),
    }
    await expect(runBrowserAutoExecuteWithModelTask(ai, 42,
      { session_id:'s1', symbol:'XAUUSD', strategy_id:3, auto_execute:true }, 'cmd-stale', guard, trackerDeps))
      .rejects.toThrow('manual_analysis_model_stale')
    expect(tracker.succeeded).not.toHaveBeenCalled()
    expect(tracker.failed).toHaveBeenCalled()
    expect(tracker.onProviderRequest).not.toHaveBeenCalled()
  })
})

describe('initBridgeWS', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHistoryReadsEnabled.mockReturnValue(true)
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(false)
    mockBridgeV3Business.isTradeEnabled.mockReturnValue(false)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([])
    mockBridgeV3Business.connectedUsers.mockReturnValue([])
  })
  afterEach(() => {
    mockHistoryReadsEnabled.mockReturnValue(true)
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(false)
    mockBridgeV3Business.isTradeEnabled.mockReturnValue(false)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([])
    mockBridgeV3Business.connectedUsers.mockReturnValue([])
  })

  it('returns a WebSocketServer instance', () => {
    const server = new EventEmitter()
    const result = initBridgeWS(server)
    expect(result).toBeDefined()
  })

  it('counts connected MT4 and MT5 terminals together with platform totals', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    mockBridgeV3Business.connectedUsers.mockReturnValue([{ userId:42, connected:true, alive:true }])
    mockBridgeV3Business.connectedTerminals.mockReturnValue([
      { terminal_instance_id:'terminal_mt4_01', platform:'mt4' },
      { terminal_instance_id:'terminal_mt5_01', platform:'mt5' },
    ])

    expect(getConnectedBridgeStats()).toEqual({ total:2, mt4:1, mt5:1 })
  })

  it('registers upgrade handler on the server', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    expect(server.listenerCount('upgrade')).toBe(1)
  })

  it('destroys socket for non-bridge paths', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    const fakeSocket = { destroy: vi.fn() }
    const req = { url: '/other/path', headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    server.emit('upgrade', req, fakeSocket, Buffer.alloc(0))
    expect(fakeSocket.destroy).toHaveBeenCalled()
  })

  it('retires the legacy bridge path before websocket upgrade', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    const fakeSocket = { end:vi.fn(), write:vi.fn(), destroy:vi.fn() }
    const req = { url: '/aurum-api/bridge/ws?type=bridge&token=tok', headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    server.emit('upgrade', req, fakeSocket, Buffer.alloc(0))
    expect(fakeSocket.end).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 426 Upgrade Required'))
    expect(fakeSocket.end).toHaveBeenCalledWith(expect.stringContaining('Link: </api/bridge/version>; rel="update"'))
    expect(fakeSocket.write).not.toHaveBeenCalled()
    expect(fakeSocket.destroy).not.toHaveBeenCalled()
    expect(mockWss.handleUpgrade).not.toHaveBeenCalled()
  })

  it('routes the v3 bridge path without destroying its socket', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    const fakeSocket = { ws:mockWs, destroy:vi.fn() }
    const req = { url:'/aurum-api/bridge/v3/ws?ticket=opaque', headers:{}, socket:{ remoteAddress:'127.0.0.1' } }
    server.emit('upgrade', req, fakeSocket, Buffer.alloc(0))
    expect(mockWss.handleUpgrade).toHaveBeenCalled()
    expect(fakeSocket.destroy).not.toHaveBeenCalled()
  })

  it('rejects browser websocket upgrades from a foreign origin before authentication', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    const fakeSocket = { write:vi.fn(), destroy:vi.fn() }
    const req = {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'https://evil.example' },
      socket:{ remoteAddress:'127.0.0.1' },
    }
    server.emit('upgrade', req, fakeSocket, Buffer.alloc(0))
    expect(fakeSocket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'))
    expect(fakeSocket.destroy).toHaveBeenCalled()
    expect(mockWss.handleUpgrade).not.toHaveBeenCalled()
  })

  it('answers browser heartbeats when only a V3 terminal is connected', async () => {
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.isTradeEnabled.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([{
      terminal_instance_id:'mt4_terminal_heartbeat_01', platform:'mt4',
      account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    }])
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT id FROM users WHERE role')) return { id:42 }
      if (sql.includes('SELECT id, token_version FROM users')) return { id:42, token_version:0 }
      if (sql.includes('SELECT role, plan, plan_expires_at, plan_source FROM users')) {
        return { role:'admin', plan:'pro', plan_expires_at:null, plan_source:null }
      }
      if (sql.includes('FROM strategy_subscriptions')) return { id:88 }
      return null
    })

    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection')
      .at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()

    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })
    browserWs.emit('message', JSON.stringify({ type:'hb', seq:7 }))

    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(1))
    expect(JSON.parse(browserWs.send.mock.calls[0][0])).toMatchObject({
      type:'hb',
      seq:7,
      mt5_connected:true,
      mt5_alive:true,
      trade_enabled:true,
      auto_reasoning_enabled:true,
      platform:'mt4',
      terminal_instance_id:'mt4_terminal_heartbeat_01',
    })
    browserWs.emit('close')
    mockBridgeV3Business.connectedTerminals.mockReturnValue([])
  })

  it('addresses notification wake-ups only to the authenticated user socket', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT id FROM users WHERE role')) return { id:42 }
      if (sql.includes('SELECT id, token_version FROM users')) return { id:42, token_version:0 }
      if (sql.includes('SELECT role, plan, plan_expires_at, plan_source FROM users')) {
        return { role:'admin', plan:'pro', plan_expires_at:null, plan_source:null }
      }
      if (sql.includes('FROM strategy_subscriptions')) return { id:88 }
      return null
    })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection')
      .at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })
    browserWs.send.mockClear()

    expect(sendNotificationCreatedToUser(43, { notificationId:7, unreadCount:1 })).toBe(0)
    expect(browserWs.send).not.toHaveBeenCalled()
    expect(sendNotificationCreatedToUser(42, { notificationId:7, priority:'important', requiresAck:true, unreadCount:1 })).toBe(1)
    expect(JSON.parse(browserWs.send.mock.calls[0][0])).toEqual({
      type:'notification_created', notificationId:7, priority:'important', requiresAck:true, unreadCount:1,
    })
    browserWs.emit('close')
  })

  it('uses the signal visibility path before reading evidence and rejects snapshot replacement', async () => {
    const visibleRow = { id:7, user_id:42, symbol:'XAUUSD', timeframe:'M5' }
    let visible = true
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([{ terminal_instance_id:'terminal-1', platform:'mt5' }])
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT id, token_version FROM users')) return { id:42, token_version:0 }
      if (sql.includes('SELECT plan, role, plan_expires_at, plan_source')) return { role:'user', plan:'pro', plan_expires_at:null, plan_source:null, connection_enabled:1 }
      if (sql.includes('FROM auto_signal_deliveries')) return null
      if (sql.includes('FROM ai_signals')) return visible ? visibleRow : null
      if (sql.includes('FROM inference_snapshots')) return {
        id:124, signal_id:7, standard_symbol:'XAUUSD', market_source:'platform_market_bridge', evidence_status:'complete',
        klines_json:JSON.stringify({ M5:Array.from({ length:501 }, (_, index) => ({ time:index, open:1, high:2, low:1, close:2 })) }),
        market_snapshot_json:JSON.stringify({ strategy_context:{ timeframes:{} } }), created_at:'2026-08-10 12:00:00',
      }
      return null
    })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls.filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, { url:'/aurum-api/bridge/ws?type=browser', headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' } })
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'evidence-mismatch', action:'signal_evidence',
      params:{ signal_id:7, timeframe:'M5', snapshot_id:123 },
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalled(), { timeout:5_000 })
    expect(JSON.parse(browserWs.send.mock.calls.at(-1)[0])).toMatchObject({ status:'error', code:'snapshot_mismatch' })

    visible = false
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'evidence-hidden', action:'signal_evidence',
      params:{ signal_id:7, timeframe:'M5', snapshot_id:124 },
    }))
    await vi.waitFor(() => expect(browserWs.send.mock.calls.length).toBeGreaterThan(1), { timeout:5_000 })
    expect(JSON.parse(browserWs.send.mock.calls.at(-1)[0])).toMatchObject({ status:'error', message:'signal not found' })
    browserWs.emit('close')
  })

  it('fails history closed when the selected route lacks exact-range capability', async () => {
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([{
      terminal_instance_id:'terminal-history-legacy', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' }, capabilities:[],
    }])
    queryOne.mockResolvedValue({
      id:42, role:'admin', plan:'pro', plan_expires_at:null,
      plan_source:null, connection_enabled:1,
    })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-legacy', action:'history', params:{},
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalled(), { timeout:5_000 })
    const response = JSON.parse(browserWs.send.mock.calls.at(-1)[0])
    expect(response).toMatchObject({ status:'error', code:'bridge_history_exact_range_unsupported' })
    expect(mockBridgeV3Business.execute).not.toHaveBeenCalled()
    browserWs.emit('close')
  })

  it('returns stable history maintenance without dispatching or closing the browser socket', async () => {
    mockHistoryReadsEnabled.mockReturnValue(false)
    queryOne.mockResolvedValue({
      id:42, role:'admin', plan:'pro', plan_expires_at:null,
      plan_source:null, connection_enabled:1,
    })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-maintenance', action:'history_chart_data', params:{},
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalled(), { timeout:5_000 })
    expect(JSON.parse(browserWs.send.mock.calls.at(-1)[0])).toMatchObject({
      status:'error', code:'bridge_history_temporarily_unavailable',
    })
    expect(mockBridgeV3Business.execute).not.toHaveBeenCalled()
    expect(browserWs.close).not.toHaveBeenCalled()
    browserWs.emit('close')
  })

  it('sends one exact custom range to history without date-only fallback', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(now)
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    const route = {
      terminal_instance_id:'terminal-history-exact', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1'],
    }
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute.mockResolvedValue({
      status:'success', orders:[], history_sync:{ requested_range_complete:true },
    })
    queryOne.mockImplementation(async sql => {
      if (String(sql).includes('FROM mt5_account_bindings')) {
        return {
          first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'),
          ownership_start_utc_msc:Date.parse('2026-08-08T12:30:00.000Z'),
          ownership_history_id:77,
        }
      }
      return { id:42, role:'admin', plan:'pro', plan_expires_at:null,
        plan_source:null, connection_enabled:1 }
    })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-exact', action:'history',
      params:{ history_scope:'custom', close_from:'2026-07-01', close_to:'2026-08-09', date_from:'2020-01-01' },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalled(), { timeout:5_000 })
    const [, action, bridgeParams] = mockBridgeV3Business.execute.mock.calls.at(-1)
    expect(action).toBe('history')
    expect(bridgeParams).toMatchObject({
      range_start_utc_msc:Date.parse('2026-07-01T00:00:00.000Z'),
      range_end_utc_msc:Date.parse('2026-08-10T00:00:00.000Z'),
      terminal_instance_id:'terminal-history-exact',
    })
    expect(bridgeParams.captured_end_utc_msc).toBeGreaterThanOrEqual(now)
    expect(bridgeParams.captured_end_utc_msc).toBeLessThanOrEqual(now + 60_000)
    expect(bridgeParams).not.toHaveProperty('date_from')
    expect(bridgeParams).not.toHaveProperty('date_to')
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('freezes one end time for lightweight preparation polls and strips history rows', async () => {
    vi.useFakeTimers()
    const firstNow = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(firstNow)
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    const route = {
      terminal_instance_id:'terminal-history-prepare', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1', 'history_prepare_status_v1'],
    }
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute.mockResolvedValue({
      status:'success', source:'mt5_sqlite',
      history_sync:{ requested_range_complete:false, backfill_pending:true },
      orders:[{ ticket:'must-not-leak' }], statistics:{ total_trades:999 },
      chart_data:{ daily:[{ date:'2026-08-10' }] },
    })
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'),
          ownership_start_utc_msc:Date.parse('2026-08-08T12:30:00.000Z'), ownership_history_id:77 }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-prepare-first', action:'history_prepare_status_v1',
      params:{ history_scope:'all' },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(1))
    const firstParams = mockBridgeV3Business.execute.mock.calls[0][2]
    const frozenEnd = Number(firstParams.range_end_utc_msc)
    expect(mockBridgeV3Business.execute.mock.calls[0][1]).toBe('history_prepare_status_v1')
    expect(firstParams).toMatchObject({
      range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
      terminal_instance_id:route.terminal_instance_id,
    })
    expect(frozenEnd).toBeGreaterThanOrEqual(firstNow)
    expect(frozenEnd).toBeLessThanOrEqual(firstNow + 60_000)
    expect(firstParams.captured_end_utc_msc).toBe(frozenEnd)
    expect(firstParams).not.toHaveProperty('page')
    expect(firstParams).not.toHaveProperty('history_snapshot_id')
    const firstReply = JSON.parse(browserWs.send.mock.calls[0][0])
    expect(firstReply).toMatchObject({
      status:'success', history_sync:{ requested_range_complete:false, backfill_pending:true },
      history_range:{ range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
        range_end_utc_msc:frozenEnd, captured_end_utc_msc:frozenEnd,
        saved_start_date:null, preference_source:'system',
        preference_applied:false, preference_invalid:false },
    })
    expect(firstReply).not.toHaveProperty('orders')
    expect(firstReply).not.toHaveProperty('statistics')
    expect(firstReply).not.toHaveProperty('chart_data')
    expect(Buffer.byteLength(JSON.stringify(firstReply), 'utf8')).toBeLessThan(1024)

    vi.setSystemTime(firstNow + 5_000)
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-prepare-poll', action:'history_prepare_status_v1',
      params:{ history_scope:'all', history_range:firstReply.history_range },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(2))
    expect(mockBridgeV3Business.execute.mock.calls[1][2]).toMatchObject({
      range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
      range_end_utc_msc:frozenEnd,
      captured_end_utc_msc:frozenEnd,
    })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-prepare-custom', action:'history_prepare_status_v1',
      params:{ history_scope:'custom', close_from:'2026-07-01', close_to:'2026-07-01' },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(3))
    const customReply = JSON.parse(browserWs.send.mock.calls[2][0])
    expect(customReply.history_range).toMatchObject({
      range_start_utc_msc:Date.parse('2026-07-01T00:00:00.000Z'),
      range_end_utc_msc:Date.parse('2026-07-02T00:00:00.000Z'),
    })
    expect(customReply.history_range.captured_end_utc_msc)
      .toBeGreaterThan(customReply.history_range.range_end_utc_msc)
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-prepare-custom-poll', action:'history_prepare_status_v1',
      params:{ history_scope:'custom', close_from:'2026-07-01', close_to:'2026-07-01',
        history_range:customReply.history_range },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(4))
    expect(mockBridgeV3Business.execute.mock.calls[3][2]).toMatchObject({
      range_end_utc_msc:customReply.history_range.range_end_utc_msc,
      captured_end_utc_msc:customReply.history_range.captured_end_utc_msc,
    })

    route.capabilities = ['history_exact_range_v1']
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-prepare-unsupported', action:'history_prepare_status_v1',
      params:{ history_scope:'all' },
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(5))
    expect(JSON.parse(browserWs.send.mock.calls[4][0])).toMatchObject({
      status:'error', code:'history_prepare_status_unsupported',
    })
    expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(4)
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('reuses a prepare endpoint when the trusted terminal clock is slightly ahead', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(now)
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    const route = {
      terminal_instance_id:'terminal-history-clock-ahead', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      clock:{
        timezone_offset_minutes:0,
        clock_status:'verified',
        observed_at_utc_msc:now + 500,
        received_at_utc_msc:now,
      },
      capabilities:['history_exact_range_v1', 'history_cursor_v1', 'history_prepare_status_v1'],
    }
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute.mockResolvedValue({
      status:'success', source:'mt5_sqlite', orders:[],
      history_sync:{
        requested_range_complete:true, summary_status:'ready',
        history_revision:1, summary_revision:1,
      },
    })
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'),
          ownership_start_utc_msc:Date.parse('2026-08-08T12:30:00.000Z'),
          ownership_history_id:77 }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-clock-ahead-prepare',
      action:'history_prepare_status_v1', params:{ history_scope:'platform' },
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(1))
    const prepared = JSON.parse(browserWs.send.mock.calls[0][0])
    const preparedEnd = Number(prepared.history_range.captured_end_utc_msc)
    expect(preparedEnd).toBeGreaterThanOrEqual(now + 500)
    expect(preparedEnd).toBeLessThan(now + 1_000)

    vi.setSystemTime(now + 100)
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-clock-ahead-read', action:'history',
      params:{
        page:1, page_size:20, history_scope:'platform',
        range_start_utc_msc:prepared.history_range.range_start_utc_msc,
        range_end_utc_msc:prepared.history_range.range_end_utc_msc,
        allowed_start_utc_msc:prepared.history_range.allowed_start_utc_msc,
        system_start_utc_msc:prepared.history_range.system_start_utc_msc,
        effective_start_utc_msc:prepared.history_range.effective_start_utc_msc,
        captured_end_utc_msc:prepared.history_range.captured_end_utc_msc,
      },
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(2))
    expect(JSON.parse(browserWs.send.mock.calls[1][0])).toMatchObject({ status:'success' })
    expect(mockBridgeV3Business.execute.mock.calls[1][1]).toBe('history_page')
    expect(mockBridgeV3Business.execute.mock.calls[1][2]).toMatchObject({
      range_end_utc_msc:preparedEnd,
      captured_end_utc_msc:preparedEnd,
    })
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('uses history_page and forwards only opaque snapshot cursors when capability is present', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(now)
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    const route = {
      terminal_instance_id:'terminal-history-cursor', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1'],
    }
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute.mockResolvedValue({
      status:'success', orders:[], history_snapshot_id:'a'.repeat(64),
      next_cursor:'b'.repeat(64), has_more:true,
      chart_data:{ daily:[{ date:'2026-08-09', profit:12.5 }], cumulative:[12.5] },
      history_sync:{ requested_range_complete:true },
    })
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'), ownership_start_utc_msc:Date.parse('2026-08-08T12:30:00.000Z'), ownership_history_id:77 }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })
    vi.setSystemTime(now + 5_000)
    const snapshotRangeStart = Date.parse('2026-01-01T00:00:00.000Z')
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-cursor', action:'history',
      params:{ page:2, page_size:20, history_scope:'platform',
        history_snapshot_id:'a'.repeat(64), cursor:'b'.repeat(64),
        range_start_utc_msc:snapshotRangeStart, range_end_utc_msc:now,
        captured_end_utc_msc:now },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalled(), { timeout:5_000 })
    const [, action, bridgeParams] = mockBridgeV3Business.execute.mock.calls.at(-1)
    expect(action).toBe('history_page')
    expect(bridgeParams).toMatchObject({
      page_size:20,
      history_snapshot_id:'a'.repeat(64),
      cursor:'b'.repeat(64),
      range_start_utc_msc:snapshotRangeStart,
      range_end_utc_msc:now,
      terminal_instance_id:'terminal-history-cursor',
    })
    expect(bridgeParams).not.toHaveProperty('page')
    expect(JSON.parse(browserWs.send.mock.calls.at(-1)[0])).toMatchObject({
      status:'success',
      chart_data:{ daily:[{ date:'2026-08-09', profit:12.5 }], cumulative:[12.5] },
    })
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('continues a platform history page from the server-saved account start without an override', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(now)
    const savedStart = Date.parse('2026-06-01T00:00:00.000Z')
    const systemStart = Date.parse('2026-07-16T00:00:00.000Z')
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    const route = {
      terminal_instance_id:'terminal-history-saved-start', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1'],
    }
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute.mockResolvedValue({
      status:'success', orders:[], history_snapshot_id:'a'.repeat(64),
      next_cursor:'b'.repeat(64), has_more:true,
      history_sync:{ requested_range_complete:true },
    })
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:systemStart, ownership_start_utc_msc:Date.parse('2026-08-08T12:30:00.000Z'),
          ownership_history_id:77, saved_platform_start_date:'2026-06-01' }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-saved-start-first', action:'history',
      params:{ page:1, page_size:20, history_scope:'platform' },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(1))
    const firstCall = mockBridgeV3Business.execute.mock.calls[0]
    const firstParams = firstCall[2]
    const capturedEnd = Number(firstParams.captured_end_utc_msc)
    expect(firstCall[1]).toBe('history_page')
    expect(firstParams).toMatchObject({
      range_start_utc_msc:savedStart,
      allowed_start_utc_msc:expect.any(Number),
      system_start_utc_msc:systemStart,
      effective_start_utc_msc:savedStart,
      captured_end_utc_msc:capturedEnd,
    })
    expect(capturedEnd).toBeGreaterThanOrEqual(now)
    expect(capturedEnd).toBeLessThanOrEqual(now + 60_000)
    expect(firstParams.range_end_utc_msc).toBe(capturedEnd)
    const firstReply = JSON.parse(browserWs.send.mock.calls[0][0])
    expect(firstReply).toMatchObject({
      status:'success', history_snapshot_id:'a'.repeat(64), next_cursor:'b'.repeat(64),
      history_range:{ range_start_utc_msc:savedStart, effective_start_utc_msc:savedStart,
        range_end_utc_msc:capturedEnd, captured_end_utc_msc:capturedEnd,
        system_start_utc_msc:systemStart },
    })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-saved-start-next', action:'history',
      params:{ page:2, page_size:20, history_scope:'platform',
        history_snapshot_id:'a'.repeat(64), cursor:'b'.repeat(64),
        range_start_utc_msc:savedStart, range_end_utc_msc:capturedEnd,
        allowed_start_utc_msc:firstParams.allowed_start_utc_msc,
        system_start_utc_msc:systemStart, effective_start_utc_msc:savedStart,
        captured_end_utc_msc:capturedEnd },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(2))
    const secondCall = mockBridgeV3Business.execute.mock.calls[1]
    expect(secondCall[1]).toBe('history_page')
    expect(secondCall[2]).toMatchObject({
      history_snapshot_id:'a'.repeat(64), cursor:'b'.repeat(64),
      range_start_utc_msc:savedStart, system_start_utc_msc:systemStart,
      effective_start_utc_msc:savedStart, captured_end_utc_msc:capturedEnd,
    })
    expect(JSON.parse(browserWs.send.mock.calls[1][0])).toMatchObject({ status:'success' })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-saved-start-tampered', action:'history',
      params:{ page:2, page_size:20, history_scope:'platform',
        history_snapshot_id:'a'.repeat(64), cursor:'b'.repeat(64),
        range_start_utc_msc:savedStart + 86_400_000, range_end_utc_msc:capturedEnd,
        allowed_start_utc_msc:firstParams.allowed_start_utc_msc,
        system_start_utc_msc:systemStart, effective_start_utc_msc:savedStart,
        captured_end_utc_msc:capturedEnd },
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(3))
    expect(JSON.parse(browserWs.send.mock.calls[2][0])).toMatchObject({
      status:'error', code:'history_cursor_invalid',
    })
    expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(2)
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('retries an incomplete cursor range with the first fixed endpoint before a snapshot exists', async () => {
    vi.useFakeTimers()
    const firstNow = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(firstNow)
    const ownershipStart = Date.parse('2026-08-08T12:30:00.000Z')
    const route = {
      terminal_instance_id:'terminal-history-fixed-retry', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1'],
    }
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute
      .mockResolvedValueOnce({
        status:'error', error:'history_cursor_range_incomplete',
        message:'history_cursor_range_incomplete', history_snapshot_id:'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        status:'success', orders:[],
        history_sync:{ requested_range_complete:true },
      })
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'), ownership_start_utc_msc:ownershipStart, ownership_history_id:77 }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })

    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-first', action:'history',
      params:{ history_scope:'all', page:1, page_size:20 },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(1))
    const firstCall = mockBridgeV3Business.execute.mock.calls[0]
    expect(firstCall[1]).toBe('history_page')
    const firstRangeEnd = Number(firstCall[2].range_end_utc_msc)
    expect(firstCall[2]).toMatchObject({
      range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
      terminal_instance_id:route.terminal_instance_id,
    })
    expect(firstCall[2].range_start_utc_msc).toBe(HISTORY_ABSOLUTE_FLOOR_UTC_MSC)
    expect(firstCall[2].range_start_utc_msc).toBeLessThan(ownershipStart)
    expect(firstRangeEnd).toBeGreaterThanOrEqual(firstNow)
    expect(firstRangeEnd).toBeLessThanOrEqual(firstNow + 60_000)
    expect(firstCall[2]).not.toHaveProperty('history_snapshot_id')
    expect(JSON.parse(browserWs.send.mock.calls[0][0])).toMatchObject({
      status:'error', error:'history_cursor_range_incomplete',
      history_range:{ range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC, range_end_utc_msc:firstRangeEnd },
    })

    const retryNow = firstRangeEnd + 5_000
    vi.setSystemTime(retryNow)
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-retry', action:'history',
      params:{ history_scope:'all', page:1, page_size:20,
        range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC, range_end_utc_msc:firstRangeEnd,
        history_snapshot_id:'a'.repeat(64), captured_end_utc_msc:firstRangeEnd },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(2))
    const retryCall = mockBridgeV3Business.execute.mock.calls[1]
    expect(retryCall[1]).toBe('history_page')
    expect(retryCall[2]).toMatchObject({
      range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
      range_end_utc_msc:firstRangeEnd,
      history_snapshot_id:'a'.repeat(64),
      terminal_instance_id:route.terminal_instance_id,
    })
    expect(retryCall[2].range_start_utc_msc).toBe(HISTORY_ABSOLUTE_FLOOR_UTC_MSC)
    expect(retryCall[2].history_snapshot_id).toBe('a'.repeat(64))
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('accepts a fixed pre-ownership custom range on an incomplete retry', async () => {
    vi.useFakeTimers()
    const firstNow = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(firstNow)
    const ownershipStart = Date.parse('2026-08-08T12:30:00.000Z')
    const customStart = Date.parse('2026-07-01T00:00:00.000Z')
    const route = {
      terminal_instance_id:'terminal-history-custom-retry', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1'],
    }
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute
      .mockResolvedValueOnce({
        status:'error', error:'history_cursor_range_incomplete',
        message:'history_cursor_range_incomplete',
      })
      .mockResolvedValueOnce({
        status:'success', orders:[],
        history_sync:{ requested_range_complete:true },
      })
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'), ownership_start_utc_msc:ownershipStart, ownership_history_id:77 }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })

    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    const customParams = {
      history_scope:'custom', close_from:'2026-07-01', close_to:'2026-08-09',
      page:1, page_size:20,
    }
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-custom-first', action:'history',
      params:customParams,
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(1))
    const firstCall = mockBridgeV3Business.execute.mock.calls[0]
    const firstRangeEnd = Number(firstCall[2].range_end_utc_msc)
    expect(firstCall[1]).toBe('history_page')
    expect(firstCall[2]).toMatchObject({
      range_start_utc_msc:customStart,
      range_end_utc_msc:firstRangeEnd,
      terminal_instance_id:route.terminal_instance_id,
    })
    expect(customStart).toBeLessThan(ownershipStart)
    expect(firstRangeEnd).toBe(Date.parse('2026-08-10T00:00:00.000Z'))
    expect(JSON.parse(browserWs.send.mock.calls[0][0])).toMatchObject({
      status:'error', error:'history_cursor_range_incomplete',
      history_range:{ range_start_utc_msc:customStart, range_end_utc_msc:firstRangeEnd },
    })

    vi.setSystemTime(firstRangeEnd + 5_000)
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-custom-retry', action:'history',
      params:{ ...customParams,
        range_start_utc_msc:customStart, range_end_utc_msc:firstRangeEnd },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(2))
    const retryCall = mockBridgeV3Business.execute.mock.calls[1]
    expect(retryCall[1]).toBe('history_page')
    expect(retryCall[2]).toMatchObject({
      range_start_utc_msc:customStart,
      range_end_utc_msc:firstRangeEnd,
      terminal_instance_id:route.terminal_instance_id,
    })
    expect(retryCall[2].range_start_utc_msc).toBe(firstCall[2].range_start_utc_msc)
    expect(retryCall[2].range_end_utc_msc).toBe(firstCall[2].range_end_utc_msc)
    expect(JSON.parse(browserWs.send.mock.calls[1][0])).toMatchObject({ status:'success' })
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('reuses a table fixed range for chart data and rejects a partial range', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(now)
    const ownershipStart = Date.parse('2026-08-08T12:30:00.000Z')
    const route = {
      terminal_instance_id:'terminal-history-chart-fixed', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      clock:{ timezone_offset_minutes:0, clock_status:'persisted' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1'],
    }
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    mockBridgeV3Business.execute
      .mockResolvedValueOnce({ status:'success', orders:[], history_sync:{ requested_range_complete:true } })
      .mockResolvedValueOnce({ status:'success', statistics:{}, chart:[] })
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'), ownership_start_utc_msc:ownershipStart, ownership_history_id:77 }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-table', action:'history',
      params:{ history_scope:'all', page:1, page_size:20,
        filter_close_from:'2026-08-01' },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(1))
    const tableRangeEnd = Number(mockBridgeV3Business.execute.mock.calls[0][2].range_end_utc_msc)
    vi.setSystemTime(now + 10_000)
    const tableRangeStart = Number(mockBridgeV3Business.execute.mock.calls[0][2].range_start_utc_msc)
    expect(tableRangeStart).toBe(HISTORY_ABSOLUTE_FLOOR_UTC_MSC)
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-chart', action:'history_chart_data',
      params:{ history_scope:'all', filter_close_from:'2026-08-02',
        range_start_utc_msc:tableRangeStart, range_end_utc_msc:tableRangeEnd },
    }))
    await vi.waitFor(() => expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(2))
    const chartCall = mockBridgeV3Business.execute.mock.calls[1]
    expect(chartCall[1]).toBe('chart_data')
    expect(chartCall[2]).toMatchObject({
      range_end_utc_msc:tableRangeEnd,
      terminal_instance_id:route.terminal_instance_id,
    })
    expect(chartCall[2]).not.toHaveProperty('filter_close_from')
    expect(chartCall[2]).not.toHaveProperty('filter_close_to')
    expect(chartCall[2].range_start_utc_msc).toBe(tableRangeStart)
    expect(chartCall[2].range_start_utc_msc).toBeLessThan(chartCall[2].range_end_utc_msc)

    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-chart-partial', action:'history_chart_data',
      params:{ history_scope:'recent', range_start_utc_msc:tableRangeStart },
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(3))
    expect(JSON.parse(browserWs.send.mock.calls[2][0])).toMatchObject({
      status:'error', code:'history_cursor_invalid',
    })
    expect(mockBridgeV3Business.execute).toHaveBeenCalledTimes(2)
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('fails closed for incomplete, reversed, ownership-crossing, and future fixed ranges', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-10T12:30:00.000Z')
    vi.setSystemTime(now)
    const ownershipStart = Date.parse('2026-08-08T12:30:00.000Z')
    const recentStart = now - 30 * 24 * 60 * 60 * 1_000
    const route = {
      terminal_instance_id:'terminal-history-fixed-guards', platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'123456' },
      capabilities:['history_exact_range_v1', 'history_cursor_v1'],
    }
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([route])
    queryOne.mockImplementation(async sql => String(sql).includes('FROM mt5_account_bindings')
      ? { first_connected_utc_msc:Date.parse('2026-01-01T00:00:00.000Z'), ownership_start_utc_msc:ownershipStart, ownership_history_id:77 }
      : { id:42, role:'admin', plan:'pro', plan_expires_at:null,
          plan_source:null, connection_enabled:1 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection').at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    const invalidRanges = [
      { range_start_utc_msc:ownershipStart },
      { range_start_utc_msc:now, range_end_utc_msc:ownershipStart },
      { range_start_utc_msc:recentStart - 1, range_end_utc_msc:now },
      { range_start_utc_msc:recentStart, range_end_utc_msc:now + 1 },
      { range_start_utc_msc:recentStart, range_end_utc_msc:now + 120_000 },
      { range_start_utc_msc:recentStart + 1, range_end_utc_msc:now },
      { history_scope:'ownership', range_start_utc_msc:ownershipStart + 1,
        range_end_utc_msc:now },
      { history_scope:'all', range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC + 1,
        range_end_utc_msc:now },
      { history_scope:'platform', range_start_utc_msc:Date.parse('2026-01-01T00:00:00.001Z'),
        range_end_utc_msc:now },
    ]
    for (const [index, range] of invalidRanges.entries()) {
      browserWs.emit('message', JSON.stringify({
        type:'command', command_id:`history-invalid-${index}`, action:'history',
        params:{ history_scope:'recent', ...range },
      }))
      await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(index + 1))
      expect(JSON.parse(browserWs.send.mock.calls[index][0])).toMatchObject({
        status:'error', code:'history_cursor_invalid',
      })
    }
    browserWs.emit('message', JSON.stringify({
      type:'command', command_id:'history-cursor-without-snapshot', action:'history',
      params:{ history_scope:'all', page:2, page_size:20,
        range_start_utc_msc:HISTORY_ABSOLUTE_FLOOR_UTC_MSC,
        range_end_utc_msc:now, cursor:'b'.repeat(64) },
    }))
    await vi.waitFor(() => expect(browserWs.send).toHaveBeenCalledTimes(invalidRanges.length + 1))
    expect(JSON.parse(browserWs.send.mock.calls.at(-1)[0])).toMatchObject({
      status:'error', code:'history_cursor_invalid',
    })
    expect(mockBridgeV3Business.execute).not.toHaveBeenCalled()
    browserWs.emit('close')
    vi.useRealTimers()
  })

  it('includes authenticated admin sockets in user-wide session revocation', async () => {
    queryOne.mockResolvedValue({ id:42, role:'admin', token_version:0 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection')
      .at(-1)?.[1]
    const adminWs = new EventEmitter()
    adminWs.readyState = 1
    adminWs.send = vi.fn()
    adminWs.close = vi.fn()

    await connectionHandler(adminWs, {
      url:'/aurum-api/bridge/ws?type=admin',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })
    disconnectUserSockets(42, 'session test')

    expect(adminWs.close).toHaveBeenCalledWith(4002, 'session test')
  })

  it('aborts an inline auto-execute guard on browser close and removes listeners', async () => {
    queryOne.mockResolvedValue({ id:42, token_version:0 })
    const server = new EventEmitter()
    initBridgeWS(server)
    const connectionHandler = mockWss.on.mock.calls
      .filter(([event]) => event === 'connection')
      .at(-1)?.[1]
    const browserWs = new EventEmitter()
    browserWs.readyState = 1
    browserWs.send = vi.fn()
    browserWs.close = vi.fn()
    await connectionHandler(browserWs, {
      url:'/aurum-api/bridge/ws?type=browser',
      headers:{ origin:'http://localhost:3000', cookie:'ws_token=session-token' },
    })

    expect(isBrowserSocketRegistered(42, browserWs)).toBe(true)
    const guard = createBrowserAutoExecuteGuard(42, browserWs)
    expect(guard.signal.aborted).toBe(false)
    expect(browserWs.listenerCount('close')).toBe(2)
    expect(browserWs.listenerCount('error')).toBe(2)
    browserWs.readyState = 3
    browserWs.emit('close')
    expect(guard.signal.aborted).toBe(true)
    expect(guard.signal.reason).toMatchObject({ code:'manual_auto_execute_request_disconnected' })
    guard.dispose()
    expect(browserWs.listenerCount('close')).toBe(1)
    expect(browserWs.listenerCount('error')).toBe(1)
  })
})

describe('isBridgeAlive', () => {
  it('returns false when no bridges exist', () => {
    expect(isBridgeAlive(999)).toBe(false)
  })

  it('returns false for arbitrary userId', () => {
    expect(isBridgeAlive(1)).toBe(false)
  })
})

describe('isTradeEnabled', () => {
  it('returns false when no bridges exist', () => {
    expect(isTradeEnabled(999)).toBe(false)
  })
})

describe('getOwnBridgeMarketState', () => {
  it('returns bridge_offline when no bridge for userId', () => {
    const state = getOwnBridgeMarketState(999)
    expect(state.alive).toBe(false)
    expect(state.isOpen).toBe(false)
    expect(state.tradeMode).toBe(-1)
    expect(state.reason).toBe('bridge_offline')
  })
})

describe('default observer clock bootstrap', () => {
  const now = Date.UTC(2026, 7, 3, 6, 0, 0)
  const target = {
    connected:true, broker_server:'Broker-Demo', account_login:'90001',
    timezone_offset_minutes:null, clock_status:'unavailable',
  }
  const observer = {
    source_id:3, bridge_user_id:7, trading_account_id:12,
    broker_server:'broker-demo', timezone_offset_minutes:180,
    clock_status:'persisted_stale', last_calibrated_at_utc_msc:now - 2 * 24 * 60 * 60 * 1000,
  }

  it('temporarily inherits a recent trusted clock from the same broker server', () => {
    expect(applyDefaultObserverClockBootstrap(target, observer, now)).toMatchObject({
      broker_server:'Broker-Demo', timezone_offset_minutes:180,
      clock_status:'observer_bootstrap', clock_source:'default_observer_source',
      source_clock_status:'persisted_stale', source_id:3,
      source_bridge_user_id:7, source_trading_account_id:12,
    })
  })

  it('never replaces the terminal own trusted clock', () => {
    const verified = { ...target, timezone_offset_minutes:120, clock_status:'verified' }
    expect(applyDefaultObserverClockBootstrap(verified, observer, now)).toBe(verified)
  })

  it('rejects a different broker server or calibration older than seven days', () => {
    expect(applyDefaultObserverClockBootstrap(target, {
      ...observer, broker_server:'Other-Broker',
    }, now)).toBe(target)
    expect(applyDefaultObserverClockBootstrap(target, {
      ...observer, last_calibrated_at_utc_msc:now - 8 * 24 * 60 * 60 * 1000,
    }, now)).toBe(target)
  })
})

describe('bridge-reported market state', () => {
  it('keeps legacy bridge transport diagnostics out of the V3-only websocket service', () => {
    const source = readFileSync(new URL('../server/bridge-ws.js', import.meta.url), 'utf8')
    expect(source).not.toContain('function handleBridge(')
    expect(source).not.toContain('pendingActions=${pendingActions.join(\',\')}')
  })

  it('reconciles automatic scheduling after the final V3 terminal disconnects', () => {
    const source = readFileSync(new URL('../server/bridge-ws.js', import.meta.url), 'utf8')
    const start = source.indexOf('async function forgetBridgeV3TerminalIdentity')
    const end = source.indexOf('function bridgeV3UserMarketStates', start)
    const disconnect = source.slice(start, end)
    expect(disconnect).toContain('if (!isBridgeAlive(Number(userId)))')
    expect(disconnect).toContain('ai.stopAutoScheduler(Number(userId))')
    expect(disconnect).toContain('ai.removeUserRuntimeAutoSubscription(Number(userId))')
  })

  it('keeps risk recovery single-flight, bounded, and tied to Bridge availability', () => {
    const source = readFileSync(new URL('../server/bridge-ws.js', import.meta.url), 'utf8')
    expect(source).toContain('const RISK_REFRESH_INTERVAL_MS = 60_000')
    expect(source).toContain('const RISK_REFRESH_MAX_BACKOFF_MS = 300_000')
    expect(source).toContain('if (entry.running) { entry.pending = true; return }')
    expect(source).toContain('result?.recoverable_remaining')
    expect(source).toContain('stopRiskSnapshotRefresh(Number(userId))')
    expect(source).toContain("refresh(Number(userId), { trigger:'bridge_background' })")
    expect(source).toContain('hasActiveBridgeDeliveryExecution([userId])')
    expect(source).toContain('isBridgeDeliveryMaintenancePaused(userId)')
    expect(source).toContain('if (entry.pending)')
    expect(source).toContain('export function queueRiskSnapshotRecovery')
  })

  it('maps explicit bridge states to the legacy trade-mode contract', () => {
    expect(normalizeBridgeMarketState({ market_state_version: 1, market_state: 'open', market_reason: 'tick_advancing',
      symbol: 'XAUUSD', symbol_trade_mode: 4, tick_progressing: true }, 1000)).toMatchObject({
      state: 'open', reason: 'market_open', tradeMode: 4, symbol: 'XAUUSD', tickProgressing: true, receivedAt: 1000,
    })
    expect(normalizeBridgeMarketState({ market_state_version: 1, market_state: 'closed', market_reason: 'tick_not_advancing',
      symbol_trade_mode: 4 }, 2000)).toMatchObject({ state: 'closed', reason: 'market_closed', tradeMode: 0, symbolTradeMode: 4 })
    expect(normalizeBridgeMarketState({ market_state_version: 1, market_state: 'restricted', market_reason: 'close_only',
      symbol_trade_mode: 3 })).toMatchObject({ state: 'restricted', reason: 'market_restricted', tradeMode: 3 })
  })

  it('sets a bounded websocket payload size', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    expect(WebSocketServer).toHaveBeenCalledWith(expect.objectContaining({
      maxPayload:BRIDGE_WS_LIMITS.maxPayloadBytes,
    }))
  })

  it('rejects unsupported payloads and preserves missing metrics as null', () => {
    expect(normalizeBridgeMarketState({ market_state: 'open' })).toBeNull()
    expect(normalizeBridgeMarketState({ market_state_version: 1, market_state: 'halted' })).toBeNull()
    expect(normalizeBridgeMarketState({ market_state_version: 1, market_state: 'unknown', tick_age_seconds: null })).toMatchObject({
      reason: 'market_unknown', tradeMode: -1, tickAgeSeconds: null,
    })
  })

  it('retains MT4 quote clock metadata for platform market-data consumers', () => {
    initBridgeWS(new EventEmitter())
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([{
      terminal_instance_id:'terminal_clock_01', platform:'mt4',
      account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    }])

    recordBridgeMarketState(77, {
      timezone_offset_minutes:180, clock_status:'mt4_current_offset',
      clock_residual_ms:0, time:'2026-07-27T06:12:34.000Z',
      observed_at_utc_msc:Date.UTC(2026, 6, 27, 6, 12, 34),
    }, 1_800_000_000_000)

    expect(getPlatformMarketClockState(77)).toMatchObject({
      connected:true, timezone_offset_minutes:180,
      clock_status:'mt4_current_offset', clock_residual_ms:0,
      broker_server:'Broker-Demo', account_login:'12345678', platform:'mt4',
    })
    expect(getLatestBridgeMt5Clock()).toMatchObject({
      time:'2026-07-27T06:12:34.000Z', user_id:77, platform:'mt4',
      received_at:1_800_000_000_000, timezone_offset_minutes:180,
      observed_at_utc_msc:Date.UTC(2026, 6, 27, 6, 12, 34),
    })
  })

  it('builds one canonical browser heartbeat clock from the latest quote', () => {
    expect(buildBrowserHeartbeatClock({
      time:'2026-07-27T06:12:34.000Z',
      observed_at_utc_msc:Date.UTC(2026, 6, 27, 6, 12, 34),
      timezone_offset_minutes:180,
      clock_status:'progressing_tick',
    }, null, null)).toEqual({
      mt5_time:'2026-07-27T06:12:34.000Z',
      observed_at_utc_msc:Date.UTC(2026, 6, 27, 6, 12, 34),
      timezone_offset_minutes:180,
      clock_status:'progressing_tick',
    })
  })

  it('does not combine a new quote time with an older bridge timestamp', () => {
    expect(buildBrowserHeartbeatClock({
      time:'2026-07-27T06:13:00.000Z', timezone_offset_minutes:180,
    }, {
      mt5TimeStr:'2026-07-27T06:12:34.000Z',
      observedAtUtcMsc:Date.UTC(2026, 6, 27, 6, 12, 34),
      timezoneOffsetMinutes:180,
    }, null)).toMatchObject({
      mt5_time:'2026-07-27T06:13:00.000Z', observed_at_utc_msc:null,
      timezone_offset_minutes:180,
    })
  })

  it('exposes the same-broker observer bootstrap clock without inventing a quote time', () => {
    expect(buildBrowserHeartbeatClock(null, null, null, {
      timezone_offset_minutes:180,
      clock_status:'observer_bootstrap',
      clock_source:'default_observer_source',
      source_clock_status:'persisted_stale',
      source_id:9,
      source_last_calibrated_at_utc_msc:Date.UTC(2026, 6, 27, 6, 12, 34),
    })).toEqual({
      mt5_time:null,
      observed_at_utc_msc:null,
      timezone_offset_minutes:180,
      clock_status:'observer_bootstrap',
      clock_source:'default_observer_source',
      source_clock_status:'persisted_stale',
      source_id:9,
      source_last_calibrated_at_utc_msc:Date.UTC(2026, 6, 27, 6, 12, 34),
    })
  })
})

describe('getAllBridges', () => {
  it('returns empty array when no bridges connected', () => {
    const result = getAllBridges()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })
})

describe('getBridgeDiagnostics', () => {
  it('returns empty array when no bridges connected', () => {
    const result = getBridgeDiagnostics()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })
})

describe('getBridgeTradeMode', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns -1 when no bridge exists for userId', async () => {
    queryOne.mockResolvedValue({ id: 1 })
    const mode = await getBridgeTradeMode(999)
    expect(mode).toBe(-1)
  })
})

describe('sendBridgeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(false)
    mockBridgeV3Business.supports.mockReturnValue(false)
  })

  it('fails closed when a new order has no account-specific terminal clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T20:00:00.000Z'))

    const result = await sendBridgeCommand(999, 'open', { symbol: 'XAUUSD' })

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('terminal_clock_unverified')
    expect(result.message).toBe('交易平台时间尚未校准')
    vi.useRealTimers()
  })

  it('fails closed when an AI order does not carry the risk-snapshot clock context', async () => {
    const result = await sendBridgeCommand(91, 'pending', { symbol:'XAUUSD' }, 5000, {
      noFallback:true, requireExecutionClockContext:true, tradingAccountId:12,
    })

    expect(result).toMatchObject({
      status:'rejected', code:'execution_clock_context_missing',
    })
    expect(mockBridgeV3Business.execute).not.toHaveBeenCalled()
  })

  it('binds an AI order payload to the same terminal identity that validated its clock context', () => {
    expect(bindExecutionClockRouteParams({ symbol:'XAUUSD', order_type:'buy_limit' }, {
      terminal_instance_id:'subscriber-terminal',
      broker_server:'ULTIMAMARKETS-DEMO',
      login:'18192234189',
    })).toEqual({
      symbol:'XAUUSD', order_type:'buy_limit', terminal_instance_id:'subscriber-terminal',
      broker_server:'ULTIMAMARKETS-DEMO', login:'18192234189',
    })
  })

  it('uses the same-broker default observer clock for the first-install weekly risk window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T20:00:00.000Z'))
    queryOne.mockImplementation(async sql => String(sql).includes('UNIX_TIMESTAMP') ? {
      source_id:3, bridge_user_id:77, trading_account_id:12,
      broker_server:'Broker-Demo', timezone_offset_minutes:180,
      source_clock_status:'persisted_stale',
      last_calibrated_at_utc_msc:Date.now() - 24 * 60 * 60 * 1000,
    } : null)
    initBridgeWS(new EventEmitter())
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.connectedTerminals.mockReturnValue([{
      terminal_instance_id:'terminal-new', platform:'mt5',
      account_ref:{ broker_server:'broker-demo', login:'90001' },
    }])
    mockBridgeV3Business.connectedUsers.mockReturnValue([{
      userId:91, connected:true, alive:true, lastSeen:Date.now(),
    }])

    const result = await sendBridgeCommand(91, 'open', {
      symbol:'XAUUSD', terminal_instance_id:'terminal-new',
    })

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('weekly_market_close_risk_lock')
    vi.useRealTimers()
  })

  it('returns error when no bridge connected', async () => {
    const result = await sendBridgeCommand(999, 'account', {})
    expect(result.status).toBe('error')
    expect(result.error).toBe('Bridge not connected')
  })

  it('returns error for any userId with no bridge', async () => {
    const result = await sendBridgeCommand(1, 'positions', {})
    expect(result.status).toBe('error')
  })

  it('returns error with noFallback option when no bridge', async () => {
    const result = await sendBridgeCommand(1, 'account', {}, 5000, { noFallback: true })
    expect(result.status).toBe('error')
  })

  it('routes connected commands through the V3 business adapter with version metadata', async () => {
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(true)
    mockBridgeV3Business.execute.mockResolvedValue({ status:'success', command_id:'v3-command' })

    const params = { terminal_instance_id:'terminal-v3', symbol:'XAUUSD' }
    const result = await sendBridgeCommand(91, 'account', params, 4321, {
      noFallback:true, expectedGeneration:7,
    })

    expect(result).toEqual({ status:'success', command_id:'v3-command' })
    expect(mockBridgeV3Business.execute).toHaveBeenCalledWith(91, 'account', params, {
      noFallback:true, expectedGeneration:7, timeoutMs:4321,
    })
  })

  it('rejects connected commands unsupported by the V3 adapter', async () => {
    mockBridgeV3Business.hasConnectedTerminal.mockReturnValue(true)
    mockBridgeV3Business.supports.mockReturnValue(false)

    await expect(sendBridgeCommand(91, 'legacy_action', {})).resolves.toEqual({
      status:'error', error:'bridge_v3_action_unsupported',
    })
    expect(mockBridgeV3Business.execute).not.toHaveBeenCalled()
  })
})

describe('sendToBrowsers', () => {
  it('does not throw when no browsers registered', () => {
    expect(() => sendToBrowsers(1, { type: 'data', trade_mode: 4 })).not.toThrow()
  })

  it('does not throw for heartbeat message with no browsers', () => {
    expect(() => sendToBrowsers(1, { type: 'hb', mt5_connected: false })).not.toThrow()
  })

  it('builds account, position, and revision-only history refresh notifications', () => {
    expect(buildBridgeDataChangedEvent({
      stream:'positions', revision:12,
      terminal:{ terminal_instance_id:'terminal-1' },
    })).toEqual({
      type:'bridge_data_changed', streams:['positions'],
      terminal_instance_id:'terminal-1', revision:12,
    })
    expect(buildBridgeDataChangedEvent({
      stream:'history', revision:14, freshness_state:'fresh',
      terminal:{ terminal_instance_id:'terminal-1' },
    })).toEqual({
      type:'bridge_data_changed', streams:['history'],
      terminal_instance_id:'terminal-1', revision:14,
      history_revision:14, freshness_state:'fresh',
    })
    expect(buildBridgeDataChangedEvent({ stream:'orders', revision:13 })).toBeNull()
  })

  it('forwards only a value-free refresh hint to observer browsers', () => {
    const payload = buildObserverBrowserPayload({
      type:'bridge_data_changed', streams:['account', 'positions', 'orders'],
      terminal_instance_id:'terminal-private', revision:19,
      account:{ balance:12345 }, positions:[{ ticket:'secret' }],
    })
    expect(payload).toEqual({
      type:'bridge_data_changed', streams:['account', 'positions'], _source:'observer_channel',
    })
    expect(JSON.stringify(payload)).not.toContain('terminal-private')
    expect(JSON.stringify(payload)).not.toContain('12345')
    expect(buildObserverBrowserPayload({
      type:'bridge_data_changed', streams:['history'], history_revision:21,
      freshness_state:'refreshing', terminal_instance_id:'terminal-private',
    })).toEqual({
      type:'bridge_data_changed', streams:['history'], history_revision:21,
      freshness_state:'refreshing', _source:'observer_channel',
    })
    expect(buildObserverBrowserPayload({ type:'bridge_data_changed', streams:['orders'] })).toBeNull()
  })
})
