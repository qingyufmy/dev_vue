import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectMembershipSources } from './v4-membership-source.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export function prepareMembershipRows(users, { run, basis, evidenceCatalog }) {
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'membership_run_invalid')
  const registered = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  const source = inspectMembershipSources(users, [], [])
  check(source.blockers.every(b => ['expiry_time_basis_required', 'updated_time_basis_required', 'unbounded_membership_policy_required'].includes(b.code)), 'membership_source_blocked')
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'resolutions'])
  check(basis.version === 'membership-current-state/v1' && basis.sourceHash === source.sourceHash
    && basis.sourceSnapshotId === run.sourceSnapshotId && Array.isArray(basis.resolutions)
    && basis.resolutions.length === users.length && evidenceCatalog instanceof Map, 'membership_basis_scope')
  const resolutions = new Map()
  for (const resolution of basis.resolutions) {
    exactKeys(resolution, ['sourceId', 'sourceHash', 'rawExpiry', 'expirationKind', 'offsetMinutes', 'evidenceId', 'evidenceSha256'])
    check(!resolutions.has(resolution.sourceId), 'membership_basis_duplicate')
    resolutions.set(resolution.sourceId, resolution)
  }
  const entries = source.entries.map(entry => {
    const row = entry.source, resolution = resolutions.get(entry.sourceId)
    check(resolution && resolution.sourceHash === entry.sourceHash && resolution.rawExpiry === row.plan_expires_at, 'membership_basis_binding')
    check(typeof resolution.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(resolution.evidenceId)
      && typeof resolution.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(resolution.evidenceSha256)
      && evidenceCatalog.get(resolution.evidenceId) === resolution.evidenceSha256, 'membership_basis_evidence')
    let expiry = null
    if (row.plan_expires_at === null) {
      check(resolution.expirationKind === 'no_expiry' && resolution.offsetMinutes === null, 'membership_null_expiry_rule')
    } else {
      check(resolution.expirationKind === 'at_time' && Number.isInteger(resolution.offsetMinutes)
        && Math.abs(resolution.offsetMinutes) <= 840, 'membership_expiry_rule')
      const wall = inspectWallClock(row.plan_expires_at).canonicalWallClock
      const utc = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - resolution.offsetMinutes * 60000).toISOString()
      check(/^\d{4}-/.test(utc) && utc.slice(0, 4) >= '1000' && utc.slice(0, 4) <= '9999', 'membership_expiry_range')
      expiry = utc.replace('T', ' ').replace('Z', '')
    }
    const target = { user_id: row.id, plan_code: row.plan, billing_period_code: row.plan_period, source_code: row.plan_source,
      expiration_kind: resolution.expirationKind, expires_at_utc: expiry, current_state_observed_at_utc: registered,
      revision: '1', origin: 'legacy_import', migration_run_id: run.id, source_sha256: entry.sourceHash, imported_at_utc: registered }
    return { sourceId: entry.sourceId, sourceHash: entry.sourceHash, target, targetHash: hash(target),
      provenance: { source: row, basisHash: hash(basis), resolution: { ...resolution } } }
  })
  return { version: 'membership-rows/v1', sourceHash: source.sourceHash, entries, transformHash: hash(entries),
    createsHistoricalActivations: false, grantsEntitlements: false, businessWritesEnabled: false,
    unresolvedDependencies: ['membership_runtime_cutover', 'historical_events_and_capacity_grants'], fullMembershipConverted: false }
}
