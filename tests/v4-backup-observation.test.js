import { describe, expect, it } from 'vitest'
import { compareBackupObservations } from '../scripts/lib/v4-backup-observation.mjs'

const database = 'dev_vue_m1_source_20260905_01'
function observation(role = 'source') {
  return { version: 1, kind: 'v4_backup_database_observation', role,
    database: role === 'source' ? 'dev_vue' : database, serverUuid: '00000000-0000-0000-0000-000000000001',
    tables: [{ name: 'users', rowCount: '9007199254740993' }], totalRows: '9007199254740993',
    schemaFingerprint: { sha256: '1'.repeat(64), tableCount: 1, tables: [{ name: 'users', sha256: '2'.repeat(64) }] } }
}
describe('backup restoration observation comparison', () => {
  it('retains precise counts and never equates parity with migrated or frozen data', () => {
    expect(compareBackupObservations(observation(), observation('restored-source'))).toMatchObject({ status: 'match', scope: 'schema_and_counts_only',
      sourceSnapshotBound: false, rowContentsVerified: false, migrationReady: false })
  })
  it('reports same-table count and schema differences', () => {
    const actual = observation('restored-source')
    actual.tables[0].rowCount = '9007199254740994'; actual.totalRows = actual.tables[0].rowCount
    actual.schemaFingerprint.tables[0].sha256 = '3'.repeat(64)
    expect(compareBackupObservations(observation(), actual).differences).toEqual([
      { table: 'users', kind: 'row_count', expected: '9007199254740993', actual: '9007199254740994' }, { table: 'users', kind: 'schema' },
    ])
  })
  it('rejects old planning inventory, duplicate tables, wrong target and corrupt totals', () => {
    const invalid = [
      { ...observation(), kind: 'planning_inventory_not_backup' },
      { ...observation(), totalRows: '1' },
      { ...observation(), tables: [observation().tables[0], observation().tables[0]] },
      { ...observation(), database: 'mysql' },
    ]
    for (const item of invalid) expect(() => compareBackupObservations(item, observation('restored-source'))).toThrow()
    expect(() => compareBackupObservations(observation(), observation())).toThrow('backup_comparison_requires_restore')
    expect(() => compareBackupObservations(observation(), { ...observation('restored-source'), database: 'dev_vue_m1_a' })).toThrow()
    expect(() => compareBackupObservations(observation(), { ...observation('restored-source'), serverUuid: '00000000-0000-0000-0000-000000000002' })).toThrow('backup_comparison_instance_mismatch')
  })
  it('reports missing, unexpected tables and database-level fingerprint changes', () => {
    const actual = observation('restored-source')
    actual.tables[0].name = 'accounts'; actual.schemaFingerprint.tables[0].name = 'accounts'
    expect(compareBackupObservations(observation(), actual).differences).toEqual([
      { table: 'accounts', kind: 'unexpected_table' }, { table: 'users', kind: 'missing_table' },
    ])
    const changed = observation('restored-source'); changed.schemaFingerprint.sha256 = '4'.repeat(64)
    expect(compareBackupObservations(observation(), changed).differences).toEqual([{ kind: 'database_schema' }])
  })
})
