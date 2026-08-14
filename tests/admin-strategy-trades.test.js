import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  beijingNow: () => '2026-08-14 12:00:00',
  beijingAfter: () => '2026-08-14 12:02:00',
  parseBeijing: value => value ? new Date(String(value).replace(' ', 'T') + '+08:00') : null,
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(),
}))
vi.mock('../server/bridge-ws.js', () => ({
  getBridgeGeneration: vi.fn(() => 3), isBridgeAlive: vi.fn(() => true), isTradeEnabled: vi.fn(() => true),
}))

import {
  __adminStrategyTradeTest,
  normalizeAdminStrategyTradeInput,
  resolveEffectiveSymbolsForDispatch,
} from '../server/services/admin-strategy-trades.js'
import { accountSymbolInventoryLockKey } from '../server/services/account-symbol-inventory-lock.js'
import fs from 'node:fs'

describe('admin strategy trade contract', () => {
  it('keeps admin capabilities enabled after admin auth without an environment gate', () => {
    const route = fs.readFileSync(new URL('../server/routes/admin-strategy-trades.js', import.meta.url), 'utf8')
    const service = fs.readFileSync(new URL('../server/services/admin-strategy-trades.js', import.meta.url), 'utf8')
    expect(route).toContain("router.get('/admin/strategy-trades/capabilities', authMiddleware, adminOnly")
    expect(route).toContain('enabled: true')
    expect(route).not.toContain('isAdminStrategyTradesEnabled')
    expect(service).not.toContain('ADMIN_STRATEGY_TRADES_ENABLED')
    expect(service).not.toContain('assertAdminStrategyTradesEnabled')
  })

  it('keeps every admin strategy trade endpoint inaccessible to non-admin users', () => {
    const route = fs.readFileSync(new URL('../server/routes/admin-strategy-trades.js', import.meta.url), 'utf8')
    const endpoints = [
      "router.get('/admin/strategy-trades/capabilities', authMiddleware, adminOnly",
      "router.post('/admin/strategy-trades/preview', authMiddleware, adminOnly",
      "router.post('/admin/strategy-trades', authMiddleware, adminOnly",
      "router.get('/admin/strategy-trades/:id', authMiddleware, adminOnly",
      "router.post('/admin/strategy-trades/:id/retry', authMiddleware, adminOnly",
      "router.post('/admin/strategy-trades/:id/cancel', authMiddleware, adminOnly",
    ]
    for (const endpoint of endpoints) expect(route).toContain(endpoint)
    expect(route).not.toContain("router.get('/strategy-trades")
    expect(route).not.toContain("router.post('/strategy-trades")
  })

  it('normalizes compatibility aliases while freezing direct volume and market-only entry', () => {
    const input = normalizeAdminStrategyTradeInput({
      strategy_id: 7, trading_account_id: 9, symbol: 'EURUSD.s', direction: 'BUY',
      take_profit: 1.12, stop_loss: 1.08, volume: '0.123456789', valid_minutes: 5,
      client_request_id: 'client-1', reason: 'breakout', confirm: true,
    })
    expect(input.symbol).toBe('EURUSD')
    expect(input.take_profit_1).toBe(1.12)
    expect(input.volume).toBe(0.12345679)
    expect(input.idempotency_key).toBe('client-1')
    expect(input.valid_until_utc_msc).toBeGreaterThan(Date.now())
    expect(input).not.toHaveProperty('position_size_tier')
    expect(() => normalizeAdminStrategyTradeInput({ ...input, entry_method: 'limit' })).toThrow('entry_method_not_supported')
  })

  it('normalizes all optional stop-loss/take-profit combinations without zero sentinels', () => {
    const base = {
      strategy_id: 7, trading_account_id: 9, symbol: 'EURUSD', direction: 'buy',
      volume: 0.1, valid_minutes: 5, reason: 'directed order',
    }
    const cases = [
      [{ stop_loss: '', take_profit: '' }, { stop_loss: null, take_profit_1: null }],
      [{ stop_loss: 1.08, take_profit: '' }, { stop_loss: 1.08, take_profit_1: null }],
      [{ stop_loss: '', take_profit: 1.12 }, { stop_loss: null, take_profit_1: 1.12 }],
      [{ stop_loss: 1.08, take_profit: 1.12 }, { stop_loss: 1.08, take_profit_1: 1.12 }],
    ]
    for (const [overrides, expected] of cases) {
      const input = normalizeAdminStrategyTradeInput({ ...base, ...overrides })
      expect(input).toMatchObject(expected)
      expect(input.stop_loss).not.toBe(0)
      expect(input.take_profit_1).not.toBe(0)
    }
  })

  it('rejects tier-only and non-positive/non-finite volume requests', () => {
    const base = {
      strategy_id: 7, trading_account_id: 9, symbol: 'EURUSD', direction: 'buy',
      take_profit: 1.12, stop_loss: 1.08, valid_minutes: 5, reason: 'breakout',
    }
    expect(() => normalizeAdminStrategyTradeInput({ ...base, position_size_tier: 'probe' })).toThrow('volume_required')
    for (const volume of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeAdminStrategyTradeInput({ ...base, volume })).toThrow('volume_invalid')
    }
  })

  it('normalizes an optional reason while retaining non-empty length limits', () => {
    const base = {
      strategy_id: 7, trading_account_id: 9, symbol: 'EURUSD', direction: 'buy',
      take_profit: 1.12, stop_loss: 1.08, volume: 0.1, valid_minutes: 5,
    }
    for (const reason of [undefined, null, '', '   ']) {
      expect(normalizeAdminStrategyTradeInput({ ...base, reason }).reason).toBe('')
    }
    expect(normalizeAdminStrategyTradeInput({ ...base, reason: '  ok  ' }).reason).toBe('ok')
    expect(() => normalizeAdminStrategyTradeInput({ ...base, reason: 'x' })).toThrow('reason_invalid')
    expect(() => normalizeAdminStrategyTradeInput({ ...base, reason: 'x'.repeat(501) })).toThrow('reason_invalid')
  })

  it('fails closed for invalid target identity and keeps source exclusion deterministic', () => {
    expect(__adminStrategyTradeTest.symbolMatches('EURUSD.s', ['EURUSD'])).toBe(true)
    expect(__adminStrategyTradeTest.sourceEligibility({
      id: 9, observe_status: 'active', ownership_user_id: 1, ownership_trading_account_id: 9,
      trade_send_enabled: 1,
    }, 1)).toBeNull()
    expect(__adminStrategyTradeTest.sourceEligibility({
      id: 9, observe_status: 'active', ownership_user_id: 2, ownership_trading_account_id: 9,
      trade_send_enabled: 1,
    }, 1)).toBe('source_ownership_unavailable')
  })

  it('shares the scheduler inventory fence and keeps admin history out of auto_shared', () => {
    expect(accountSymbolInventoryLockKey(7, 'EURUSD.s')).toBe('delivery_inventory:7:EURUSD')
    const history = fs.readFileSync(new URL('../server/bridge-ws.js', import.meta.url), 'utf8')
    expect(history).toContain("'admin_strategy_dispatch' AS source")
    expect(history).toContain('admin_strategy_trade_targets')
    expect(history).toContain('UNION ALL ${dataAdminSub}')
    expect(history).toContain('const adminParams = [queryUserId, ...observerStrategyParam, ...sharedParams]')
    expect(history).toContain("if (item.admin_target_id) item.source = 'admin_strategy_dispatch'")
  })

  it('persists direct volume with aligned signal and dispatch SQL parameters', () => {
    const service = fs.readFileSync(new URL('../server/services/admin-strategy-trades.js', import.meta.url), 'utf8')
    const signalInsert = service.slice(service.indexOf('INSERT INTO ai_signals'), service.indexOf('const signalId'))
    expect(signalInsert).toContain('recommended_volume, analysis, reasoning')
    expect(signalInsert).toContain("'admin_strategy_dispatch', 0, 0, ?, ?, 'market', ?")
    expect(signalInsert).not.toContain("'admin_strategy_dispatch', ?, 0, ?, ?, 'market', ?")
    const dispatchInsert = service.slice(service.indexOf('INSERT INTO admin_strategy_trade_dispatches'), service.indexOf('const dispatchId'))
    expect(dispatchInsert).toContain('requested_volume, position_size_tier')
    expect(dispatchInsert).toContain("?, ?, ?, 'confirmed', ?, ?, ?, ?")
    expect(dispatchInsert).toContain('input.entry_method, input.entry_price, input.stop_loss, input.take_profit_1')
    expect(signalInsert).toContain('input.stop_loss, input.take_profit_1')
  })

  it('keeps the optional protection migration idempotent and nullable', () => {
    const migrations = fs.readFileSync(new URL('../server/migrations.js', import.meta.url), 'utf8')
    const start = migrations.indexOf("id: '190_admin_strategy_trade_optional_protection'")
    expect(start).toBeGreaterThanOrEqual(0)
    const migration = migrations.slice(start, migrations.indexOf('\n  }\n]', start))
    expect(migration).toContain("COLUMN_NAME IN ('stop_loss', 'take_profit_1')")
    expect(migration).toContain('IS_NULLABLE')
    expect(migration).toContain('ADD COLUMN ${columnName} DECIMAL(20,8) DEFAULT NULL')
    expect(migration).toContain('MODIFY COLUMN ${columnName} DECIMAL(20,8) DEFAULT NULL')
  })

  it('uses subscription intersection semantics: null inherits, an explicit empty list blocks all symbols', () => {
    expect(resolveEffectiveSymbolsForDispatch(null, '["EURUSD","GBPUSD"]')).toEqual(['EURUSD', 'GBPUSD'])
    expect(resolveEffectiveSymbolsForDispatch('["EURUSD"]', '["EURUSD","GBPUSD"]')).toEqual(['EURUSD'])
    expect(resolveEffectiveSymbolsForDispatch('[]', '["EURUSD"]')).toEqual([])
  })
})
