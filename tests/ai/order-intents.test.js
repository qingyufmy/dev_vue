import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryAll = vi.fn()
const mockQueryOne = vi.fn()
const mockWithTransaction = vi.fn()
const mockBridge = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryAll: (...args) => mockQueryAll(...args),
  queryOne: (...args) => mockQueryOne(...args),
  withTransaction: (...args) => mockWithTransaction(...args),
  beijingNow: () => '2026-07-15 12:00:00',
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: (...args) => mockBridge(...args),
}))

import {
  buildOrderIdempotencyKey,
  prepareAndExecuteOrderIntent,
  recoverExpiredOrderIntentLeases,
  reconcileUncertainOrderIntents,
} from '../../server/routes/ai/order-intents.js'

let intent
let reservation
let nextIntentId
let txRun

function resultRows(rows) {
  return [Array.isArray(rows) ? rows : [rows], []]
}

function makeRunner() {
  return vi.fn(async (sql, params = []) => {
    if (sql.includes('FROM trading_accounts') || sql.includes('FROM users')) return resultRows({ id: 1, user_id: 1 })
    if (sql.includes('FROM order_intents WHERE idempotency_key')) return resultRows(intent ? [intent] : [])
    if (sql.includes('FROM order_intents WHERE id =')) return resultRows(intent ? [intent] : [])
    if (sql.startsWith('INSERT INTO order_intents')) {
      intent = {
        id: nextIntentId++, idempotency_key: params[0], user_id: params[1], trading_account_id: params[2],
        source_type: params[3], source_id: params[4], client_request_id: params[5], action: params[6],
        symbol: params[7], request_json: params[8], status: 'preparing', lease_token: params[9],
        lease_expires_at: new Date(Date.now() + 30_000).toISOString(), result_json: null,
      }
      return [{ insertId: intent.id, affectedRows: 1 }, []]
    }
    if (sql.startsWith('INSERT INTO risk_reservations')) {
      reservation = { order_intent_id: params[0], status: 'active', reserved_volume: params[4] }
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes("SET status = 'preparing'")) {
      intent.status = 'preparing'
      intent.lease_token = params[0]
      intent.lease_expires_at = new Date(Date.now() + 30_000).toISOString()
      intent.result_json = null
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes("SET status = 'prepared'")) {
      intent.status = 'prepared'
      intent.request_json = params[0]
      intent.risk_json = params[1]
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes("SET status = 'bridge_sending'")) {
      intent.status = 'bridge_sending'
      intent.bridge_command_ref = params[0]
      intent.bridge_payload_json = params[1]
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE order_intents SET status = ?')) {
      intent.status = params[0]
      if (sql.includes('trade_ticket')) {
        intent.trade_ticket = params[1]
        intent.pending_ticket = params[2]
        intent.result_json = params[3]
      } else {
        intent.result_json = params[1]
      }
      intent.lease_token = null
      intent.lease_expires_at = null
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes("SET status = 'uncertain'")) {
      intent.status = 'uncertain'
      intent.result_json = params[0]
      intent.lease_token = null
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes("SET status = 'failed'")) {
      intent.status = 'failed'
      intent.result_json = params[0]
      intent.lease_token = null
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes("SET status = 'succeeded'")) {
      intent.status = 'succeeded'
      intent.trade_ticket = params[0]
      intent.pending_ticket = params[1]
      intent.result_json = params[2]
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('UPDATE risk_reservations')) {
      if (reservation) reservation.status = sql.includes("'committed'") ? 'committed' : 'released'
      return [{ affectedRows: 1 }, []]
    }
    return [{ affectedRows: 1 }, []]
  })
}

function baseArgs(overrides = {}) {
  return {
    userId: 1,
    signalId: 77,
    sourceType: 'signal',
    action: 'ai_execute',
    request: { symbol: 'XAUUSD', order_type: 'buy', volume: 0.01, confirm: true, signal_id: 77 },
    config: { max_position_size: 0.05 },
    validateRequest: vi.fn(() => ({ volume: 0.01 })),
    buildBridgeCall: vi.fn(request => ({ bridgeAction: 'open', bridgeParams: request })),
    bridge: mockBridge,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  intent = null
  reservation = null
  nextIntentId = 1
  txRun = makeRunner()
  mockWithTransaction.mockImplementation(fn => fn(txRun))
  mockQueryAll.mockResolvedValue([])
  mockBridge.mockImplementation(async (_userId, action) => {
    if (action === 'account') return { status: 'success', equity: 1000 }
    if (action === 'quote') return { status: 'success', bid: 2000, ask: 2001, point: 0.01 }
    return { status: 'success', ticket: 123 }
  })
})

describe('idempotency identity', () => {
  it('is stable for one signal/user/account and changes across accounts', () => {
    const first = buildOrderIdempotencyKey({ userId: 1, tradingAccountId: 2, signalId: 3 })
    const same = buildOrderIdempotencyKey({ userId: 1, tradingAccountId: 2, signalId: 3 })
    const other = buildOrderIdempotencyKey({ userId: 1, tradingAccountId: 9, signalId: 3 })
    expect(first).toBe(same)
    expect(other).not.toBe(first)
  })

  it('requires a client request id for non-signal orders', () => {
    expect(() => buildOrderIdempotencyKey({ userId: 1 })).toThrow('client_request_id_required')
  })
})

