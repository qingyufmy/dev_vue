import { afterEach, describe, expect, it, vi } from 'vitest'

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
  isAdminStrategyTradesEnabled,
  normalizeAdminStrategyTradeInput,
  resolveEffectiveSymbolsForDispatch,
} from '../server/services/admin-strategy-trades.js'
import { accountSymbolInventoryLockKey } from '../server/services/account-symbol-inventory-lock.js'
import fs from 'node:fs'

afterEach(() => { delete process.env.ADMIN_STRATEGY_TRADES_ENABLED })

describe('admin strategy trade contract', () => {
  it('is disabled by default and only enables through the explicit environment gate', () => {
    expect(isAdminStrategyTradesEnabled()).toBe(false)
    process.env.ADMIN_STRATEGY_TRADES_ENABLED = 'true'
    expect(isAdminStrategyTradesEnabled()).toBe(true)
  })

  it('normalizes compatibility aliases while preserving tiered sizing and market-only entry', () => {
    const input = normalizeAdminStrategyTradeInput({
      strategy_id: 7, trading_account_id: 9, symbol: 'EURUSD.s', direction: 'BUY',
      take_profit: 1.12, stop_loss: 1.08, position_size_tier: 'probe', valid_minutes: 5,
      client_request_id: 'client-1', reason: 'breakout', confirm: true,
    })
    expect(input.symbol).toBe('EURUSD')
    expect(input.take_profit_1).toBe(1.12)
    expect(input.idempotency_key).toBe('client-1')
    expect(input.valid_until_utc_msc).toBeGreaterThan(Date.now())
    expect(input.position_size_tier).toBe('probe')
    expect(() => normalizeAdminStrategyTradeInput({ ...input, entry_method: 'limit' })).toThrow('entry_method_not_supported')
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

  it('uses subscription intersection semantics: null inherits, an explicit empty list blocks all symbols', () => {
    expect(resolveEffectiveSymbolsForDispatch(null, '["EURUSD","GBPUSD"]')).toEqual(['EURUSD', 'GBPUSD'])
    expect(resolveEffectiveSymbolsForDispatch('["EURUSD"]', '["EURUSD","GBPUSD"]')).toEqual(['EURUSD'])
    expect(resolveEffectiveSymbolsForDispatch('[]', '["EURUSD"]')).toEqual([])
  })
})
