import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { compileStrategy } from '../../server/dist-v4/modules/strategies/application/strategy-service.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const allowed = { analysis: ['price_action_evidence'], trader: ['entry_event_policy', 'risk_budget'] }

/** Explicit reviewed additions only; never infer policy from a strategy ID or prompt. */
export function bindStrategyRoleCandidateConfig(converted, additions) {
  const result = structuredClone(converted)
  if (additions === undefined) return result
  check(object(additions) && Object.keys(additions).every(role => Object.hasOwn(allowed, role)), 'role_config_additions_invalid')
  check(object(result.analysisConfig) && object(result.traderConfig), 'role_config_base_missing')
  const baseConfigHash = hash({ analysis: result.analysisConfig, trader: result.traderConfig })
  for (const [role, fields] of Object.entries(additions)) {
    check(object(fields) && Object.keys(fields).every(key => allowed[role].includes(key)), 'role_config_additions_invalid')
    const config = result[`${role}Config`]
    for (const [key, value] of Object.entries(fields)) {
      check(!Object.hasOwn(config, key) || hash(config[key]) === hash(value), 'role_config_override_forbidden')
      config[key] = structuredClone(value)
    }
    const compiled = compileStrategy(role, 'reviewed candidate configuration', config)
    check(compiled.valid, 'role_config_compile_failed')
    result[`${role}Config`] = compiled.normalizedConfig
  }
  const policy = result.traderConfig.entry_event_policy
  if (policy) {
    check(result.analysisConfig.price_action_evidence?.enabled === true, 'role_config_event_source_missing')
    check(result.analysisConfig.market_data_plan?.timeframes?.some(frame => frame.timeframe === policy.timeframe), 'role_config_event_timeframe_missing')
  }
  result.reviewedAdditions = { baseConfigHash, additionsHash: hash(additions), values: structuredClone(additions),
    resultConfigHash: hash({ analysis: result.analysisConfig, trader: result.traderConfig }) }
  // Binding implemented controls is not acceptance of all legacy strategy semantics.
  result.executable = false
  return result
}