describe('prepareAndExecuteOrderIntent', () => {
  it('reserves risk, sends once outside the transaction and commits the ticket', async () => {
    const result = await prepareAndExecuteOrderIntent(baseArgs())
    expect(result.status).toBe('success')
    expect(result.order_intent_id).toBe(1)
    expect(intent.status).toBe('succeeded')
    expect(intent.trade_ticket).toBe('123')
    expect(reservation.status).toBe('committed')
    const openCall = mockBridge.mock.calls.find(call => call[1] === 'open')
    expect(openCall[2].comment).toMatch(/^AI-/)
  })

  it('replays a completed result without a second provider order call', async () => {
    await prepareAndExecuteOrderIntent(baseArgs())
    const again = await prepareAndExecuteOrderIntent(baseArgs())
    expect(again.idempotent_replay).toBe(true)
    expect(mockBridge.mock.calls.filter(call => call[1] === 'open')).toHaveLength(1)
  })

  it('returns a pre-send manual validation error without touching the bridge', async () => {
    const result = await prepareAndExecuteOrderIntent(baseArgs({ signalId: null, request: { symbol: 'XAUUSD', confirm: true } }))
    expect(result).toMatchObject({ status: 'rejected', message: 'client_request_id_required' })
    expect(mockBridge).not.toHaveBeenCalled()
  })

  it('allows the same signal to resume after explicit confirmation', async () => {
    const validation = vi.fn((_config, _account, request) => {
      if (!request.confirm) throw Object.assign(new Error('confirmation_required'), { reason: 'confirmation_required' })
      return { volume: 0.01 }
    })
    const first = await prepareAndExecuteOrderIntent(baseArgs({ request: { symbol: 'XAUUSD', order_type: 'buy', volume: 0.01, confirm: false }, validateRequest: validation }))
    expect(first.status).toBe('needs_confirmation')
    expect(intent.status).toBe('awaiting_confirmation')
    const second = await prepareAndExecuteOrderIntent(baseArgs({ validateRequest: validation }))
    expect(second.status).toBe('success')
    expect(mockBridge.mock.calls.filter(call => call[1] === 'open')).toHaveLength(1)
  })

  it('keeps the reservation and blocks resends after a bridge timeout', async () => {
    mockBridge.mockImplementation(async (_userId, action) => {
      if (action === 'account') return { status: 'success', equity: 1000 }
      if (action === 'quote') return { status: 'success', bid: 1, ask: 2 }
      return { status: 'error', error: 'Bridge command timeout' }
    })
    const first = await prepareAndExecuteOrderIntent(baseArgs())
    expect(first.status).toBe('uncertain')
    expect(intent.status).toBe('uncertain')
    expect(reservation.status).toBe('active')
    const second = await prepareAndExecuteOrderIntent(baseArgs())
    expect(second.status).toBe('uncertain')
    expect(mockBridge.mock.calls.filter(call => call[1] === 'open')).toHaveLength(1)
  })

  it('releases the reservation on an explicit broker rejection', async () => {
    mockBridge.mockImplementation(async (_userId, action) => {
      if (action === 'account') return { status: 'success', equity: 1000 }
      if (action === 'quote') return { status: 'success', bid: 1, ask: 2 }
      return { status: 'rejected', message: 'invalid volume' }
    })
    const result = await prepareAndExecuteOrderIntent(baseArgs())
    expect(result.status).toBe('rejected')
    expect(reservation.status).toBe('released')
  })
})

describe('recovery and reconciliation', () => {
  it('turns an expired sending lease into uncertain without releasing risk', async () => {
    intent = { id: 1, status: 'bridge_sending', lease_token: 'old', lease_expires_at: '2020-01-01 00:00:00' }
    reservation = { order_intent_id: 1, status: 'active' }
    mockQueryAll.mockResolvedValue([{ id: 1 }])
    await expect(recoverExpiredOrderIntentLeases()).resolves.toBe(1)
    expect(intent.status).toBe('uncertain')
    expect(reservation.status).toBe('active')
  })

  it('releases an expired pre-send reservation', async () => {
    intent = { id: 1, status: 'prepared', lease_token: 'old', lease_expires_at: '2020-01-01 00:00:00' }
    reservation = { order_intent_id: 1, status: 'active' }
    mockQueryAll.mockResolvedValue([{ id: 1 }])
    await expect(recoverExpiredOrderIntentLeases()).resolves.toBe(1)
    expect(intent.status).toBe('failed')
    expect(reservation.status).toBe('released')
  })

  it('commits an uncertain intent only when its safe comment is observed', async () => {
    intent = { id: 1, user_id: 1, status: 'uncertain', bridge_command_ref: 'AI-1', symbol: 'XAUUSD' }
    reservation = { order_intent_id: 1, status: 'active' }
    mockQueryAll.mockResolvedValue([intent])
    mockBridge.mockImplementation(async (_userId, action) => action === 'pending_list'
      ? { orders: [{ ticket: 555, comment: 'AI-1' }] }
      : action === 'positions' ? { positions: [] } : { history: [] })
    await expect(reconcileUncertainOrderIntents({ bridge: mockBridge })).resolves.toBe(1)
    expect(intent.status).toBe('succeeded')
    expect(intent.trade_ticket).toBeNull()
    expect(intent.pending_ticket).toBe('555')
    expect(reservation.status).toBe('committed')
  })
})
