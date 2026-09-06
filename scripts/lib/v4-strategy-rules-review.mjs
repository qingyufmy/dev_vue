import { hash } from './v4-backfill-contract.mjs'

export function reviewStrategyRules(row) {
  const fields = ['entry_methods_json', 'strategy_policy_json', 'use_chan_analysis', 'use_ema34_filter', 'include_portfolio_context', 'scope']
  const source = Object.fromEntries(fields.map(field => [field, row[field]]))
  if (Object.values(source).some(value => value !== null && typeof value !== 'string')) throw new Error('strategy_rules_source_shape')
  const problems = []
  let methods = null, policy = null
  try {
    const raw = source.entry_methods_json === null ? ['market', 'limit', 'stop', 'stop_limit'] : JSON.parse(source.entry_methods_json)
    if (!Array.isArray(raw) || !raw.length || raw.some(item => typeof item !== 'string' || !['market', 'limit', 'stop', 'stop_limit'].includes(item.trim().toLowerCase()))) throw new Error()
    methods = [...new Set(raw.map(item => item.trim().toLowerCase()))]
  } catch { problems.push({ field: 'entry_methods_json', code: 'strategy_entry_methods_source_invalid' }) }
  for (const field of ['use_chan_analysis', 'use_ema34_filter', 'include_portfolio_context']) {
    if (!['0', '1'].includes(source[field])) problems.push({ field, code: 'strategy_rule_flag_invalid' })
  }
  if (!['platform', 'private'].includes(source.scope)) problems.push({ field: 'scope', code: 'strategy_scope_invalid' })
  if (source.strategy_policy_json !== null) {
    try {
      policy = JSON.parse(source.strategy_policy_json)
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error()
    } catch { problems.push({ field: 'strategy_policy_json', code: 'strategy_policy_source_invalid' }); policy = null }
  }
  return { sourceHash: hash(source), status: problems.length ? 'blocked' : 'reviewed', problems,
    entryMethods: methods, entryMethodsDefaultApplied: source.entry_methods_json === null,
    chanEnabled: source.use_chan_analysis === '1', ema34Enabled: source.use_ema34_filter === '1',
    portfolioContextEnabled: source.scope === 'private' && source.include_portfolio_context === '1',
    policy: policy ? { sourceHash: hash(source.strategy_policy_json), mode: policy.mode ?? null, schemaVersion: policy.schema_version ?? null,
      topLevelKeys: Object.keys(policy).sort(), indicators: Array.isArray(policy.indicators) ? policy.indicators.map(item => ({ kind: item?.kind ?? null, enabled: item?.enabled !== false })) : null } : null,
    executable: false, blockers: ['indicator_and_policy_runtime_mapping', 'strategy_role_mapping'] }
}
