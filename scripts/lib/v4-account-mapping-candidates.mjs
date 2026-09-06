import { exactKeys, hash, hashPattern, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue } from './v4-identity-values.mjs'

function id(value) {
  representIdentityValue(value, 'int', false)
  check(BigInt(value) > 0n, 'account_candidate_id_invalid')
}
function identity(row) {
  check(typeof row.server === 'string' && row.server.length >= 1 && row.server.length <= 191 && typeof row.login === 'string' && row.login.length >= 1 && row.login.length <= 64, 'account_candidate_identity_invalid')
  check(/^[\x20-\x7e]+$/.test(row.server) && row.server.trim() === row.server && /^[\x21-\x7e]+$/.test(row.login), 'account_candidate_identity_requires_review')
  return hash([row.server.toUpperCase(), row.login])
}
const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0

export function proposeAccountMappings(logicalSourceId, input) {
  check(typeof logicalSourceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(logicalSourceId), 'account_candidate_source_invalid')
  exactKeys(input, ['accounts', 'terminals', 'bindings'])
  for (const rows of Object.values(input)) check(Array.isArray(rows) && rows.length <= 10000, 'account_candidate_budget_invalid')
  const terminalGroups = new Map(), bindingGroups = new Map(), accounts = new Map(), terminalIds = new Set(), bindingIds = new Set()
  const requireHash = row => check(typeof row.sourceHash === 'string' && hashPattern.test(row.sourceHash), 'account_candidate_hash_invalid')
  for (const row of input.accounts) {
    exactKeys(row, ['id', 'userId', 'server', 'login', 'sourceHash']); id(row.id); id(row.userId); requireHash(row); identity(row)
    check(!accounts.has(row.id), 'account_candidate_account_duplicate'); accounts.set(row.id, row)
  }
  for (const row of input.terminals) {
    exactKeys(row, ['id', 'userId', 'platform', 'server', 'login', 'sourceHash']); id(row.userId); requireHash(row)
    check(typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 128 && !terminalIds.has(row.id), 'account_candidate_terminal_duplicate_or_invalid')
    terminalIds.add(row.id)
    check(typeof row.platform === 'string' && row.platform.length <= 8, 'account_candidate_platform_invalid')
    const key = hash([row.userId, identity(row)])
    const group = terminalGroups.get(key) ?? []; group.push(row); terminalGroups.set(key, group)
  }
  for (const row of input.bindings) {
    exactKeys(row, ['server', 'login', 'currentUserId', 'currentAccountId', 'currency', 'sourceHash'])
    id(row.currentUserId); id(row.currentAccountId); requireHash(row)
    const key = identity(row)
    // Case variants can be separate original rows; keep both as an ambiguity.
    const rawKey = hash([row.server, row.login])
    check(!bindingIds.has(rawKey), 'account_candidate_binding_duplicate'); bindingIds.add(rawKey)
    const group = bindingGroups.get(key) ?? []; group.push(row); bindingGroups.set(key, group)
  }
  const candidates = input.accounts.map(row => {
    const key = identity(row), issues = []
    const terminals = terminalGroups.get(hash([row.userId, key])) ?? []
    const platforms = [...new Set(terminals.map(t => t.platform))]
    if (!platforms.length) issues.push('platform_evidence_missing')
    else if (platforms.length !== 1 || !['mt4', 'mt5'].includes(platforms[0])) issues.push('platform_evidence_ambiguous')
    const platform = platforms.length === 1 && ['mt4', 'mt5'].includes(platforms[0]) ? platforms[0] : null
    const bindings = bindingGroups.get(key) ?? []
    let currency = null
    if (bindings.length !== 1) issues.push(bindings.length ? 'currency_binding_ambiguous' : 'currency_binding_missing')
    else {
      const binding = bindings[0]
      const linked = accounts.get(binding.currentAccountId)
      if (!linked || linked.userId !== binding.currentUserId || identity(linked) !== key) issues.push('currency_binding_reference_invalid')
      else if (typeof binding.currency !== 'string' || !/^[\x21-\x7e]{1,12}$/.test(binding.currency)) issues.push('currency_unrepresentable')
      else currency = binding.currency
    }
    return { sourceAccountId: row.id, settingsUserId: row.userId, sourceHash: row.sourceHash,
      candidateKey: platform ? hash({ logicalSourceId, entity: 'trading_account', platform, server: row.server.toUpperCase(), login: row.login }) : null,
      platform, currency, terminalEvidenceHashes: terminals.map(t => t.sourceHash).sort(sort), bindingEvidenceHashes: bindings.map(b => b.sourceHash).sort(sort),
      issues, readyForBackfill: false }
  }).sort((a, b) => sort(a.sourceAccountId, b.sourceAccountId))
  const groups = new Map()
  for (const candidate of candidates) if (candidate.candidateKey) {
    const group = groups.get(candidate.candidateKey) ?? []; group.push(candidate); groups.set(candidate.candidateKey, group)
  }
  return { logicalSourceId, candidates, groups: [...groups.entries()].sort(([a], [b]) => sort(a, b)).map(([candidateKey, members]) => ({
    candidateKey, sourceAccountIds: members.map(m => m.sourceAccountId), settingsUserIds: members.map(m => m.settingsUserId),
    mergeReviewRequired: members.length > 1,
    settingsConflict: new Set(members.map(m => m.settingsUserId)).size !== members.length,
  })), blockers: ['historical_platform_and_currency_coverage_unverified', 'identity_merge_not_approved', 'ownership_time_and_target_id_maps_pending', 'complete_source_unverified'], readyForBackfill: false }
}
