import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

const mockQueryAll = vi.fn()
const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn()
const mockBridge = vi.fn()

vi.mock('../server/db.js', () => ({
  beijingNow: () => '2026-08-19 16:00:00',
  beijingAfter: () => '2026-08-19 16:02:00',
  queryAll: (...args) => mockQueryAll(...args), queryOne: (...args) => mockQueryOne(...args),
  queryRun: (...args) => mockQueryRun(...args),
  withTransaction: vi.fn(async callback => callback(async () => [[{ insertId: 42, affectedRows: 1 }], []])),
}))
vi.mock('../server/bridge-ws.js', () => ({
  getBridgeGeneration: vi.fn(() => 7), isBridgeAlive: vi.fn(() => true), isTradeEnabled: vi.fn(() => true),
}))
vi.mock('../server/routes/ai/market-data.js', () => ({ mt5Bridge: (...args) => mockBridge(...args) }))

import {
  __adminStrategyPendingCancelTest,
  buildAdminStrategyPendingCancelPreview,
  createAdminStrategyPendingCancelJob,
} from '../server/services/admin-strategy-pending-cancel.js'

const dispatch = {
  id: 55, actor_user_id: 1, signal_id: 9001, entry_method: 'limit', symbol: 'XAUUSD', direction: 'buy',
}

function row(overrides = {}) {
  return {
    id: 101, dispatch_id: 55, signal_id: 9001, target_role: 'subscriber', user_id: 2, trading_account_id: 20,
    broker_server_key: 'DEMO', login_account: '2002', bridge_generation: 7, standard_symbol: 'XAUUSD',
    target_snapshot_json: JSON.stringify({ broker: { server:'DEMO', login:'2002' }, bridge_generation:7 }),
    account_snapshot_json: '{}', ownership_snapshot_json: '{}',
    intent_id: 3001, intent_status: 'succeeded', intent_pending_ticket: '88002',
    outcome_id: 4001, outcome_status: 'open', outcome_attribution_status: 'pending', outcome_pending_ticket: '88002',
    outcome_position_id: null, outcome_direction: 'buy', outcome_expected_volume: 0.1,
    outcome_magic: 234000, outcome_original_symbol: 'XAUUSD', outcome_symbol: 'XAUUSD',
    phone: '18192234189', email: null, uid: null, user_nickname: '订阅用户',
    dispatch_signal_id: 9001, dispatch_symbol: 'XAUUSD', dispatch_direction: 'buy', requested_volume: 0.1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockQueryOne.mockImplementation(async sql => String(sql).includes('admin_strategy_pending_cancel_jobs') ? null : dispatch)
  mockQueryAll.mockResolvedValue([])
  mockBridge.mockResolvedValue({ status:'success', account:{ server:'DEMO', login:'2002' }, pending_orders:[] , positions:[] })
})

