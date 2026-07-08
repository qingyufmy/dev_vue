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
}))

vi.mock('../server/redis.js', () => ({
  getRedis: vi.fn(),
  isRedisAvailable: vi.fn(() => false),
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
