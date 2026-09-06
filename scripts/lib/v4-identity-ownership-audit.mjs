import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { representIdentityValue } from './v4-identity-values.mjs'

const positiveId = value => {
  representIdentityValue(value, 'bigint unsigned', false)
  check(BigInt(value) > 0n, 'identity_graph_id_invalid')
}
const identityKey = row => {
  check(typeof row.server === 'string' && row.server.length > 0 && row.server.length <= 100 && typeof row.login === 'string' && row.login.length > 0 && row.login.length <= 50, 'identity_graph_account_invalid')
  // Deliberately exact: historical UPPER/TRIM joins are not entity-merge evidence.
  return hash([row.server, row.login])
}

export function auditOwnershipGraph(input) {
  exactKeys(input, ['users', 'accounts', 'intervals', 'bindings'])
  for (const list of Object.values(input)) check(Array.isArray(list) && list.length <= 10000, 'identity_graph_budget_invalid')
  const issues = [], users = new Set(), accounts = new Map(), intervals = new Map(), open = new Map(), bindings = new Set(), identities = new Set()
  const add = (code, kind, id) => issues.push({ code, kind, locatorHash: hash(id) })
  for (const id of input.users) {
    positiveId(id)
    if (users.has(id)) add('duplicate_user', 'user', id)
    users.add(id)
  }
  for (const row of input.accounts) {
    exactKeys(row, ['id', 'userId', 'server', 'login']); positiveId(row.id); positiveId(row.userId)
    const key = identityKey(row)
    if (accounts.has(row.id)) add('duplicate_account_id', 'account', row.id)
    else accounts.set(row.id, row)
    if (!users.has(row.userId)) add('account_user_missing', 'account', row.id)
    if (identities.has(key)) add('account_identity_merge_unresolved', 'account', row.id)
    identities.add(key)
  }
  for (const row of input.intervals) {
    exactKeys(row, ['id', 'userId', 'accountId', 'server', 'login', 'startedAt', 'endedAt'])
    positiveId(row.id); positiveId(row.userId); positiveId(row.accountId)
    const key = identityKey(row)
    if (intervals.has(row.id)) add('duplicate_interval_id', 'interval', row.id)
    intervals.set(row.id, row)
    if (!users.has(row.userId)) add('interval_user_missing', 'interval', row.id)
    const account = accounts.get(row.accountId)
    if (!account) add('interval_account_missing', 'interval', row.id)
    else if (identityKey(account) !== key) add('interval_identity_unresolved', 'interval', row.id)
    try {
      check(row.startedAt !== null, 'identity_time_invalid')
      inspectWallClock(row.startedAt); inspectWallClock(row.endedAt)
    } catch { add('interval_time_invalid', 'interval', row.id) }
    if (row.endedAt === null) {
      const entries = open.get(key) ?? []
      entries.push(row); open.set(key, entries)
      if (entries.length > 1) add('multiple_open_owners', 'interval', row.id)
    }
    // Historical users are not replaced with the account's current settings user.
  }
  for (const row of input.bindings) {
    exactKeys(row, ['server', 'login', 'userId', 'accountId'])
    positiveId(row.userId); positiveId(row.accountId)
    const key = identityKey(row)
    if (bindings.has(key)) add('duplicate_binding', 'binding', key)
    bindings.add(key)
    if (!users.has(row.userId)) add('binding_user_missing', 'binding', key)
    const account = accounts.get(row.accountId)
    if (!account) add('binding_account_missing', 'binding', key)
    else {
      if (identityKey(account) !== key) add('binding_identity_unresolved', 'binding', key)
      if (account.userId !== row.userId) add('binding_settings_user_disagrees', 'binding', key)
    }
    const matches = open.get(key) ?? []
    if (matches.length !== 1 || matches[0].userId !== row.userId || matches[0].accountId !== row.accountId) add('binding_open_interval_disagrees', 'binding', key)
  }
  for (const [key, rows] of open) if (!bindings.has(key)) for (const row of rows) add('open_interval_binding_missing', 'interval', row.id)
  return { counts: { users: input.users.length, accounts: input.accounts.length, intervals: input.intervals.length, bindings: input.bindings.length },
    issues, exactRelationsConsistent: issues.length === 0,
    temporalOrderVerified: false, completeSourceVerified: false, readyForBackfill: false,
    blockers: ['historical_time_basis_unverified', 'complete_source_coverage_unverified', 'identity_merge_and_target_maps_unverified'] }
}