describe('admin strategy pending cancel contract', () => {
  it('maps each supported pending method to the broker pending type', () => {
    expect(__adminStrategyPendingCancelTest.expectedPendingType('buy', 'limit')).toBe('buy_limit')
    expect(__adminStrategyPendingCancelTest.expectedPendingType('sell', 'stop')).toBe('sell_stop')
    expect(__adminStrategyPendingCancelTest.expectedPendingType('buy', 'stop_limit')).toBe('buy_stop_limit')
  })

  it('classifies filled outcome as safe skip before touching inventory', () => {
    const classified = __adminStrategyPendingCancelTest.classifyStaticTarget(
      row({ outcome_position_id:'99002' }), dispatch,
    )
    expect(classified).toMatchObject({ eligible:false, status:'skipped', reason:'filled' })
  })

  it('preview uses exact account identity and returns subscribers before source', async () => {
    const source = row({ id:102, target_role:'source', user_id:1, trading_account_id:10,
      broker_server_key:'DEMO', login_account:'1001', intent_pending_ticket:'88001', outcome_pending_ticket:'88001',
      target_snapshot_json:JSON.stringify({ broker:{ server:'DEMO', login:'1001' }, bridge_generation:7 }),
      phone:'admin@example.com', user_nickname:'管理员' })
    mockQueryAll.mockResolvedValue([source, row()])
    mockBridge.mockImplementation(async userId => ({ status:'success', account:{ server:'DEMO', login:String(userId === 1 ? '1001' : '2002') },
      pending_orders:[{ ticket:userId === 1 ? '88001' : '88002', symbol:'XAUUSD', pending_type:'buy_limit', side:'buy', volume:0.1, magic:234000 }], positions:[] }))
    const preview = await buildAdminStrategyPendingCancelPreview(1, 55)
    expect(preview.targets.map(target => target.target_role)).toEqual(['subscriber', 'source'])
    expect(preview.targets.every(target => target.eligible)).toBe(true)
    expect(preview.targets.map(target => target.ticket)).toEqual(['88002', '88001'])
    expect(preview.summary.eligible_target_count).toBe(2)
  })

  it('marks absent and identity mismatch as excluded without producing a cancel candidate', async () => {
    mockQueryAll.mockResolvedValue([row(), row({ id:103, user_id:3, trading_account_id:30, login_account:'3003',
      target_snapshot_json:JSON.stringify({ broker:{ server:'DEMO', login:'3003' }, bridge_generation:7 }) })])
    mockBridge.mockImplementation(async userId => ({ status:'success', account:{ server:'DEMO', login:String(userId === 2 ? '2002' : '3003') },
      pending_orders:userId === 2 ? [] : [{ ticket:'88002', symbol:'EURUSD', pending_type:'sell_limit', side:'sell', volume:0.1, magic:234000 }], positions:[] }))
    const preview = await buildAdminStrategyPendingCancelPreview(1, 55)
    expect(preview.targets[0]).toMatchObject({ eligible:false, reason:'already_absent' })
    expect(preview.targets[1]).toMatchObject({ eligible:false, reason:'pending_identity_mismatch' })
  })

  it('requires explicit confirmation when creating a cancel job', async () => {
    await expect(createAdminStrategyPendingCancelJob(1, 55, { reason:'cancel now' }, {}))
      .rejects.toMatchObject({ code:'confirmation_required' })
    expect(mockQueryOne).not.toHaveBeenCalled()
  })

  it('replays an existing idempotent job before rebuilding live preview and fences the dispatch', async () => {
    mockQueryOne.mockImplementation(async sql => {
      const query = String(sql)
      if (query.includes('WHERE idempotency_key = ?')) return { id:77, actor_user_id:1, dispatch_id:55 }
      if (query.includes('WHERE id = ? LIMIT 1')) return { id:77, actor_user_id:1, dispatch_id:55, source_signal_id:9001,
        idempotency_key:'same-request', reason:'cancel now', preview_hash:'hash', status:'completed', target_count:0 }
      return dispatch
    })
    const replay = await createAdminStrategyPendingCancelJob(1, 55, {
      confirm:true, reason:'cancel now', preview_hash:'stale-is-ignored', idempotency_key:'same-request',
    }, {})
    expect(replay).toMatchObject({ id:77, dispatch_id:55, status:'completed' })
    expect(mockBridge).not.toHaveBeenCalled()

    await expect(createAdminStrategyPendingCancelJob(1, 56, {
      confirm:true, reason:'cancel now', preview_hash:'hash', idempotency_key:'same-request',
    }, {})).rejects.toMatchObject({ code:'idempotency_key_conflict' })
  })

  it('keeps route and migration contracts separate from legacy dispatch cancel', () => {
    const route = fs.readFileSync(new URL('../server/routes/admin-strategy-trades.js', import.meta.url), 'utf8')
    const migrations = fs.readFileSync(new URL('../server/migrations.js', import.meta.url), 'utf8')
    expect(route).toContain("router.get('/admin/strategy-trades/:id/pending-cancel-preview'")
    expect(route).toContain("router.post('/admin/strategy-trades/:id/pending-cancel-jobs'")
    expect(route).toContain("router.get('/admin/strategy-trades/pending-cancel-jobs/:jobId'")
    expect(route).toContain("router.post('/admin/strategy-trades/pending-cancel-jobs/:jobId/retry-failed'")
    expect(migrations).toContain("id: '198_admin_pending_dispatch_and_cancel_jobs'")
    expect(migrations).toContain('admin_strategy_pending_cancel_jobs')
    expect(migrations).toContain('admin_strategy_pending_cancel_targets')
    expect(migrations).toContain('pending_valid_minutes')
  })
})
