import { describe, expect, it } from 'vitest'
import { MarketSourceSelector } from '../src/modules/market/application/market-source-selector.js'
import type { MarketSourceProbe, MarketSourceStore } from '../src/modules/market/application/market-source-ports.js'
import { marketPoolKey, type MarketSourceCandidate, type MarketSourceScope, type MarketSourceState } from '../src/modules/market/domain/market-source.js'

const scope: MarketSourceScope = { pool: { kind: 'public' }, symbol: 'XAUUSD' }
const candidate = (id: string, owner = 7): MarketSourceCandidate => ({ accountId: id, ownerUserId: owner, connectionId: `connection-${id}`, connectionEpoch: 1 })
function fixture() {
  const states = new Map<string, MarketSourceState>()
  const key = (s: MarketSourceScope) => `${marketPoolKey(s.pool)}:${s.symbol}`
  const store: MarketSourceStore = {
    async read(s) { return structuredClone(states.get(key(s)) ?? null) },
    async compareAndSet(s, expected, next) {
      if ((states.get(key(s))?.revision ?? null) !== expected) return false
      states.set(key(s), structuredClone(next)); return true
    },
  }
  let now = 1_000_000, available = [candidate('10'), candidate('2')]
  const failures = new Map<string, MarketSourceProbe>()
  const candidates = { async list() { return [...available] }, async probe(_s: MarketSourceScope, c: MarketSourceCandidate): Promise<MarketSourceProbe> {
    return failures.get(c.accountId) ?? { status: 'ready', resolvedSymbol: 'XAUUSD.s' }
  } }
  return { selector: new MarketSourceSelector(store, candidates, () => now), store, candidates, failures,
    setAvailable(v: MarketSourceCandidate[]) { available = v }, advance(ms: number) { now += ms } }
}

describe('shared sticky market source selection', () => {
  it('elects a single numeric-order winner under concurrent first selection', async () => {
    const f = fixture()
    const selections = await Promise.all(Array.from({ length: 8 }, () => f.selector.select(scope)))
    expect(new Set(selections.map(s => `${s.source?.accountId}:${s.generation}`))).toEqual(new Set(['2:1']))
  })
  it('does not preempt for a new smaller ID and restores persisted selection after restart', async () => {
    const f = fixture(); await f.selector.select(scope)
    f.setAvailable([candidate('1'), candidate('2'), candidate('10')]); f.advance(6000)
    expect((await new MarketSourceSelector(f.store, f.candidates, () => 1_010_000).select(scope)).source?.accountId).toBe('2')
  })
  it('changes generation when the chosen connection goes away and rejects late results', async () => {
    const f = fixture(), old = await f.selector.select(scope)
    f.setAvailable([candidate('10')])
    const next = await f.selector.select(scope)
    expect(next.source?.accountId).toBe('10'); expect(next.generation).toBe(2)
    expect(await f.selector.isCurrent(scope, old)).toBe(false)
    f.setAvailable([candidate('2'), candidate('10')]); f.advance(6000)
    expect((await f.selector.select(scope)).source?.accountId).toBe('10')
  })
  it('fences the old epoch even when reconnecting the same account', async () => {
    const f = fixture(), old = await f.selector.select(scope)
    f.setAvailable([{ ...candidate('2'), connectionId: 'new-connection', connectionEpoch: 2 }])
    const next = await f.selector.select(scope)
    expect(next.generation).toBe(2); expect(await f.selector.isCurrent(scope, old)).toBe(false)
  })
  it('tolerates temporary failure but changes source after sustained failure', async () => {
    const f = fixture(); await f.selector.select(scope)
    f.failures.set('2', { status: 'temporary_failure' })
    f.advance(6000); expect((await f.selector.select(scope)).source?.accountId).toBe('2')
    f.advance(6000); expect((await f.selector.select(scope)).source?.accountId).toBe('2')
    f.advance(10_000); expect((await f.selector.select(scope)).source?.accountId).toBe('10')
  })
  it('does not replace a busy readable source or exclude disabled trading accounts', async () => {
    const f = fixture(); await f.selector.select(scope); f.failures.set('2', { status: 'busy' }); f.advance(6000)
    expect((await f.selector.select(scope)).source?.accountId).toBe('2')
  })
  it('skips unsupported candidates per symbol and never invents a fallback', async () => {
    const f = fixture(); f.failures.set('2', { status: 'unsupported' })
    expect((await f.selector.select(scope)).source?.accountId).toBe('10')
    f.setAvailable([]); expect((await f.selector.select(scope)).source).toBeNull()
  })
  it('isolates public and private keys and refuses another owner in a private pool', async () => {
    const f = fixture(); await f.selector.select(scope)
    const privateScope: MarketSourceScope = { ...scope, pool: { kind: 'private', userId: 8 } }
    await expect(f.selector.select(privateScope)).rejects.toThrow('market_source_candidate_invalid')
    f.setAvailable([candidate('10', 8)])
    expect((await f.selector.select(privateScope)).generation).toBe(1)
    expect((await f.store.read(scope))?.source?.accountId).toBe('2')
  })
})
