import { hash } from './v4-backfill-contract.mjs'
import { convertSubscriptionSymbols } from './v4-subscription-symbol-conversion.mjs'

// Candidate keys use source strategy identity until analysis/trader version
// mapping is proven. This checks collisions, never grants runtime permission.
export function reviewSubscriptionAccountScopes({ subscriptions, strategies, accounts, accountPlan }) {
  const sourceAccounts = new Map(accounts.map(row => [row.id, row]))
  const sourceStrategies = new Map(strategies.map(row => [row.id, row]))
  const settings = new Map(accountPlan.settings.map(row => [row.sourceAccountId, row]))
  if (sourceAccounts.size !== accounts.length || sourceStrategies.size !== strategies.length || settings.size !== accounts.length
    || [...sourceAccounts.keys()].some(id => !settings.has(id)) || new Set(subscriptions.map(row => row.id)).size !== subscriptions.length) throw new Error('subscription_scope_source_invalid')
  const candidates = [], issues = [], identities = new Map(), slots = new Map()
  const issue = (id, code) => issues.push({ locatorHash: hash(id), code })
  for (const row of subscriptions) {
    const source = sourceAccounts.get(row.trading_account_id), mapping = settings.get(row.trading_account_id), strategy = sourceStrategies.get(row.strategy_id)
    if (!source || !mapping || !strategy) { issue(row.id, 'subscription_scope_parent_missing'); continue }
    if (source.userId !== row.user_id || mapping.userId !== row.user_id) { issue(row.id, 'subscription_scope_user_mismatch'); continue }
    if (!/^[1-9][0-9]*$/.test(mapping.targetAccountId)) throw new Error('subscription_scope_target_invalid')
    if (![row.execution_enabled, row.is_deleted].every(value => value === '0' || value === '1')) { issue(row.id, 'subscription_scope_flag_invalid'); continue }
    const symbols = convertSubscriptionSymbols(row.symbols_json, strategy.symbols_json)
    if (symbols.status !== 'converted') { issue(row.id, 'subscription_scope_symbols_unresolved'); continue }
    for (const symbol of symbols.symbols) {
      const identityKey = hash([row.user_id, mapping.targetAccountId, row.strategy_id, symbol])
      const slotKey = hash([mapping.targetAccountId, symbol])
      const candidate = { sourceLocatorHash: hash(row.id), sourceHash: hash(row), accountMappingHash: accountPlan.mappingHash,
        identityKey, executionSlotKey: slotKey, symbol, selectionMode: symbols.selectionMode,
        legacyExecutionEnabled: row.execution_enabled === '1', legacyDeleted: row.is_deleted === '1',
        runtimePermissionGranted: false }
      candidates.push(candidate)
      if (identities.has(identityKey)) issue(row.id, 'subscription_identity_collision')
      else identities.set(identityKey, candidate)
      if (candidate.legacyExecutionEnabled && !candidate.legacyDeleted) {
        if (slots.has(slotKey)) issue(row.id, 'subscription_execution_slot_collision')
        else slots.set(slotKey, candidate)
      }
    }
  }
  return { kind: 'subscription_account_scope_review', accountMappingHash: accountPlan.mappingHash,
    counts: { sourceSubscriptions: subscriptions.length, sourceAccounts: accounts.length, targetAccounts: accountPlan.entities.length,
      candidateRows: candidates.length, potentialExecutionSlots: slots.size }, candidates, issues,
    structuralCandidatesConsistent: issues.length === 0, executable: false, runtimePermissionGranted: false,
    remainingChecks: ['strategy_role_and_version_mapping', 'current_and_historical_ownership', 'schedule_risk_memory_conversion', 'historical_time_basis', 'business_backfill_reconciliation'] }
}
