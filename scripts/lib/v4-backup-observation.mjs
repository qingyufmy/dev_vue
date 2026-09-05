import { requireBackup } from './v4-backup-artifact.mjs'

const identifier = /^[a-z][a-z0-9_]{0,63}$/
const digest = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

function validateObservation(value) {
  requireBackup(value?.version === 1 && value.kind === 'v4_backup_database_observation', 'backup_observation_invalid')
  requireBackup(['source', 'restored-source'].includes(value.role) && typeof value.database === 'string', 'backup_observation_invalid')
  requireBackup(value.role === 'source' ? value.database === 'dev_vue' : /^dev_vue_m1_source_\d{8}_\d{2}$/.test(value.database), 'backup_observation_database_invalid')
  requireBackup(typeof value.serverUuid === 'string' && uuid.test(value.serverUuid), 'backup_observation_identity_invalid')
  requireBackup(Array.isArray(value.tables) && value.tables.length > 0 && value.tables.length <= 512, 'backup_observation_tables_invalid')
  const names = new Set()
  let total = 0n
  for (const table of value.tables) {
    requireBackup(identifier.test(table.name ?? '') && !names.has(table.name), 'backup_observation_tables_invalid')
    requireBackup(typeof table.rowCount === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(table.rowCount), 'backup_observation_count_invalid')
    names.add(table.name)
    total += BigInt(table.rowCount)
  }
  requireBackup(total.toString() === value.totalRows, 'backup_observation_count_invalid')
  const fingerprint = value.schemaFingerprint
  requireBackup(fingerprint && digest.test(fingerprint.sha256 ?? '') && fingerprint.tableCount === names.size && Array.isArray(fingerprint.tables) && fingerprint.tables.length === names.size,
    'backup_observation_fingerprint_invalid')
  const fingerprints = new Map()
  for (const table of fingerprint.tables) {
    requireBackup(names.has(table.name) && !fingerprints.has(table.name) && digest.test(table.sha256 ?? ''), 'backup_observation_fingerprint_invalid')
    fingerprints.set(table.name, table.sha256)
  }
  return { counts: new Map(value.tables.map(table => [table.name, table.rowCount])), fingerprints }
}

// A source observation is not bound to mysqldump's transaction. Parity is diagnostic only.
export function compareBackupObservations(baseline, actual) {
  const before = validateObservation(baseline)
  const after = validateObservation(actual)
  requireBackup(actual.role === 'restored-source', 'backup_comparison_requires_restore')
  requireBackup(baseline.serverUuid === actual.serverUuid, 'backup_comparison_instance_mismatch')
  const differences = []
  for (const name of [...new Set([...before.counts.keys(), ...after.counts.keys()])].sort()) {
    if (!before.counts.has(name)) differences.push({ table: name, kind: 'unexpected_table' })
    else if (!after.counts.has(name)) differences.push({ table: name, kind: 'missing_table' })
    else {
      if (before.counts.get(name) !== after.counts.get(name)) differences.push({ table: name, kind: 'row_count', expected: before.counts.get(name), actual: after.counts.get(name) })
      if (before.fingerprints.get(name) !== after.fingerprints.get(name)) differences.push({ table: name, kind: 'schema' })
    }
  }
  if (baseline.schemaFingerprint.sha256 !== actual.schemaFingerprint.sha256 && !differences.some(item => item.kind === 'schema' || item.kind.endsWith('_table'))) {
    differences.push({ kind: 'database_schema' })
  }
  return { status: differences.length ? 'different' : 'match', scope: 'schema_and_counts_only',
    baselineDatabase: baseline.database, restoredDatabase: actual.database, differences,
    sourceSnapshotBound: false, rowContentsVerified: false, migrationReady: false }
}
