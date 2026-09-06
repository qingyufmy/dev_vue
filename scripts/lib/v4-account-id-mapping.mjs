import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { proposeAccountMappings } from './v4-account-mapping-candidates.mjs'

const numeric = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0

// Plan once against the complete frozen account set, then persist these ID maps in
// the migration ledger. Never allocate IDs independently inside page-sized batches.
export function planAccountIdMappings(logicalSourceId, input, expectedSourceIds) {
  const candidates = proposeAccountMappings(logicalSourceId, input)
  const sourceIds = input.accounts.map(account => account.id).sort(numeric)
  check(Array.isArray(expectedSourceIds) && new Set(expectedSourceIds).size === expectedSourceIds.length
    && JSON.stringify(sourceIds) === JSON.stringify([...expectedSourceIds].sort(numeric)), 'account_mapping_source_incomplete')
  check(candidates.candidates.every(candidate => candidate.issues.length === 0 && candidate.candidateKey !== null), 'account_mapping_evidence_unresolved')
  check(candidates.groups.every(group => !group.settingsConflict), 'account_mapping_settings_collision')
  const accounts = new Map(input.accounts.map(account => [account.id, account]))
  for (const binding of input.bindings) {
    const account = accounts.get(binding.currentAccountId)
    check(account && account.userId === binding.currentUserId && account.server.toUpperCase() === binding.server.toUpperCase()
      && account.login === binding.login, 'account_mapping_orphan_binding')
  }
  const evidence = new Map(candidates.candidates.map(candidate => [candidate.sourceAccountId, candidate]))
  const entities = [], mappings = [], settings = [], ownershipMap = new Map(), occupied = new Set()
  for (const group of candidates.groups) {
    const members = [...group.sourceAccountIds].sort(numeric)
    const representative = accounts.get(members[0])
    const targetAccountId = members[0]
    check(!occupied.has(targetAccountId), 'account_mapping_target_collision'); occupied.add(targetAccountId)
    const facts = evidence.get(members[0])
    check(members.every(id => evidence.get(id).platform === facts.platform && evidence.get(id).currency === facts.currency), 'account_mapping_public_facts_conflict')
    const entity = { candidateKey: group.candidateKey, targetAccountId, platform: facts.platform,
      brokerServer: representative.server, brokerServerKey: representative.server.toUpperCase(), accountLogin: representative.login,
      currency: facts.currency, sourceAccountIds: members }
    entities.push(entity)
    for (const id of members) {
      const source = accounts.get(id)
      mappings.push({ entityKind: 'trading_account', sourceTable: 'trading_accounts', sourcePk: [{ type: 'integer', value: id }],
        target: { table: 'trading_accounts', pk: [{ type: 'integer', value: targetAccountId }] } })
      settings.push({ sourceAccountId: id, userId: source.userId, targetAccountId })
      ownershipMap.set(id, { targetAccountId, brokerServerKey: entity.brokerServerKey, accountLogin: entity.accountLogin })
    }
  }
  entities.sort((a, b) => numeric(a.targetAccountId, b.targetAccountId))
  mappings.sort((a, b) => numeric(a.sourcePk[0].value, b.sourcePk[0].value))
  settings.sort((a, b) => numeric(a.sourceAccountId, b.sourceAccountId))
  const sourceFingerprint = hash({ accounts: [...input.accounts].sort((a, b) => numeric(a.id, b.id)),
    terminals: [...input.terminals].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    bindings: [...input.bindings].sort((a, b) => hash(a).localeCompare(hash(b))) })
  return { version: 'account-id-map-v1', logicalSourceId, sourceFingerprint, entities, mappings, settings, ownershipMap,
    mappingHash: hash({ entities, mappings, settings }), persisted: false, readyForBusinessWrite: false,
    remainingChecks: ['historical_platform_currency_coverage', 'utc_business_fields', 'target_id_reservation', 'business_write_and_reconciliation'] }
}
