import { hash, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { representIdentityValue } from './v4-identity-values.mjs'

const sourceFields = ['id', 'broker_server_key', 'login_account', 'user_id', 'trading_account_id', 'started_at', 'ended_at', 'end_reason', 'created_at', 'updated_at']
const positive = (value, type) => {
  representIdentityValue(value, type, false)
  check(BigInt(value) > 0n, 'ownership_positive_id_required')
}

export function resolveOwnershipTime(raw, basis, nullable = false) {
  check(basis && basis.sourceTable === 'mt5_account_ownership_history' && Number.isInteger(basis.offsetMinutes)
    && basis.offsetMinutes >= -840 && basis.offsetMinutes <= 840 && typeof basis.evidenceId === 'string'
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(basis.evidenceId), 'ownership_time_basis_required')
  if (raw === null) { check(nullable, 'ownership_required_time_missing'); return null }
  const inspected = inspectWallClock(raw)
  const milliseconds = Date.parse(inspected.canonicalWallClock.replace(' ', 'T') + 'Z') - basis.offsetMinutes * 60000
  const utc = new Date(milliseconds).toISOString()
  check(/^\d{4}-/.test(utc) && utc.slice(0, 4) >= '1000' && utc.slice(0, 4) <= '9999', 'ownership_time_out_of_range')
  return utc.replace('T', ' ').replace('Z', '')
}

function intervalId(logicalSourceId, sourceId) {
  const value = hash({ logicalSourceId, entity: 'ownership_interval', sourceId })
  // Deterministic UUID-shaped key; version 8 identifies application-defined generation.
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-8${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`
}

// No SQL or authority activation. The caller supplies an independently verified account ID map
// and historical time basis. Every source interval produces exactly one target interval.
export function convertOwnershipRows(rows, { logicalSourceId, accountMap, userIds, timeBasis }) {
  check(/^[A-Za-z0-9_.:-]{1,64}$/.test(logicalSourceId) && Array.isArray(rows) && rows.length <= 100000,
    'ownership_conversion_scope_invalid')
  check(accountMap instanceof Map && userIds instanceof Set, 'ownership_conversion_maps_required')
  const mappedIdentities = new Map()
  for (const account of accountMap.values()) {
    const identity = hash([account.brokerServerKey, account.accountLogin])
    check(!mappedIdentities.has(account.targetAccountId) || mappedIdentities.get(account.targetAccountId) === identity,
      'ownership_target_identity_collision')
    mappedIdentities.set(account.targetAccountId, identity)
  }
  const seen = new Set(), targetIds = new Set(), entries = [], groups = new Map()
  for (const row of rows) {
    exactKeys(row, sourceFields)
    positive(row.id, 'bigint'); positive(row.user_id, 'int'); positive(row.trading_account_id, 'int')
    check(typeof row.broker_server_key === 'string' && row.broker_server_key.length > 0 && [...row.broker_server_key].length <= 100
      && typeof row.login_account === 'string' && row.login_account.length > 0 && [...row.login_account].length <= 50, 'ownership_source_identity_invalid')
    check(!seen.has(row.id), 'ownership_duplicate_source_interval'); seen.add(row.id)
    check(userIds.has(row.user_id), 'ownership_source_user_missing')
    const account = accountMap.get(row.trading_account_id)
    check(account && account.brokerServerKey === row.broker_server_key && account.accountLogin === row.login_account,
      'ownership_account_mapping_mismatch')
    positive(account.targetAccountId, 'bigint unsigned')
    check(row.end_reason === null || (typeof row.end_reason === 'string' && [...row.end_reason].length <= 64), 'ownership_end_reason_invalid')
    const target = { id: intervalId(logicalSourceId, row.id), user_id: row.user_id, trading_account_id: account.targetAccountId,
      role: 'owner', started_at_utc: resolveOwnershipTime(row.started_at, timeBasis),
      ended_at_utc: resolveOwnershipTime(row.ended_at, timeBasis, true), end_reason: row.end_reason,
      origin_kind: 'legacy', origin_ref: `${logicalSourceId}:mt5_account_ownership_history:${row.id}`,
      created_at_utc: resolveOwnershipTime(row.created_at, timeBasis), updated_at_utc: resolveOwnershipTime(row.updated_at, timeBasis) }
    check(!targetIds.has(target.id), 'ownership_target_id_collision'); targetIds.add(target.id)
    check(target.ended_at_utc === null || target.ended_at_utc >= target.started_at_utc, 'ownership_interval_reversed')
    check(target.ended_at_utc !== null || target.end_reason === null, 'ownership_open_interval_has_end_reason')
    const entry = { sourceId: row.id, sourceHash: hash(row), targetHash: hash(target), target,
      provenance: { sourceTable: 'mt5_account_ownership_history', timeBasisHash: hash(timeBasis), rawTimes: {
        started_at: row.started_at, ended_at: row.ended_at, created_at: row.created_at, updated_at: row.updated_at } } }
    entries.push(entry)
    const group = groups.get(target.trading_account_id) ?? []
    group.push(entry); groups.set(target.trading_account_id, group)
  }
  const compare = (a, b) => a.target.started_at_utc.localeCompare(b.target.started_at_utc)
    || (BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : BigInt(a.sourceId) > BigInt(b.sourceId) ? 1 : 0)
  for (const group of groups.values()) {
    let previous = null
    for (const entry of group.sort(compare)) {
      const value = entry.target
      // A closed zero-length interval is evidence, but occupies no time in [start,end).
      if (value.ended_at_utc === value.started_at_utc) continue
      check(previous === null || (previous.ended_at_utc !== null && previous.ended_at_utc <= value.started_at_utc), 'ownership_interval_overlap')
      previous = value
    }
    check(group.filter(entry => entry.target.ended_at_utc === null).length <= 1, 'ownership_multiple_open_intervals')
  }
  const byUserAccount = new Map()
  for (const entry of [...entries].sort(compare)) {
    const key = `${entry.target.user_id}:${entry.target.trading_account_id}`
    const previous = byUserAccount.get(key)
    if (!previous || previous.target.ended_at_utc !== null) byUserAccount.set(key, entry)
  }
  const grants = [...byUserAccount.values()].map(({ target }) => ({ user_id: target.user_id,
    trading_account_id: target.trading_account_id, role: 'owner', granted_at_utc: target.started_at_utc,
    revoked_at_utc: target.ended_at_utc, interval_id: target.id, revision: '1' }))
  entries.sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
  grants.sort((a, b) => a.trading_account_id.localeCompare(b.trading_account_id) || a.user_id.localeCompare(b.user_id))
  return { transformVersion: 'ownership-intervals-v1', entries, grants, sourceCount: rows.length,
    intervalCount: entries.length, openCount: entries.filter(entry => entry.target.ended_at_utc === null).length,
    transformationHash: hash({ entries, grants }), writesPerformed: false }
}
