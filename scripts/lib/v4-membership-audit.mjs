import { canonical, exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectMembershipSources } from './v4-membership-source.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const membershipAuditFields = Object.freeze(['user_id', 'plan_code', 'billing_period_code', 'source_code', 'expiration_kind',
  'expires_at_utc', 'current_state_observed_at_utc', 'revision', 'origin', 'migration_run_id', 'source_sha256', 'imported_at_utc'])

// Does not import a target converter or writer. The caller supplies actual SQL
// rows, source archives and an independently reviewed evidence-file catalog.
export function auditMembershipImport(sources, actual, archives, { run, basis, evidenceCatalog }) {
  const source = inspectMembershipSources(sources, [], [])
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'membership_audit_run')
  const registered = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'resolutions'])
  check(basis.version === 'membership-current-state/v1' && basis.sourceHash === source.sourceHash
    && basis.sourceSnapshotId === run.sourceSnapshotId && Array.isArray(basis.resolutions)
    && basis.resolutions.length === sources.length && evidenceCatalog instanceof Map, 'membership_audit_basis')
  const resolutions = new Map()
  for (const resolution of basis.resolutions) {
    exactKeys(resolution, ['sourceId', 'sourceHash', 'rawExpiry', 'expirationKind', 'offsetMinutes', 'evidenceId', 'evidenceSha256'])
    check(!resolutions.has(resolution.sourceId), 'membership_audit_duplicate_resolution')
    resolutions.set(resolution.sourceId, resolution)
  }
  check(Array.isArray(actual) && Array.isArray(archives), 'membership_audit_rows')
  const targets = new Map(), savedArchives = new Map(), differences = []
  const add = (sourceId, field, code) => differences.push({ sourceId, field, code })
  for (const row of actual) {
    exactKeys(row, membershipAuditFields)
    check(typeof row.user_id === 'string' && !targets.has(row.user_id), 'membership_audit_duplicate_target')
    targets.set(row.user_id, row)
  }
  for (const row of archives) {
    check(typeof row.sourceId === 'string' && !savedArchives.has(row.sourceId), 'membership_audit_duplicate_archive')
    savedArchives.set(row.sourceId, row)
  }
  for (const entry of source.entries) {
    const id = entry.sourceId, original = entry.source, resolution = resolutions.get(id)
    check(resolution?.sourceHash === entry.sourceHash && resolution.rawExpiry === original.plan_expires_at, 'membership_audit_resolution_binding')
    check(typeof resolution.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(resolution.evidenceId)
      && typeof resolution.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(resolution.evidenceSha256)
      && evidenceCatalog.get(resolution.evidenceId) === resolution.evidenceSha256, 'membership_audit_evidence')
    let expectedExpiry = null
    if (original.plan_expires_at === null) check(resolution.expirationKind === 'no_expiry' && resolution.offsetMinutes === null, 'membership_audit_null_rule')
    else {
      check(resolution.expirationKind === 'at_time' && Number.isInteger(resolution.offsetMinutes)
        && Math.abs(resolution.offsetMinutes) <= 840, 'membership_audit_offset')
      const wall = inspectWallClock(original.plan_expires_at).canonicalWallClock
      const date = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - resolution.offsetMinutes * 60000)
      check(date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999, 'membership_audit_expiry_range')
      expectedExpiry = date.toISOString().replace('T', ' ').slice(0, -1)
    }
    const row = targets.get(id)
    if (!row) add(id, 'target', 'missing')
    else {
      const expected = { user_id: id, plan_code: original.plan, billing_period_code: original.plan_period, source_code: original.plan_source,
        expiration_kind: original.plan_expires_at === null ? 'no_expiry' : 'at_time', expires_at_utc: expectedExpiry,
        current_state_observed_at_utc: registered, revision: '1', origin: 'legacy_import', migration_run_id: run.id,
        source_sha256: entry.sourceHash, imported_at_utc: registered }
      for (const field of membershipAuditFields) {
        const value = ['expires_at_utc', 'current_state_observed_at_utc', 'imported_at_utc'].includes(field)
          ? inspectWallClock(row[field]).canonicalWallClock : row[field]
        if (value !== expected[field]) add(id, field, 'value_mismatch')
      }
      if (!['free', 'plus', 'pro'].includes(row.plan_code)) add(id, 'plan_code', 'unknown_plan')
    }
    targets.delete(id)
    const archive = savedArchives.get(id)
    if (!archive) add(id, 'archive', 'missing')
    else {
      if (archive.runId !== run.id || archive.sourcePkHash !== hash([{ type: 'integer', value: id }])
        || archive.sourceHash !== entry.sourceHash) add(id, 'archive', 'identity_mismatch')
      const expected = { version: 1, sourceTable: 'users', projection: 'membership-source/v1', source: original,
        sourceSnapshotId: run.sourceSnapshotId, registeredAtUtc: run.registeredAtUtc, basisHash: hash(basis), resolution }
      if (canonical(archive.payload) !== canonical(expected)) add(id, 'archive', 'payload_mismatch')
    }
    savedArchives.delete(id)
  }
  for (const id of targets.keys()) add(id, 'target', 'unexpected')
  for (const id of savedArchives.keys()) add(id, 'archive', 'unexpected')
  return { version: 'membership-import-audit/v1', sourceRows: sources.length, targetRows: actual.length, archiveRows: archives.length,
    importMatchesReviewedInputs: differences.length === 0, differences, checkedTargetFields: membershipAuditFields,
    evidenceCatalogExternallyRequired: true, businessCutoverVerified: false, deletionAuthorized: false, fullMembershipConverted: false }
}
