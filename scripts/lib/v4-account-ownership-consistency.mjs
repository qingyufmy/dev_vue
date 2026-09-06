import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'

// This verifies identity and open-interval agreement, not historical UTC or trading permissions.
export function reviewAccountOwnership({ accounts, bindings, intervals, accountMap, userIds }) {
  check(Array.isArray(accounts) && Array.isArray(bindings) && Array.isArray(intervals)
    && accountMap instanceof Map && userIds instanceof Set, 'ownership_consistency_input_invalid')
  const issues = [], notes = [], sourceAccounts = new Map(), sourceIntervals = new Set(), openByTarget = new Map(), bindingsByTarget = new Map(), userAccounts = new Set()
  const issue = (code, locator) => issues.push({ code, locatorHash: hash(locator) })
  for (const account of accounts) {
    if (sourceAccounts.has(account.id)) issue('duplicate_source_account', account.id)
    sourceAccounts.set(account.id, account)
  }
  for (const interval of intervals) {
    if (sourceIntervals.has(interval.id)) issue('duplicate_source_interval', interval.id)
    sourceIntervals.add(interval.id)
    if (!userIds.has(interval.user_id)) issue('historical_user_missing', interval.id)
    const mapped = accountMap.get(interval.trading_account_id)
    if (!sourceAccounts.has(interval.trading_account_id) || !mapped || mapped.brokerServerKey !== interval.broker_server_key
      || mapped.accountLogin !== interval.login_account) { issue('historical_account_identity_mismatch', interval.id); continue }
    userAccounts.add(hash([interval.user_id, mapped.targetAccountId]))
    if (interval.ended_at !== null) continue
    if (interval.end_reason !== null) issue('open_interval_has_end_reason', interval.id)
    const group = openByTarget.get(mapped.targetAccountId) ?? []
    group.push(interval); openByTarget.set(mapped.targetAccountId, group)
  }
  for (const binding of bindings) {
    const account = sourceAccounts.get(binding.currentAccountId), mapped = accountMap.get(binding.currentAccountId)
    const locator = [binding.server, binding.login]
    if (!account || !mapped || account.user_id !== binding.currentUserId || !userIds.has(binding.currentUserId)
      || mapped.brokerServerKey !== binding.server.toUpperCase() || mapped.accountLogin !== binding.login) {
      issue('current_binding_identity_mismatch', locator); continue
    }
    const group = bindingsByTarget.get(mapped.targetAccountId) ?? []
    group.push(binding); bindingsByTarget.set(mapped.targetAccountId, group)
    if (account.is_deleted !== '0') issue('current_binding_deleted_account', locator)
    if (account.observe_status === 'switched') notes.push({ code: 'legacy_single_account_switched', locatorHash: hash(locator) })
    else if (account.observe_status !== 'active') issue('current_binding_account_not_active', locator)
  }
  const targets = new Set([...openByTarget.keys(), ...bindingsByTarget.keys()])
  for (const target of targets) {
    const opens = openByTarget.get(target) ?? [], current = bindingsByTarget.get(target) ?? []
    if (opens.length !== 1) issue(opens.length ? 'multiple_open_owners' : 'binding_without_open_interval', target)
    if (current.length !== 1) issue(current.length ? 'multiple_current_bindings' : 'open_interval_without_binding', target)
    if (opens.length === 1 && current.length === 1
      && (opens[0].user_id !== current[0].currentUserId || opens[0].trading_account_id !== current[0].currentAccountId)) {
      issue('open_owner_binding_disagreement', target)
    }
  }
  issues.sort((a, b) => a.code.localeCompare(b.code) || a.locatorHash.localeCompare(b.locatorHash))
  notes.sort((a, b) => a.code.localeCompare(b.code) || a.locatorHash.localeCompare(b.locatorHash))
  const stable = values => [...values].map(value => hash({ ...value })).sort()
  return { version: 'account-open-ownership-v1', counts: { sourceAccounts: accounts.length, historicalIntervals: intervals.length,
    currentBindings: bindings.length, openIntervals: intervals.filter(row => row.ended_at === null).length,
    historicalUserAccountPairs: userAccounts.size, targetsWithCurrentFacts: targets.size }, issues, notes,
    evidenceHash: hash({ accounts: stable(accounts), bindings: stable(bindings), intervals: stable(intervals),
      accountMap: [...accountMap].sort(([a], [b]) => a.localeCompare(b)), userIds: [...userIds].sort() }),
    currentOwnershipConsistent: issues.length === 0, historicalTimeBasisConfirmed: false, tradingPermissionsVerified: false }
}
