import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'

export const referralRuleSourceFields = Object.freeze({ id: ['int', false], plan: ['varchar(20)', false],
  period: ['varchar(20)', false], rate_bps: ['int', false], enabled: ['tinyint', false] })

export function inspectReferralRuleSources(rows) {
  check(Array.isArray(rows), 'referral_rule_source_invalid')
  const ids = new Set(), scopes = new Set(), entries = [], blockers = []
  for (const source of rows) {
    exactKeys(source, Object.keys(referralRuleSourceFields))
    for (const [field, [type, nullable]] of Object.entries(referralRuleSourceFields)) represent(source[field], type, nullable)
    check(BigInt(source.id) > 0n && !ids.has(source.id), 'referral_rule_identity_invalid')
    ids.add(source.id)
    const scope = JSON.stringify([source.plan, source.period])
    check(!scopes.has(scope), 'referral_rule_duplicate_scope')
    scopes.add(scope)
    const add = code => blockers.push({ sourceId: source.id, code })
    if (!['plus', 'pro'].includes(source.plan) || !['monthly', 'yearly'].includes(source.period)) add('rule_scope_mapping_required')
    if (BigInt(source.rate_bps) < 0n || BigInt(source.rate_bps) > 10000n) add('rule_rate_out_of_range')
    if (!['0', '1'].includes(source.enabled)) add('rule_enabled_mapping_required')
    entries.push({ sourceId: source.id, sourceHash: hash(source), source: { ...source } })
  }
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  const missingScopes = ['plus', 'pro'].flatMap(plan => ['monthly', 'yearly'].flatMap(period =>
    scopes.has(JSON.stringify([plan, period])) ? [] : [{ plan, period }]))
  return { version: 'referral-rule-source/v1', sourceFields: 5, sourceHash: hash(entries.map(entry => entry.source)),
    entries, blockers, missingScopes, historicalTimeConversionRequired: false,
    legacyMissingOrDisabledRuleFallbackBps: '1000', businessCutoverReady: false }
}
