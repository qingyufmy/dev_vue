import { describe, expect, it } from 'vitest'
import { evaluatePartialCloseProtection, type PartialCloseProtectionPlan, type PartialCloseHistoryProof,
  type ProtectionProjection } from '../src/modules/execution/domain/partial-close-protection.js'

function fixture() {
  const target = { userId: 'u', accountId: 'a', terminalInstanceId: 't', brokerServer: 'Broker', login: '42',
    positionIdentifier: '100', ticket: '101', symbol: 'XAUUSD', side: 'buy' as const }
  const plan: PartialCloseProtectionPlan = { workflowId: 'w', parentIntentId: 'i', parentCommandId: 'c', target,
    initialVolume: '0.10', closeVolume: '0.08', initialRevision: 5, expiresAt: 2000, protection: { stopLoss: '2400' } }
  const history: PartialCloseHistoryProof = { parentIntentId: 'i', parentCommandId: 'c', target: { ...target },
    closedVolume: '0.080', completedAt: 900 }
  const projection: ProtectionProjection = { route: { ...target }, complete: true, revision: 6, observedAt: 950,
    positions: [{ target: { ...target }, volume: '0.020' }] }
  return { plan, history, projection, parentState: 'succeeded' as const, now: 1000, maxProjectionAgeMs: 100 }
}
const evaluate = evaluatePartialCloseProtection

describe('partial close protection eligibility', () => {
  it('requires fresh risk review and returns an independent copy, never a command', () => {
    const input = fixture(), before = structuredClone(input), result = evaluate(input)
    expect(result).toEqual({ state: 'risk_review_required', workflowId: 'w', target: input.plan.target,
      remainingVolume: '0.02', projectionRevision: 6, projectionObservedAt: 950, protection: { stopLoss: '2400' } })
    expect(input).toEqual(before)
    if (result.state === 'risk_review_required') {
      expect(result.target).not.toBe(input.plan.target)
      expect(result.protection).not.toBe(input.plan.protection)
    }
  })
  it('reconciles unknown closes even after expiry, irrespective of a matching projection', () => {
    expect(evaluate({ ...fixture(), parentState: 'uncertain', now: 3000 })).toEqual({ state: 'reconcile_close' })
    expect(evaluate({ ...fixture(), parentState: 'pending' })).toEqual({ state: 'wait_close' })
    expect(evaluate({ ...fixture(), parentState: 'failed' })).toEqual({ state: 'stopped', reason: 'close_not_completed' })
    expect(evaluate({ ...fixture(), parentState: 'cancelled' })).toEqual({ state: 'stopped', reason: 'close_not_completed' })
    expect(evaluate({ ...fixture(), now: 2000 })).toEqual({ state: 'expired' })
  })
  it('does not infer command attribution from a matching quantity delta', () => {
    expect(evaluate({ ...fixture(), history: null })).toEqual({ state: 'wait_history' })
    for (const patch of [{ parentCommandId: 'other' }, { parentIntentId: 'other' }, { closedVolume: '0.07' },
      { completedAt: 1001 }, { completedAt: NaN }]) {
      const input = fixture()
      expect(evaluate({ ...input, history: { ...input.history, ...patch } })).toEqual({ state: 'stopped', reason: 'close_proof_mismatch' })
    }
  })
  it.each(['userId', 'accountId', 'terminalInstanceId', 'brokerServer', 'login', 'positionIdentifier', 'ticket', 'symbol', 'side'] as const)
    ('requires exact historical %s', key => {
      const input = fixture()
      const target = { ...input.history.target, [key]: key === 'side' ? 'sell' as const : 'other' }
      expect(evaluate({ ...input, history: { ...input.history, target } }).state).toBe('stopped')
    })
  it('waits for a complete newer projection observed after the close and recently enough', () => {
    expect(evaluate({ ...fixture(), projection: null })).toEqual({ state: 'wait_projection' })
    for (const patch of [{ complete: false }, { revision: 5 }, { revision: NaN }, { observedAt: 899 },
      { observedAt: 1001 }, { observedAt: NaN }]) {
      const input = fixture()
      expect(evaluate({ ...input, projection: { ...input.projection, ...patch } })).toEqual({ state: 'wait_projection' })
    }
    expect(evaluate({ ...fixture(), now: 1051 })).toEqual({ state: 'wait_projection' })
  })
  it('stops if the projection belongs to another route', () => {
    const input = fixture()
    expect(evaluate({ ...input, projection: { ...input.projection, route: { ...input.projection.route, login: '43' } } }))
      .toEqual({ state: 'stopped', reason: 'projection_route_mismatch' })
  })
  it('never substitutes a same-symbol position or a recycled ticket', () => {
    const input = fixture(), original = input.projection.positions[0]!
    for (const positions of [[], [{ ...original, target: { ...original.target, ticket: '999', positionIdentifier: '999' } }]]) {
      expect(evaluate({ ...input, projection: { ...input.projection, positions } })).toEqual({ state: 'stopped', reason: 'position_absent' })
    }
    for (const positions of [[original, original], [{ ...original, target: { ...original.target, positionIdentifier: '999' } }],
      [{ ...original, target: { ...original.target, ticket: '999' } }]]) {
      expect(evaluate({ ...input, projection: { ...input.projection, positions } })).toEqual({ state: 'stopped', reason: 'position_identity_mismatch' })
    }
  })
  it('rejects additional external quantity changes instead of adapting the frozen continuation', () => {
    const input = fixture()
    expect(evaluate({ ...input, projection: { ...input.projection,
      positions: [{ ...input.projection.positions[0]!, volume: '0.03' }] } }))
      .toEqual({ state: 'stopped', reason: 'remaining_volume_mismatch' })
  })
  it('retains 18-place precision beyond Number safe integer magnitude', () => {
    const input = fixture()
    const result = evaluate({ ...input, plan: { ...input.plan, initialVolume: '9007199254740993.000000000000000003',
      closeVolume: '9007199254740993.000000000000000001' },
      history: { ...input.history, closedVolume: '9007199254740993.000000000000000001' },
      projection: { ...input.projection, positions: [{ ...input.projection.positions[0]!, volume: '0.000000000000000002' }] } })
    expect(result).toMatchObject({ state: 'risk_review_required', remainingVolume: '0.000000000000000002' })
  })
  it('rejects full close, invalid precision, invalid clocks and missing protection intent', () => {
    for (const closeVolume of ['0', '0.10', '0.11', '-1', '8e-2', '0.0800000000000000001']) {
      const input = fixture()
      expect(evaluate({ ...input, plan: { ...input.plan, closeVolume } })).toEqual({ state: 'stopped', reason: 'invalid_plan' })
    }
    const input = fixture()
    expect(evaluate({ ...input, plan: { ...input.plan, protection: {} } }).state).toBe('stopped')
    expect(evaluate({ ...input, now: NaN }).state).toBe('stopped')
    expect(evaluate({ ...input, maxProjectionAgeMs: 0 }).state).toBe('stopped')
  })
})
