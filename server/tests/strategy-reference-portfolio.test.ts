import { describe, expect, it } from 'vitest'
import { freezeStrategyReferencePortfolio, type StrategyReferencePortfolio, type StrategyReferenceScope } from '../src/modules/inference/application/strategy-reference-portfolio.js'
import { contentHash } from '../src/modules/inference/domain/inference.js'

const scope: StrategyReferenceScope = { analysisId: '00000000-0000-4000-8000-000000000001', userId: 7, targetAccountId: '8', analysisStrategyId: '10', traderStrategyId: '20', symbol: 'XAUUSD', asOf: '2026-09-09T00:00:10.000Z' }
const ready = (): Extract<StrategyReferencePortfolio, { state: 'ready' }> => ({ state: 'ready', scope: structuredClone(scope), sourceAccountId: '9',
  observedAt: '2026-09-09T00:00:09.000Z', positionsRevision: 1, pendingOrdersRevision: 2,
  positions: [{ referenceId: 'execution:1', side: 'buy', volume: '0.1', entryPrice: '2500', stopLoss: '2490', takeProfit: null }], pendingOrders: [] })
const freeze = (value: StrategyReferencePortfolio) => freezeStrategyReferencePortfolio(scope, { async read() { return value } })

describe('frozen strategy reference portfolio', () => {
  it('distinguishes missing wiring, explicit non-applicability and a proven empty collection', async () => {
    expect(await freezeStrategyReferencePortfolio(scope)).toBeUndefined()
    expect(await freeze({ state: 'not_applicable', scope })).toEqual({ schemaVersion: 2, state: 'not_applicable', analysisId: scope.analysisId })
    const value = ready(); value.positions = []
    expect(await freeze(value)).toMatchObject({ state: 'ready', positions: [], pendingOrders: [], positionsRevision: 1 })
  })
  it('projects reference fields without tickets and freezes source observations', async () => {
    const value = ready(); Object.assign(value.positions[0]!, { ticket: 'foreign-ticket', accountPassword: 'not-a-real-secret' })
    const frozen = await freeze(value), digest = contentHash(frozen)
    value.positions[0]!.volume = '9'
    expect(frozen).toMatchObject({ purpose: 'strategy_reference_only', sourceAccountId: '9', positions: [{ volume: '0.1' }] })
    expect(JSON.stringify(frozen)).not.toContain('foreign-ticket')
    expect(JSON.stringify(frozen)).not.toContain('accountPassword')
    expect(contentHash(frozen)).toBe(digest)
  })
  it('rejects another user, account, strategy or symbol scope', async () => {
    for (const patch of [{ userId: 8 }, { targetAccountId: '9' }, { analysisStrategyId: '11' }, { traderStrategyId: '21' }, { symbol: 'EURUSD' }]) {
      const value = ready(); Object.assign(value.scope, patch)
      await expect(freeze(value)).rejects.toMatchObject({ code: 'strategy_reference_portfolio_invalid' })
    }
  })
  it('rejects stale or unknown collections rather than manufacturing an empty result', async () => {
    for (const patch of [{ observedAt: '2026-09-08T23:59:00.000Z' }, { observedAt: '2026-09-09T00:00:11.000Z' }, { positionsRevision: 0 }]) {
      await expect(freeze(Object.assign(ready(), patch))).rejects.toMatchObject({ code: 'strategy_reference_portfolio_invalid' })
    }
    await expect(freezeStrategyReferencePortfolio(scope, { async read() { throw Error('reader_unavailable') } })).rejects.toThrow('reader_unavailable')
  })
  it('binds the exact analysis even when strategies and account are unchanged', async () => {
    const other = '00000000-0000-4000-8000-000000000002'
    for (const state of ['ready', 'not_applicable'] as const) {
      const value = state === 'ready' ? ready() : { state, scope: structuredClone(scope) }
      value.scope.analysisId = other
      await expect(freeze(value)).rejects.toMatchObject({ code: 'strategy_reference_portfolio_invalid' })
    }
    const first = await freeze(ready())
    const value = ready(); value.scope.analysisId = other
    const second = await freezeStrategyReferencePortfolio(value.scope, { async read() { return value } })
    expect(first).toMatchObject({ schemaVersion: 2, analysisId: scope.analysisId })
    expect(second?.evidenceHash).not.toBe(first?.evidenceHash)
  })
  it('rejects missing or malformed analysis provenance before calling the provider', async () => {
    for (const analysisId of [undefined, '', '1', 'not-an-analysis']) {
      let called = false
      await expect(freezeStrategyReferencePortfolio({ ...scope, analysisId } as StrategyReferenceScope, {
        async read() { called = true; return ready() },
      })).rejects.toMatchObject({ code: 'strategy_reference_portfolio_invalid' })
      expect(called).toBe(false)
    }
  })
  it('rejects duplicate references and keeps pending type and UTC validity explicit', async () => {
    const value = ready(); value.positions.push({ ...value.positions[0]! })
    await expect(freeze(value)).rejects.toMatchObject({ code: 'strategy_reference_portfolio_invalid' })
    value.positions.pop()
    value.pendingOrders = [{ ...value.positions[0]!, orderType: 'buy_limit', validUntil: '2026-09-09T01:00:00.000Z' }]
    expect(await freeze(value)).toMatchObject({ pendingOrders: [{ orderType: 'buy_limit', validUntil: '2026-09-09T01:00:00.000Z' }] })
    value.pendingOrders[0]!.orderType = 'sell_limit'
    await expect(freeze(value)).rejects.toMatchObject({ code: 'strategy_reference_portfolio_invalid' })
  })
})
