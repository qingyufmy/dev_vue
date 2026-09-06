import { hash } from './v4-backfill-contract.mjs'

export const subscriptionConfigFields = Object.freeze(['memory_mode', 'take_profit_mode', 'risk_profile_id', 'conflicting_strategy_id', 'active_execution_user_key'])

// Source semantics only. A recognized legacy setting is not a V4 permission
// or a completed target mapping. Preserve unknowns rather than applying defaults.
export function reviewSubscriptionConfig(row, strategy, { riskProfiles, strategies }) {
  const source = Object.fromEntries(subscriptionConfigFields.map(field => [field, row[field]]))
  if (Object.values(source).some(value => value !== null && typeof value !== 'string')) throw new Error('subscription_config_source_shape')
  const problems = [], normalizations = []
  const issue = (field, code) => problems.push({ field, code })
  let memoryMode = source.memory_mode
  if (strategy?.scope === 'platform') {
    if (memoryMode === null) { memoryMode = 'platform_only'; normalizations.push('platform_memory_save_default') }
    if (memoryMode !== 'platform_only') issue('memory_mode', 'platform_memory_mode_invalid')
  } else if (strategy?.scope === 'private') {
    if (memoryMode === null || ['shared', 'isolated'].includes(memoryMode)) {
      memoryMode = 'personal'; normalizations.push('private_memory_save_alias')
    }
    if (!['personal', 'off', 'shadow'].includes(memoryMode)) issue('memory_mode', 'private_memory_mode_invalid')
  } else issue('memory_mode', 'strategy_scope_unresolved')
  const takeProfitMode = (source.take_profit_mode || 'ai_recommended').trim().toLowerCase()
  if (takeProfitMode !== source.take_profit_mode) normalizations.push('take_profit_runtime_normalization')
  if (!['ai_recommended', 'conservative', 'standard', 'trend'].includes(takeProfitMode)) issue('take_profit_mode', 'take_profit_mode_unknown')
  const reference = (field, rows, owned) => {
    const id = source[field]
    if (id === null) return { state: 'absent' }
    if (!/^[1-9]\d*$/.test(id)) { issue(field, 'reference_id_invalid'); return { state: 'invalid' } }
    const parent = rows.find(item => item.id === id)
    if (!parent) { issue(field, 'reference_missing'); return { state: 'missing', locatorHash: hash(id) } }
    if (owned && parent.user_id !== row.user_id) issue(field, 'reference_owner_mismatch')
    return { state: 'present', locatorHash: hash(id), parentHash: hash(parent),
      ...(owned ? { sameOwner: parent.user_id === row.user_id, status: parent.status, deleted: parent.deleted_at !== null } : {}) }
  }
  const riskProfile = reference('risk_profile_id', riskProfiles, true)
  const conflictingStrategy = reference('conflicting_strategy_id', strategies, false)
  const expectedKey = row.execution_enabled === '1' && row.is_deleted === '0' ? row.user_id : null
  if (!['0', '1'].includes(row.execution_enabled) || !['0', '1'].includes(row.is_deleted)
    || source.active_execution_user_key !== expectedKey) issue('active_execution_user_key', 'generated_key_mismatch')
  return { sourceHash: hash({ source, strategyScope: strategy?.scope ?? null }), status: problems.length ? 'blocked' : 'recognized', problems, normalizations,
    semantics: { memorySaveMode: memoryMode, takeProfitMode,
      requestedTier: ({ conservative: 1, standard: 2, trend: 3 })[takeProfitMode] ?? null,
      aiMissingRecommendationTier: takeProfitMode === 'ai_recommended' ? 1 : null,
      riskProfile, conflictingStrategy, generatedKeyMatches: source.active_execution_user_key === expectedKey },
    executable: false, blockers: ['memory_runtime_mapping', 'take_profit_target_mapping', 'risk_configuration_authority', 'conflict_reference_mapping'] }
}
