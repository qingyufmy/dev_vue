import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { backupContinuationConfig, retainedBackup, validateRetainedMetadata, assertContinuationTargetAbsent } from '../scripts/lib/v4-backup-continuation.mjs'

const scope = { runId: retainedBackup.runId, serverUuid: retainedBackup.serverUuid, newTargetConfirmed: true }
const config = backupContinuationConfig(scope)
const observation = { kind: 'v4_backup_database_observation', database: 'dev_vue', serverUuid: scope.serverUuid,
  mysqlVersion: '8.4.8', schemaFingerprint: { sha256: retainedBackup.schemaSha256, charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }, tables: Array(165).fill({}) }
const exported = { ...retainedBackup.encrypted, stages: [retainedBackup.rawSql] }
const failure = { status: 'failed', code: 'backup_sql_function_forbidden', stage: 'decrypt-and-sql-review', target: config.target,
  targetCreated: false, targetCreationAttempted: false, targetMayExist: false }

describe('single frozen backup continuation', () => {
  it('pins the previously approved run, instance and an exclusive continuation directory', () => {
    expect(config.continuationDirectory).toBe('/www/backup/aurum-v4/m1/20260905-01/continuation-01')
    expect(config.target).toBe('dev_vue_m1_source_20260905_01')
    expect(Object.isFrozen(config)).toBe(true)
    for (const delta of [{ runId: '20260905-02' }, { serverUuid: 'unknown' }, { newTargetConfirmed: false }, { newTargetConfirmed: undefined }]) {
      expect(() => backupContinuationConfig({ ...scope, ...delta })).toThrow('backup_continuation_scope_invalid')
    }
  })
  it('requires exact retained source and encrypted/plaintext anchors', () => {
    expect(() => validateRetainedMetadata(observation, observation, exported, failure, config)).not.toThrow()
    for (const changed of [{ ...observation, database: config.target }, { ...observation, mysqlVersion: '8.4.9' },
      { ...observation, tables: [] }, { ...observation, schemaFingerprint: { ...observation.schemaFingerprint, sha256: '0'.repeat(64) } }]) {
      expect(() => validateRetainedMetadata(changed, observation, exported, failure, config)).toThrow('backup_retained_metadata_invalid')
    }
    expect(() => validateRetainedMetadata(observation, observation, { ...exported, sha256: '0'.repeat(64) }, failure, config)).toThrow('backup_retained_export_mismatch')
  })
  it('cannot continue after any possible prior database write, missing evidence, or different failure stage', () => {
    for (const delta of [{ targetCreated: true }, { targetCreationAttempted: true }, { targetMayExist: true },
      { targetCreationAttempted: undefined }, { stage: 'restore-verification' }, { target: 'dev_vue' }]) {
      expect(() => validateRetainedMetadata(observation, observation, exported, { ...failure, ...delta }, config))
        .toThrow('backup_continuation_previous_write_uncertain')
    }
  })
  it('rechecks exact socket identity and target absence using bounded read-only queries', async () => {
    const queries = []
    const connection = { query: async query => { queries.push(query); return queries.length === 1
      ? [[{ db: 'dev_vue', uuid: scope.serverUuid, version: '8.4.8' }]] : [[]] } }
    await assertContinuationTargetAbsent(connection, config)
    expect(queries).toHaveLength(2)
    expect(queries[1].values).toEqual([config.target])
    expect(queries.every(query => query.sql.startsWith('SELECT') && query.timeout === 10000)).toBe(true)
  })
  it('refuses an existing target or identity mismatch instead of clearing or reusing it', async () => {
    for (const identity of [{ db: 'mysql', uuid: scope.serverUuid, version: '8.4.8' },
      { db: 'dev_vue', uuid: 'wrong', version: '8.4.8' }, { db: 'dev_vue', uuid: scope.serverUuid, version: '8.4.9' }]) {
      await expect(assertContinuationTargetAbsent({ query: async () => [[identity]] }, config)).rejects.toThrow('backup_instance_mismatch')
    }
    let calls = 0
    await expect(assertContinuationTargetAbsent({ query: async () => ++calls === 1
      ? [[{ db: 'dev_vue', uuid: scope.serverUuid, version: '8.4.8' }]] : [[{ SCHEMA_NAME: config.target }]] }, config))
      .rejects.toThrow('backup_restore_target_exists')
  })
  it('keeps the formal full SQL review before the sole CREATE and dumps only the isolated target', () => {
    const code = readFileSync(new URL('../scripts/lib/v4-backup-continuation.mjs', import.meta.url), 'utf8')
    expect(code.indexOf('await inspectBackupSql(')).toBeLessThan(code.indexOf('CREATE DATABASE'))
    expect(code.match(/CREATE DATABASE/g)).toHaveLength(1)
    expect(code).not.toContain('backupDumpArgs(config.source)')
    expect(code).not.toMatch(/DROP DATABASE|IF NOT EXISTS|--force|randomBytes|unlink\(/)
    expect(code).toContain('backupDumpArgs(config.target)')
    expect(code).toContain("await mkdir(directory, { mode: 0o700 })")
    expect(code).toContain('compareRestoredDump(review, restoredReview, restored)')
  })
})
