import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

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

import { WebSocketServer } from 'ws'

import {
  initBridgeWS,
  sendBridgeCommand,
  isBridgeAlive,
  isTradeEnabled,
  getOwnBridgeMarketState,
  getBridgeTradeMode,
  getAllBridges,
  getBridgeDiagnostics,
  sendToBrowsers,
  collectTradeRefs,
  buildSignalRefIndex,
  buildSignalPendingActions,
  normalizeBridgeMarketState,
  sendToAdminBrowsers,
  broadcastAdminEvent,
  browserSessionToken,
  BRIDGE_WS_LIMITS,
  createBridgeInitMessageQueue,
  isAllowedBrowserWsOrigin,
  normalizeBridgePage,
  normalizeBridgePageSize,
  wsMessageByteLength,
} from '../server/bridge-ws.js'
import { queryOne } from '../server/db.js'

describe('bridge-ws.js — exported API shape', () => {
  it('initBridgeWS is exported as function', () => {
    expect(typeof initBridgeWS).toBe('function')
  })

  it('sendBridgeCommand is exported as function', () => {
    expect(typeof sendBridgeCommand).toBe('function')
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

describe('bridge initialization queue limits', () => {
  it('closes and clears a peer that floods messages before authentication completes', () => {
    const ws = new EventEmitter()
    ws.close = vi.fn()
    const queue = createBridgeInitMessageQueue(ws)
    for (let index = 0; index <= BRIDGE_WS_LIMITS.maxInitQueueMessages; index++) ws.emit('message', Buffer.from('{}'))
    expect(queue.overflowed).toBe(true)
    expect(ws.close).toHaveBeenCalledWith(1009, expect.stringContaining('payload limit'))
    expect(queue.drain()).toEqual([])
  })

  it('drains accepted early messages exactly once', () => {
    const ws = new EventEmitter()
    ws.close = vi.fn()
    const queue = createBridgeInitMessageQueue(ws)
    ws.emit('message', Buffer.from('{"type":"hb"}'))
    expect(queue.drain()).toHaveLength(1)
    ws.emit('message', Buffer.from('{"type":"hb"}'))
    expect(queue.drain()).toEqual([])
    expect(ws.close).not.toHaveBeenCalled()
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

describe('initBridgeWS', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a WebSocketServer instance', () => {
    const server = new EventEmitter()
    const result = initBridgeWS(server)
    expect(result).toBeDefined()
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

  it('calls handleUpgrade for bridge path', () => {
    const server = new EventEmitter()
    initBridgeWS(server)
    const fakeSocket = { destroy: vi.fn() }
    const req = { url: '/aurum-api/bridge/ws?type=bridge&token=tok', headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    server.emit('upgrade', req, fakeSocket, Buffer.alloc(0))
    expect(mockWss.handleUpgrade).toHaveBeenCalled()
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

describe('bridge-reported market state', () => {
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
  beforeEach(() => vi.clearAllMocks())

  it('rejects new orders during the Beijing weekend risk window before bridge lookup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T20:00:00.000Z'))

    const result = await sendBridgeCommand(999, 'open', { symbol: 'XAUUSD' })

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('weekly_market_close_risk_lock')
    expect(result.message).toBe('周末风险控制期间禁止新增交易')
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
})

describe('sendToBrowsers', () => {
  it('does not throw when no browsers registered', () => {
    expect(() => sendToBrowsers(1, { type: 'data', trade_mode: 4 })).not.toThrow()
  })

  it('does not throw for heartbeat message with no browsers', () => {
    expect(() => sendToBrowsers(1, { type: 'hb', mt5_connected: false })).not.toThrow()
  })
})
