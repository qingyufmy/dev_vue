import { expect, it, vi } from 'vitest'
import { BridgeMarketSourceCandidates } from '../src/modules/trading/infrastructure/bridge-market-source-candidates.js'

const source = { accountId: '20', ownerUserId: 1, connectionId: 'connection-20', connectionEpoch: 1 }
const scope = { pool: { kind: 'public' as const }, symbol: 'XAUUSD' }
function fixture(items: Record<string, unknown>[]) {
  const reader = { read: vi.fn().mockResolvedValue({ items, nextCursor: null, observedAt: Date.now() }) }
  return { reader, candidates: new BridgeMarketSourceCandidates({ listAccounts: vi.fn() }, { list: vi.fn() }, { current: vi.fn() }, reader) }
}
it.each(['name', 'symbol'])('uses the platform instrument identity %s', async field => {
  const f = fixture([{ [field]: 'XAUUSD.s', digits: 2 }])
  expect(await f.candidates.probe(scope, source)).toEqual({ status: 'ready', resolvedSymbol: 'XAUUSD.s' })
  expect(f.reader.read).toHaveBeenCalledWith(1, '20', { kind: 'instrument', symbol: 'XAUUSD', timeframe: null, before: null, limit: 1, cursor: null })
})
it('rejects an unrelated instrument even when it carries a misleading symbol field', async () => {
  expect(await fixture([{ name: 'EURUSD.s', symbol: 'XAUUSD' }]).candidates.probe(scope, source)).toEqual({ status: 'unsupported' })
})
it('does not treat missing instrument identity as a usable source', async () => {
  expect(await fixture([{ digits: 2 }]).candidates.probe(scope, source)).toEqual({ status: 'unsupported' })
})
it('accepts fresh bridge decisions without recomputing the classification', async () => {
  const marketState = { state: 'closed', reason: 'symbol_trade_disabled', checked_at_utc_msc: Date.now() }
  expect(await fixture([{ symbol: 'XAUUSD.s', market_state: marketState }]).candidates.probe(scope, source))
    .toEqual({ status: 'ready', resolvedSymbol: 'XAUUSD.s', marketState })
  expect(await fixture([{ symbol: 'XAUUSD.s', market_state: { ...marketState, checked_at_utc_msc: Date.now() - 31000 } }]).candidates.probe(scope, source))
    .toEqual({ status: 'ready', resolvedSymbol: 'XAUUSD.s' })
})
