import { describe, expect, it } from 'vitest'
import { assertTraderDecisionResult, type TraderDecisionResult, type TraderInputSnapshot } from '../src/modules/inference/domain/inference.js'
import { resolvePartialCloseActions } from '../src/modules/risk/domain/partial-close-actions.js'
import type { RiskAction, RiskJsonObject } from '../src/modules/risk/domain/risk-action.js'

const revisions = { analysisRevision: 1, subscriptionRevision: 1, accountRevision: 1, positionsRevision: 3,
  pendingOrdersRevision: 1, quoteRevision: 1, contractRevision: 2, riskRevision: 1 }
const snapshot: TraderInputSnapshot = { ...revisions, kind: 'trader', taskMode: 'entry',
  strategy: { id: '1', versionId: '2', promptText: '', promptHash: '' }, analysis: { id: 'a', contentHash: '', result: {} },
  account: {}, positions: [], pendingOrders: [], quote: {}, contract: {}, risk: {}, capturedAt: '2026-09-10T00:00:00.000Z',
  entryMethods: ['market'] }
function fixture() {
  const action: RiskAction = { actionId: 'close-1', kind: 'close_position', parameters: {
    ticket: '101', close_percent: '80', after_close_protection: { stop_loss: '2400.01', take_profit: '2600' },
  }, expectedState: { ...revisions } }
  const result: TraderDecisionResult = { action: 'close_position', side: 'buy', confidence: 80, summary: '测试', reasoning: '测试', actions: [action] }
  const positions: RiskJsonObject[] = [{ ticket: '101', positionIdentifier: '100', symbol: 'XAUUSD', volume: '0.10' }]
  return { result, positions, instrument: { symbol: 'XAUUSD', volumeMin: '0.01', volumeMax: '100', volumeStep: '0.01', revision: 2 },
    currentRevisions: { positions: 3, contract: 2 } }
}

describe('after-close proposal and deterministic compilation', () => {
  it('preserves the proposed prices, freezes current identity and quantity, and requires another risk review', () => {
    const input = fixture(), original = structuredClone(input)
    expect(() => assertTraderDecisionResult(input.result, snapshot)).not.toThrow()
    const resolved = resolvePartialCloseActions(input)
    expect(resolved.actions[0]!.parameters).toEqual({ ticket: '101', volume: '0.08',
      after_close_protection: { stop_loss: '2400.01', take_profit: '2600' },
      after_close_target: { position_identifier: '100', initial_volume: '0.10', positions_revision: 3 } })
    expect(resolved.rules.map(rule => rule.code)).toEqual(['RISK_PARTIAL_CLOSE_VOLUME_RESOLVED', 'RISK_AFTER_CLOSE_PROTECTION_DEFERRED'])
    expect(resolved.rules[1]!.details).toMatchObject({ remaining_volume: '0.02', current_risk_review_required: true })
    expect(input).toEqual(original)
    ;(resolved.actions[0]!.parameters.after_close_protection as RiskJsonObject).stop_loss = '1'
    expect(input.result.actions[0]!.parameters.after_close_protection).toEqual(original.result.actions[0]!.parameters.after_close_protection)
  })
  it('validates an explicit partial quantity without producing a percentage conversion audit', () => {
    const input = fixture(), params = input.result.actions[0]!.parameters
    delete params.close_percent
    params.volume = '0.080'
    expect(() => assertTraderDecisionResult(input.result, snapshot)).not.toThrow()
    const resolved = resolvePartialCloseActions(input)
    expect(resolved.actions[0]!.parameters.volume).toBe('0.08')
    expect(resolved.rules.map(rule => rule.code)).toEqual(['RISK_AFTER_CLOSE_PROTECTION_DEFERRED'])
  })
  it.each([null, {}, [], { stop_loss: '0' }, { stop_loss: 2400 }, { stop_loss: '1e3' },
    { stop_loss: '01' }, { stop_loss: '1.0000000000000000001' }, { stop_loss: '1'.repeat(30) },
    { remove_stop_loss: true }, { stop_loss: '2400', extra: '1' }])('rejects invalid or extra protection fields %j', protection => {
    const input = fixture()
    input.result.actions[0]!.parameters.after_close_protection = protection
    expect(() => assertTraderDecisionResult(input.result, snapshot)).toThrow('trader_after_close_protection_invalid')
    expect(() => resolvePartialCloseActions(input)).toThrow()
  })
  it.each([null, '0', '-1', '1e-2', '01', 0.08])('rejects invalid explicit partial volume %j before risk compilation', volume => {
    const input = fixture(), params = input.result.actions[0]!.parameters
    delete params.close_percent
    params.volume = volume
    expect(() => assertTraderDecisionResult(input.result, snapshot)).toThrow('trader_after_close_protection_invalid')
    expect(() => resolvePartialCloseActions(input)).toThrow()
  })
  it.each(['0.10', '0.11', '0.085', '0.001'])('rejects full, excessive or off-step closes %s', volume => {
    const input = fixture(), params = input.result.actions[0]!.parameters
    delete params.close_percent
    params.volume = volume
    expect(() => resolvePartialCloseActions(input)).toThrow('partial_close_limits_invalid')
  })
  it('rejects a model-supplied target even when null or copied from a prior successful compilation', () => {
    for (const target of [null, { position_identifier: '100', initial_volume: '0.10', positions_revision: 3 }]) {
      const input = fixture()
      input.result.actions[0]!.parameters.after_close_target = target
      expect(() => assertTraderDecisionResult(input.result, snapshot)).toThrow('trader_after_close_target_reserved')
      expect(() => resolvePartialCloseActions(input)).toThrow('partial_close_target_reserved')
    }
  })
  it.each([null, '0', '0100', '18446744073709551616', 100])('requires an exact uint64 stable identity %j', identifier => {
    const input = fixture()
    input.positions[0]!.positionIdentifier = identifier
    expect(() => resolvePartialCloseActions(input)).toThrow('partial_close_identifier_invalid')
  })
  it('rejects duplicate stable identity on a different ticket and stale position revisions', () => {
    const input = fixture()
    input.positions.push({ ...input.positions[0]!, ticket: '102' })
    expect(() => resolvePartialCloseActions(input)).toThrow('partial_close_identifier_invalid')
    input.positions.pop()
    input.currentRevisions.positions++
    expect(() => resolvePartialCloseActions(input)).toThrow('partial_close_revision_stale')
  })
  it.each(['close_position', 'modify_position'] as const)('rejects concurrent %s against the same ticket', kind => {
    const input = fixture()
    input.result.actions.push({ actionId: 'other', kind, parameters: { ticket: '101', stop_loss: '2390' }, expectedState: { ...revisions } })
    expect(() => assertTraderDecisionResult(input.result, snapshot)).toThrow('trader_after_close_target_conflict')
    expect(() => resolvePartialCloseActions(input)).toThrow('partial_close_target_conflict')
  })
})
