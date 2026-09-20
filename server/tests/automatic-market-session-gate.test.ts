import { describe, expect, it } from 'vitest'
import { AutomaticMarketSessionGate } from '../src/modules/market/index.js'

const now = Date.parse('2026-09-20T02:00:00.000Z')
const strategy = { async read() { return { scope: 'platform' as const, ownerUserId: null } } }
const input = { userId: 7, strategyId: '1', strategyVersionId: '11', symbol: 'XAUUSD' }

function source(state: 'open' | 'closed' | 'restricted' | 'stale' | 'unknown', checkedAt = now) {
  return {
    revision: 1, generation: 1, failures: 0, firstFailureAt: null, lastCheckedAt: checkedAt,
    source: { accountId: '9', ownerUserId: 8, connectionId: 'bridge', connectionEpoch: 1 }, resolvedSymbol: 'XAUUSD.s',
    marketState: { state, reason: state === 'open' ? 'trade_allowed' : 'session_closed', checked_at_utc_msc: checkedAt },
  }
}

describe('automatic market session gate', () => {
  it('allows automatic work only for a fresh open session', async () => {
    const gate = new AutomaticMarketSessionGate(strategy, { async read() { return source('open') }, async compareAndSet() { return false } }, 30_000, () => now)
    await expect(gate.check(input)).resolves.toEqual({ allowed: true, reason: 'trade_allowed' })
  })

  it.each(['closed', 'restricted', 'stale', 'unknown'] as const)('pauses automatic work for %s state', async state => {
    const gate = new AutomaticMarketSessionGate(strategy, { async read() { return source(state) }, async compareAndSet() { return false } }, 30_000, () => now)
    await expect(gate.check(input)).resolves.toEqual({ allowed: false, reason: `market_session_${state}` })
  })

  it('fails closed when the authoritative state is missing or expired', async () => {
    const missing = new AutomaticMarketSessionGate(strategy, { async read() { return null }, async compareAndSet() { return false } }, 30_000, () => now)
    const expired = new AutomaticMarketSessionGate(strategy, { async read() { return source('open', now - 30_001) }, async compareAndSet() { return false } }, 30_000, () => now)
    await expect(missing.check(input)).resolves.toEqual({ allowed: false, reason: 'market_session_unverified' })
    await expect(expired.check(input)).resolves.toEqual({ allowed: false, reason: 'market_session_stale' })
  })
})
