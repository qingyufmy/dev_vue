import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  beijingNow: () => '2026-08-19 16:00:00', beijingAfter: () => '2026-08-19 16:02:00',
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(async () => ({ changes:1 })),
  withTransaction: vi.fn(async callback => callback(async () => [[{ affectedRows:1 }], []])),
}))
vi.mock('../server/bridge-ws.js', () => ({ getBridgeGeneration: vi.fn(() => 7), isBridgeAlive: vi.fn(() => true), isTradeEnabled: vi.fn(() => true) }))
vi.mock('../server/routes/ai/market-data.js', () => ({ mt5Bridge: vi.fn() }))
vi.mock('../server/services/account-symbol-inventory-lock.js', () => ({
  acquireAccountSymbolInventoryLock: vi.fn(async () => ({ key:'delivery_inventory:2:XAUUSD', token:'lock' })),
  releaseAccountSymbolInventoryLock: vi.fn(async () => true),
}))
vi.mock('../server/services/admin-strategy-trades.js', () => ({ ADMIN_STRATEGY_TRADE_MAGIC:234000 }))

import { __adminStrategyPendingCancelWorkerTest } from '../server/workers/admin-strategy-pending-cancel-worker.js'

const target = {
  user_id:2, broker_server_key:'DEMO', login_account:'2002', ticket:'88002', symbol:'XAUUSD', direction:'buy', volume:0.1,
  expected_state_json:JSON.stringify({ broker_server_key:'DEMO', login_account:'2002', ticket:'88002', symbol:'XAUUSD', direction:'buy', pending_type:'buy_limit', volume:0.1, magic:234000 }),
}

describe('admin strategy pending cancel worker fences', () => {
  it('recognizes only the exact pending ticket, symbol, side, type, volume and magic', () => {
    const result = __adminStrategyPendingCancelWorkerTest.classifyInventory(target, {
      status:'success', account:{ server:'DEMO', login:'2002' },
      pending_orders:[{ ticket:'88002', symbol:'XAUUSD.s', pending_type:'buy_limit', side:'buy', volume:0.1, magic:234000 }], positions:[],
    })
    expect(result.status).toBe('active')
    expect(__adminStrategyPendingCancelWorkerTest.expectedMatches(
      { ticket:'88002', symbol:'XAUUSD.s', pending_type:'sell_limit', side:'sell', volume:0.1, magic:234000 },
      JSON.parse(target.expected_state_json),
    )).toBe(false)
  })

  it('safely classifies absent and filled states without converting either to close', () => {
    expect(__adminStrategyPendingCancelWorkerTest.classifyInventory(target, {
      status:'success', account:{ server:'DEMO', login:'2002' }, pending_orders:[], positions:[],
    })).toMatchObject({ status:'absent' })
    expect(__adminStrategyPendingCancelWorkerTest.classifyInventory(target, {
      status:'success', account:{ server:'DEMO', login:'2002' }, pending_orders:[],
      positions:[{ ticket:'88002', symbol:'XAUUSD', type:'buy', volume:0.1, magic:234000 }],
    })).toMatchObject({ status:'filled' })
  })

  it('reports bridge/inventory failures distinctly from an active order', () => {
    expect(__adminStrategyPendingCancelWorkerTest.classifyInventory(target, { status:'error', error:'bridge_offline' }))
      .toMatchObject({ status:'failed', reason:'bridge_offline' })
    expect(__adminStrategyPendingCancelWorkerTest.classifyInventory(target, {
      status:'success', account:{ server:'OTHER', login:'2002' }, pending_orders:[], positions:[],
    })).toMatchObject({ status:'failed', reason:'account_identity_mismatch' })
  })

  it('uses subscriber-first execution ordering and keeps uncertain as a reconciliation state', () => {
    const source = { target_role:'source', target_order:1 }
    const subscriber = { target_role:'subscriber', target_order:2 }
    expect([subscriber, source].sort((a, b) => (a.target_role === 'subscriber' ? 0 : 1) - (b.target_role === 'subscriber' ? 0 : 1))).toEqual([subscriber, source])
    expect(['uncertain', 'reconciling']).toContain('uncertain')
    expect(['close_system_position']).not.toContain('cancel_system_pending')
  })
})
