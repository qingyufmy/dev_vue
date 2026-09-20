import { hash } from './v4-backfill-contract.mjs'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'

// Dry-run lineage only. It never grants runtime permission or chooses a strategy role.
export function planStrategySubscriptionLineage(inventory, roleMappings = []) {
  if (inventory?.inspected !== true || inventory?.identity?.db !== 'dev_vue' || inventory.historyCount !== 188
    || !Array.isArray(inventory.strategyCandidates) || !Array.isArray(inventory.subscriptionCandidates)
    || !Array.isArray(roleMappings)) throw Error('strategy_lineage_inventory_invalid')
  const unique = (rows, field) => {
    const map = new Map()
    for (const row of rows) {
      if (typeof row?.[field] !== 'string' || map.has(row[field])) throw Error('strategy_lineage_duplicate_source')
      map.set(row[field], row)
    }
    return map
  }
  const sources = unique(inventory.strategyCandidates, 'sourceId')
  unique(inventory.subscriptionCandidates, 'sourceId')
  const mappings = unique(roleMappings, 'sourceId')
  const targets = new Set(), versions = new Set()
  const checkId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= 18446744073709551615n
  for (const mapping of mappings.values()) {
    const source = sources.get(mapping.sourceId)
    if (!source || mapping.sourceHash !== source.sourceHash || mapping.promptHash !== source.promptHash) throw Error('strategy_lineage_mapping_source_changed')
    if (mapping.disposition === 'archive_only') {
      if (source.lifecycle !== 'retired' || inventory.subscriptionCandidates.some(row => row.strategySourceId === source.sourceId)
        || mapping.analysis !== undefined || mapping.trader !== undefined
        || mapping.archive?.table !== 'auto_prompt_types' || mapping.archive?.sourceId !== source.sourceId
        || mapping.archive?.sourceHash !== source.sourceHash) throw Error('strategy_lineage_archive_invalid')
      continue
    }
    if (!mapping.analysis || !mapping.trader) throw Error('strategy_lineage_roles_required')
    for (const role of ['analysis', 'trader']) {
      const target = mapping[role]
      if (target.kind !== role || !checkId(target.strategyId) || !checkId(target.versionId)
        || !/^[0-9a-f]{64}$/.test(target.promptHash ?? '') || !/^[0-9a-f]{64}$/.test(target.configHash ?? '')) throw Error('strategy_lineage_target_invalid')
      if (targets.has(target.strategyId) || versions.has(target.versionId)) throw Error('strategy_lineage_target_collision')
      targets.add(target.strategyId); versions.add(target.versionId)
    }
  }
  const strategyRows = [...sources.values()].map(source => ({ sourceId: source.sourceId, sourceHash: source.sourceHash,
    sourceVersion: source.sourceVersion, originalPromptHash: source.promptHash,
    lifecycle: source.lifecycle, disposition: mappings.get(source.sourceId)?.disposition ?? 'role_mapping',
    legacyIdentities: mappings.get(source.sourceId)?.disposition === 'archive_only' ? null
      : Object.fromEntries(['analysis', 'trader'].map(role => [role, strategyRoleLegacyIdentity(source.sourceId, source.sourceVersion, role)])),
    roles: mappings.get(source.sourceId)?.disposition === 'archive_only' ? null : mappings.get(source.sourceId) ?? null,
    archive: mappings.get(source.sourceId)?.archive ?? null,
    problems: [...source.problems, ...(mappings.has(source.sourceId) ? [] : ['explicit_analysis_and_trader_mapping_required'])] }))
  const subscriptionRows = inventory.subscriptionCandidates.map(source => {
    const problems = [...source.problems]
    const strategy = sources.get(source.strategySourceId), mapping = mappings.get(source.strategySourceId)
    if (!strategy) problems.push('strategy_source_missing')
    if (!mapping) problems.push('strategy_role_mapping_missing')
    if (!checkId(source.targetAccountId)) problems.push('persisted_account_mapping_missing')
    if (!['current_owner', 'historical_only'].includes(source.ownershipDisposition)) problems.push('ownership_unresolved')
    if (source.ownershipDisposition === 'historical_only' && !/^[0-9a-f]{64}$/.test(source.historicalOwnershipEvidenceHash ?? '')) problems.push('historical_ownership_evidence_missing')
    if (source.symbols?.status !== 'converted' || !Array.isArray(source.symbols.symbols) || !source.symbols.symbols.length) problems.push('symbol_conversion_required')
    if (source.schedule?.status !== 'converted') problems.push('schedule_conversion_required')
    const symbolRows = source.symbols?.status === 'converted' ? source.symbols.symbols.map(symbol => ({
      sourceSubscriptionId: source.sourceId, standardSymbol: symbol, targetAccountId: source.targetAccountId,
      analysisStrategyId: mapping?.analysis?.strategyId ?? null, analysisVersionId: mapping?.analysis?.versionId ?? null,
      traderStrategyId: mapping?.trader?.strategyId ?? null, traderVersionId: mapping?.trader?.versionId ?? null,
      historicalOnly: source.ownershipDisposition === 'historical_only', sourceDeleted: source.legacyDeleted,
      sourceExecutionEnabled: source.legacyExecutionEnabled,
    })) : []
    return { sourceId: source.sourceId, sourceHash: source.sourceHash, strategySourceId: source.strategySourceId,
      ownershipDisposition: source.ownershipDisposition, historicalOwnershipEvidenceHash: source.historicalOwnershipEvidenceHash,
      symbolRows, problems }
  })
  return { kind: 'strategy-subscription-lineage-plan/v1', sourceInputHash: inventory.inputHash,
    accountMappingHash: inventory.accountMappingHash, strategyRows, subscriptionRows,
    mappingComplete: strategyRows.every(row => !row.problems.length) && subscriptionRows.every(row => !row.problems.length),
    executable: false, remainingChecks: ['prompt_and_config_role_conversion', 'target_foreign_keys_and_history',
      'risk_memory_execution_preferences', 'restored_backfill_reconciliation', 'namespace_promotion'],
    planHash: hash({ strategyRows, subscriptionRows, inputHash: inventory.inputHash, mappings: roleMappings }) }
}
