import { canonical, exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWalletAddressSources } from './v4-wallet-address-source.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const walletAuditFields = Object.freeze(['id', 'chain', 'address_index', 'address', 'created_at_utc',
  'custody_reference', 'custody_evidence_sha256', 'custody_verified_at_utc', 'revision', 'origin', 'migration_run_id', 'source_sha256', 'imported_at_utc'])

// Does not import a target converter or writer. The caller supplies actual SQL
// rows, source archives and an independently reviewed evidence-file catalog.
export function auditWalletImport(sources, actual, archives, { run, basis, evidenceCatalog }) {
  const source = inspectWalletAddressSources(sources)
  check(source.blockers.every(b => ['wallet_created_time_basis_required', 'wallet_custody_binding_unverified'].includes(b.code)), 'wallet_audit_source_blocked')
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'wallet_audit_run')
  const registered = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'resolutions'])
  check(basis.version === 'wallet-address-time/v1' && basis.sourceHash === source.sourceHash
    && basis.sourceSnapshotId === run.sourceSnapshotId && Array.isArray(basis.resolutions)
    && basis.resolutions.length === sources.length && evidenceCatalog instanceof Map, 'wallet_audit_basis')
  const resolutions = new Map()
  for (const resolution of basis.resolutions) {
    exactKeys(resolution, ['sourceId', 'sourceHash', 'rawCreatedAt', 'timeKind', 'offsetMinutes', 'evidenceId', 'evidenceSha256'])
    check(!resolutions.has(resolution.sourceId), 'wallet_audit_duplicate_resolution')
    resolutions.set(resolution.sourceId, resolution)
  }
  check(Array.isArray(actual) && Array.isArray(archives), 'wallet_audit_rows')
  const targets = new Map(), savedArchives = new Map(), differences = []
  const add = (sourceId, field, code) => differences.push({ sourceId, field, code })
  for (const row of actual) {
    exactKeys(row, walletAuditFields)
    check(typeof row.id === 'string' && !targets.has(row.id), 'wallet_audit_duplicate_target')
    targets.set(row.id, row)
  }
  for (const row of archives) {
    check(typeof row.sourceId === 'string' && !savedArchives.has(row.sourceId), 'wallet_audit_duplicate_archive')
    savedArchives.set(row.sourceId, row)
  }
  for (const entry of source.entries) {
    const id = entry.sourceId, original = entry.source, resolution = resolutions.get(id)
    check(resolution?.sourceHash === entry.sourceHash && resolution.rawCreatedAt === original.created_at, 'wallet_audit_resolution_binding')
    check(typeof resolution.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(resolution.evidenceId)
      && typeof resolution.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(resolution.evidenceSha256)
      && evidenceCatalog.get(resolution.evidenceId) === resolution.evidenceSha256, 'wallet_audit_evidence')
    let expectedCreated = null
    if (original.created_at === null) check(resolution.timeKind === 'source_null' && resolution.offsetMinutes === null, 'wallet_audit_null_rule')
    else {
      check(resolution.timeKind === 'wall_clock' && Number.isInteger(resolution.offsetMinutes)
        && Math.abs(resolution.offsetMinutes) <= 840, 'wallet_audit_offset')
      const wall = inspectWallClock(original.created_at).canonicalWallClock
      const date = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - resolution.offsetMinutes * 60000)
      check(date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999, 'wallet_audit_creation_range')
      expectedCreated = date.toISOString().replace('T', ' ').slice(0, -1)
    }
    const row = targets.get(id)
    if (!row) add(id, 'target', 'missing')
    else {
      const expected = { id, chain: original.chain, address_index: original.address_index, address: original.address,
        created_at_utc: expectedCreated, custody_reference: null, custody_evidence_sha256: null, custody_verified_at_utc: null,
        revision: '1', origin: 'legacy_import', migration_run_id: run.id, source_sha256: entry.sourceHash, imported_at_utc: registered }
      for (const field of walletAuditFields) {
        const value = ['created_at_utc', 'custody_verified_at_utc', 'imported_at_utc'].includes(field)
          ? inspectWallClock(row[field]).canonicalWallClock : row[field]
        if (value !== expected[field]) add(id, field, 'value_mismatch')
      }
    }
    targets.delete(id)
    const archive = savedArchives.get(id)
    if (!archive) add(id, 'archive', 'missing')
    else {
      if (archive.runId !== run.id || archive.sourcePkHash !== hash([{ type: 'integer', value: id }])
        || archive.sourceHash !== entry.sourceHash) add(id, 'archive', 'identity_mismatch')
      const expected = { version: 1, sourceTable: 'wallet_keys', projection: 'wallet-source/v1', source: original,
        sourceSnapshotId: run.sourceSnapshotId, registeredAtUtc: run.registeredAtUtc, basisHash: hash(basis), resolution }
      if (canonical(archive.payload) !== canonical(expected)) add(id, 'archive', 'payload_mismatch')
    }
    savedArchives.delete(id)
  }
  for (const id of targets.keys()) add(id, 'target', 'unexpected')
  for (const id of savedArchives.keys()) add(id, 'archive', 'unexpected')
  return { version: 'wallet-import-audit/v1', sourceRows: sources.length, targetRows: actual.length, archiveRows: archives.length,
    importMatchesReviewedInputs: differences.length === 0, differences, checkedTargetFields: walletAuditFields,
    evidenceCatalogExternallyRequired: true, businessCutoverVerified: false, deletionAuthorized: false, fullWalletConverted: false }
}
