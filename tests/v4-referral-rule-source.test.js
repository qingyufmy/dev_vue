import { describe, expect, it } from 'vitest'
import { inspectReferralRuleSources } from '../scripts/lib/v4-referral-rule-source.mjs'

const row = (overrides = {}) => ({ id: '1', plan: 'plus', period: 'monthly', rate_bps: '1000', enabled: '1', ...overrides })
describe('referral rule source inventory', () => {
  it('preserves disabled and zero-rate rules without applying a commission', () => {
    const source = row({ enabled: '0', rate_bps: '0' })
    const result = inspectReferralRuleSources([source])
    expect(result.entries[0].source).toEqual(source)
    expect(result.blockers).toEqual([])
    expect(result.missingScopes).toHaveLength(3)
    expect(result.businessCutoverReady).toBe(false)
  })
  it('blocks unknown scope, invalid rates and non-boolean flags without coercion', () => {
    expect(inspectReferralRuleSources([row({ plan: 'PLUS', rate_bps: '-1', enabled: '2' })]).blockers.map(x => x.code))
      .toEqual(['rule_scope_mapping_required', 'rule_rate_out_of_range', 'rule_enabled_mapping_required'])
    expect(inspectReferralRuleSources([row({ rate_bps: '10001' })]).blockers).toHaveLength(1)
    expect(inspectReferralRuleSources([row({ rate_bps: '10000' })]).blockers).toEqual([])
  })
  it('rejects duplicate identities, scopes and incomplete source rows', () => {
    expect(() => inspectReferralRuleSources([row(), row({ period: 'yearly' })])).toThrow()
    expect(() => inspectReferralRuleSources([row(), row({ id: '2' })])).toThrow()
    expect(() => inspectReferralRuleSources([{ id: '1' }])).toThrow()
  })
  it('hashes every field and sorts IDs numerically independent of input order', () => {
    const rows = [row({ id: '10' }), row({ id: '2', period: 'yearly' })]
    const result = inspectReferralRuleSources(rows)
    expect(result.entries.map(x => x.sourceId)).toEqual(['2', '10'])
    expect(inspectReferralRuleSources([...rows].reverse()).sourceHash).toBe(result.sourceHash)
    for (const replacement of [{ id: '11' }, { plan: 'pro' }, { period: 'other' }, { rate_bps: '0' }, { enabled: '0' }])
      expect(inspectReferralRuleSources([row(replacement)]).sourceHash).not.toBe(inspectReferralRuleSources([row()]).sourceHash)
  })
})
