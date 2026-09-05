import { randomUUID } from 'node:crypto'
import { BOOTSTRAP_ID, requireMigration as check, sha256 } from './v4-migration-plan.mjs'
import { readSchemaFingerprint } from './v4-schema-fingerprint.mjs'
import { appendMigrationEvent, EVENTS_TABLE } from './v4-migration-events.mjs'

// One-use, operator-reviewed rehearsal permits. These are not a general force/resume mechanism.
const permits = [
  {
    id: 'm1-a-bootstrap-warning-20260905', targetDatabase: 'dev_vue_m1_a',
    migrationId: BOOTSTRAP_ID, originalExecutionId: 'fdab3669-607a-4d88-a156-373245cf0597',
    originalChecksum: '3a5a1f4b1cd76d505884f3a4702da54f3d67ff379d1fcf832866b31a0f3ff215',
    originalCheckpoint: 2, reconciledCheckpoint: 3, errorCode: 'migration_statement_warning',
    schemaHash: 'b24e7a282f94184ab5635b3a49a06318a670caeeafdb995036f13342738d3189',
    historyHash: 'e90c28933f815578328ba8ae0b874bc2ac3f441983f5b23f93eac8d61b11ec33',
    countsHash: '9485e222b0dda38dd841402262602aa7522b4e32c6c1e4dd4f599391b164dbed',
    reason: 'Statement 3 CREATE succeeded with verified MySQL 1681 integer-width warning; exact empty table reconciled before checkpoint advancement.',
  },
  {
    id: 'm1-b-011-foreign-keys-20260905', targetDatabase: 'dev_vue_m1_b',
    migrationId: '20260904_011_user_execution_commands_and_distributions', originalExecutionId: '74b932ef-df6a-40c2-80e0-6328deb14613',
    originalChecksum: '59f39b04871bee1a470785f03d3a7de1719c39a4abe22e87c16a2a8d3dc0ca3f',
    originalCheckpoint: 2, reconciledCheckpoint: 2, errorCode: 'migration_statement_failed',
    schemaHash: '8a5c5dec04cf076055fd92be241ea19a69e0ffa5a1621f91cdb99649a77d2a3d',
    historyHash: '49cd0f08d719a08a364ea92f8bbec6acf055f021d89d3fa6b33d44b24f438098',
    countsHash: 'f65cd3bf0a5d770d1b8450258a723e9901e506d6292fd9a12101703bf2b99f19',
    requiredCorrection: {
      id: '011-execution-intent-foreign-keys', statementNumber: 3,
      originalStatementChecksum: 'e2d3d71be9dfd1db4703345e929eef8421e162179e8a4adabab72ee318c08250',
      checksum: '747c209d9dfe75ad969cf04e4b037d7b1e1dc6838565bf63c2db20de4dea419b',
      sqlChecksum: 'c307519eb07ac064382c7ee372a8e63aa51b578d5589bec2b91384beca8ec7e9',
    },
    reason: 'Statement 3 atomic ALTER failed with MySQL 1826; original columns and foreign keys unchanged. Resume with separately hashed correction.',
  },
].map(p => {
  if (p.requiredCorrection) Object.freeze(p.requiredCorrection)
  return Object.freeze({ ...p, serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' })
})

export function loadRecoveryPermit(id) {
  const permit = permits.find(p => p.id === id)
  check(permit, 'migration_recovery_unknown')
  return Object.freeze({ ...permit, checksum: sha256(JSON.stringify(permit)) })
}

export function validateRecoveryEvents(events, { targetDatabase, serverUuid }) {
  const seen = new Set()
  for (const event of events.filter(e => e.kind === 'recovery_authorized')) {
    const permit = loadRecoveryPermit(event.artifact_id)
    check(!seen.has(permit.id) && permit.checksum === event.artifact_sha256 && permit.migrationId === event.migration_id
      && permit.targetDatabase === targetDatabase && permit.serverUuid === serverUuid,
      'migration_recovery_evidence_invalid')
    seen.add(permit.id)
  }
}

export function validateRecoveryCorrection(permit, corrections) {
  const required = permit.requiredCorrection
  if (!required) return
  check(corrections.some(c => c.migrationId === permit.migrationId && c.originalChecksum === permit.originalChecksum
    && Object.entries(required).every(([key, value]) => c[key] === value)), 'migration_recovery_correction_required')
}

export function validateRecoveryEvidence(permit, { targetDatabase, serverUuid, history, schema, counts, migration, hasEvents }) {
  check(!hasEvents, 'migration_recovery_already_attempted')
  check(targetDatabase === permit.targetDatabase && serverUuid === permit.serverUuid, 'migration_recovery_target_mismatch')
  check(migration?.id === permit.migrationId && migration.checksum === permit.originalChecksum, 'migration_recovery_plan_mismatch')
  const row = history.find(h => h.id === permit.migrationId)
  check(row?.status === 'failed' && row.execution_id === permit.originalExecutionId && row.error_code === permit.errorCode
    && Number(row.completed_statements) === permit.originalCheckpoint && row.checksum_sha256 === permit.originalChecksum
    && Number(row.statement_count) === migration.statements.length && !row.completed_at_utc, 'migration_recovery_history_mismatch')
  check(sha256(JSON.stringify(history)) === permit.historyHash, 'migration_recovery_history_drift')
  check(schema.sha256 === permit.schemaHash, 'migration_recovery_schema_drift')
  check(sha256(JSON.stringify(counts)) === permit.countsHash, 'migration_recovery_data_drift')
  check(permit.reconciledCheckpoint >= permit.originalCheckpoint && permit.reconciledCheckpoint < migration.statements.length,
    'migration_recovery_checkpoint_invalid')
}

export async function inspectRecovery(control, permit, context) {
  const schema = await readSchemaFingerprint(control)
  const counts = []
  for (const table of schema.tables) {
    if (['schema_migrations', EVENTS_TABLE].includes(table.name)) continue
    const [[row]] = await control.query(`SELECT COUNT(*) n FROM \`${table.name}\``)
    counts.push({ name: table.name, count: String(row.n) })
  }
  validateRecoveryEvidence(permit, { ...context, schema, counts })
  return { schema, counts }
}

export async function authorizeRecovery(control, permit, history, evidence) {
  const executionId = randomUUID()
  // Only metadata DML is transactional; no DDL is represented as rollback-safe.
  await control.beginTransaction()
  try {
    const [lockedHistory] = await control.query(`SELECT id,checksum_sha256,execution_id,status,statement_count,completed_statements,completed_at_utc,error_code
      FROM schema_migrations ORDER BY id FOR UPDATE`)
    check(sha256(JSON.stringify(lockedHistory)) === permit.historyHash, 'migration_recovery_history_drift')
    const [[originalTiming]] = await control.query('SELECT started_at_utc FROM schema_migrations WHERE id=? FOR UPDATE', [permit.migrationId])
    await appendMigrationEvent(control, permit.migrationId, executionId, 'recovery_authorized', permit,
      { originalHistory: history, originalTiming, reconciledCheckpoint: permit.reconciledCheckpoint, reason: permit.reason, evidence })
    const [result] = await control.query(`UPDATE schema_migrations SET execution_id=?,status='running',completed_statements=?,error_code=NULL,started_at_utc=UTC_TIMESTAMP(3)
      WHERE id=? AND execution_id=? AND status='failed' AND completed_statements=? AND checksum_sha256=?`,
    [executionId, permit.reconciledCheckpoint, permit.migrationId, permit.originalExecutionId, permit.originalCheckpoint, permit.originalChecksum])
    check(result.affectedRows === 1, 'migration_recovery_checkpoint_failed')
    await control.commit()
    return { executionId, startIndex: permit.reconciledCheckpoint }
  } catch (error) { await control.rollback(); throw error }
}
