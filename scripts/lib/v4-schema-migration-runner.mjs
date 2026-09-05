import { randomUUID } from 'node:crypto'
import { BOOTSTRAP_ID, V4SchemaMigrationError, createdTables, requireMigration as check,
  sha256, validateDatabaseIdentifier, validateMigrationStatement } from './v4-migration-plan.mjs'
import { appendMigrationEvent, createMigrationEvents, EVENTS_TABLE, readMigrationEvents, validateCorrectionEvents } from './v4-migration-events.mjs'
import { authorizeRecovery, inspectRecovery, loadRecoveryPermit, validateRecoveryCorrection, validateRecoveryEvents } from './v4-migration-recovery.mjs'

const journalDdl = `CREATE TABLE schema_migrations (
  id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('running','completed','failed') NOT NULL,
  statement_count INT UNSIGNED NOT NULL,
  completed_statements INT UNSIGNED NOT NULL DEFAULT 0,
  started_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
const journalColumns = [
  ['id', 'varchar(191)', 'NO', 'PRI'], ['checksum_sha256', 'char(64)', 'NO', ''],
  ['execution_id', 'char(36)', 'NO', ''], ['status', "enum('running','completed','failed')", 'NO', ''],
  ['statement_count', 'int unsigned', 'NO', ''], ['completed_statements', 'int unsigned', 'NO', ''],
  ['started_at_utc', 'datetime(3)', 'NO', ''], ['completed_at_utc', 'datetime(3)', 'YES', ''], ['error_code', 'varchar(64)', 'YES', ''],
]

// The execution connection owns the lock and session variables. Journal queries NEVER use it mid-file.
export async function runSchemaMigrations(execution, control, plan, { sourceDatabase, targetDatabase, apply = false, stopAfterMigration = null,
  corrections = [], recoveryId = null } = {}) {
  validateDatabaseIdentifier(sourceDatabase)
  validateDatabaseIdentifier(targetDatabase)
  check(sourceDatabase !== targetDatabase, 'migration_target_is_source')
  check(execution !== control, 'migration_separate_connections_required')
  validatePlan(plan)
  for (const correction of corrections) {
    const migration = plan.find(m => m.id === correction.migrationId)
    check(migration?.checksum === correction.originalChecksum && sha256(migration.statements[correction.statementNumber - 1] ?? '') === correction.originalStatementChecksum,
      'migration_correction_plan_mismatch')
    check(sha256(correction.sql) === correction.sqlChecksum, 'migration_correction_sql_mismatch')
    validateMigrationStatement(correction.sql, correction.migrationId)
  }
  check(new Set(corrections.map(c => `${c.migrationId}:${c.statementNumber}`)).size === corrections.length, 'migration_correction_duplicate')
  check(!recoveryId || !stopAfterMigration, 'migration_recovery_stop_conflict')
  check(!stopAfterMigration || plan.some(m => m.id === stopAfterMigration), 'migration_stop_unknown')
  const lock = `v4-schema:${sha256(targetDatabase).slice(0, 48)}`
  let locked = false
  try {
    const identities = []
    for (const connection of [execution, control]) {
      const [[identity]] = await connection.query('SELECT DATABASE() db,CONNECTION_ID() connection_id,@@server_uuid server_uuid')
      check(identity.db === targetDatabase, 'migration_target_mismatch')
      identities.push(identity)
      await connection.query("SET SESSION time_zone='+00:00'")
      await connection.query('SET SESSION lock_wait_timeout=10')
      await connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'")
      await connection.query('SET SESSION autocommit=1')
    }
    check(identities[0].server_uuid === identities[1].server_uuid && identities[0].connection_id !== identities[1].connection_id, 'migration_connection_identity_mismatch')
    const [[row]] = await execution.query('SELECT GET_LOCK(?,0) acquired', [lock])
    check(Number(row.acquired) === 1, 'migration_lock_busy')
    locked = true
    const [tables] = await control.query('SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
    check(tables.every(table => table.type === 'BASE TABLE'), 'migration_unknown_table')
    const hasJournal = tables.some(table => table.name === 'schema_migrations')
    const hasEvents = tables.some(table => table.name === EVENTS_TABLE)
    const events = hasEvents ? await readMigrationEvents(control) : []
    validateRecoveryEvents(events, { targetDatabase, serverUuid: identities[0].server_uuid })
    const business = tables.filter(table => !['schema_migrations', EVENTS_TABLE].includes(table.name)).map(table => table.name).sort()
    let history = []
    if (hasJournal) {
      await verifyJournal(control)
      ;[history] = await control.query('SELECT id,checksum_sha256,execution_id,status,statement_count,completed_statements,completed_at_utc,error_code FROM schema_migrations ORDER BY id')
    }
    if (recoveryId) {
      const permit = loadRecoveryPermit(recoveryId)
      validateRecoveryCorrection(permit, corrections)
      const migration = plan.find(m => m.id === permit.migrationId)
      const prior = history.filter(row => row.id !== permit.migrationId)
      validateHistory(prior, plan)
      check(plan[prior.length]?.id === permit.migrationId && history.length === prior.length + 1, 'migration_recovery_history_gap')
      const evidence = await inspectRecovery(control, permit, { targetDatabase, serverUuid: identities[0].server_uuid, history, migration, hasEvents })
      validateCorrectionEvents(events, prior, corrections)
      if (!apply) return { status: 'recovery_planned', writes: false, recoveryId, reconciledCheckpoint: permit.reconciledCheckpoint }
      await createMigrationEvents(control)
      const resume = await authorizeRecovery(control, permit, history, evidence)
      await applyMigration(execution, control, migration, corrections, resume)
      return { status: 'recovered', recoveryId, applied: [migration.id] }
    }
    validateHistory(history, plan)
    validateCorrectionEvents(events, history, corrections)
    const completed = new Set(history.map(row => row.id))
    const expectedTables = createdTables(plan.filter(m => completed.has(m.id))).sort()
    check(JSON.stringify(business) === JSON.stringify(expectedTables), 'migration_table_inventory_mismatch')
    const pending = plan.filter(m => !completed.has(m.id))
    if (!apply) return { status: 'planned', writes: false, completed: completed.size, pending: pending.map(m => m.id) }
    if (!hasJournal) await control.query(journalDdl)
    if (corrections.length && !hasEvents) await createMigrationEvents(control)
    const applied = []
    if (stopAfterMigration && completed.has(stopAfterMigration)) return { status: 'paused', applied, skipped: completed.size }
    for (const migration of pending) {
      await applyMigration(execution, control, migration, corrections)
      applied.push(migration.id)
      if (migration.id === stopAfterMigration) return { status: 'paused', applied, skipped: completed.size }
    }
    return { status: 'completed', applied, skipped: completed.size }
  } catch (error) {
    if (error instanceof V4SchemaMigrationError) throw error
    throw new V4SchemaMigrationError('migration_database_error', { errno: Number.isInteger(error?.errno) ? error.errno : null })
  } finally {
    if (locked) await execution.query('SELECT RELEASE_LOCK(?) released', [lock]).catch(() => undefined)
  }
}

function validatePlan(plan) {
  check(Array.isArray(plan) && plan[0]?.id === BOOTSTRAP_ID, 'migration_plan_invalid')
  const ids = new Set()
  plan.forEach((m, index) => {
    check(!ids.has(m.id) && /^[a-f0-9]{64}$/.test(m.checksum) && Array.isArray(m.statements) && m.statements.length > 0, 'migration_plan_invalid')
    if (index > 0) check(/^\d{8}_\d{3}_[a-z0-9_]+$/.test(m.id) && Number(m.id.split('_')[1]) === index, 'migration_sequence_invalid')
    ids.add(m.id)
    m.statements.forEach(sql => validateMigrationStatement(sql, m.id))
  })
}

export function validateHistory(history, plan) {
  const known = new Map(plan.map(m => [m.id, m]))
  const completed = new Set()
  for (const row of history) {
    const migration = known.get(row.id)
    check(migration && !completed.has(row.id), 'migration_history_unknown')
    check(row.checksum_sha256 === migration.checksum, 'migration_checksum_mismatch')
    check(row.status === 'completed', 'migration_incomplete', { id: row.id })
    check(Number(row.statement_count) === migration.statements.length && Number(row.completed_statements) === migration.statements.length && row.completed_at_utc && !row.error_code,
      'migration_checkpoint_invalid')
    check(typeof row.execution_id === 'string' && /^[a-f0-9-]{36}$/i.test(row.execution_id), 'migration_history_invalid')
    completed.add(row.id)
  }
  check(plan.slice(0, completed.size).every(m => completed.has(m.id)), 'migration_history_gap')
}

async function verifyJournal(control) {
  const [columns] = await control.query(`SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_KEY column_key
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schema_migrations' ORDER BY ORDINAL_POSITION`)
  check(JSON.stringify(columns.map(c => [c.name, c.type, c.nullable, c.column_key])) === JSON.stringify(journalColumns), 'migration_journal_schema_invalid')
}

async function applyMigration(execution, control, migration, corrections = [], resume = null) {
  const executionId = resume?.executionId ?? randomUUID()
  if (!resume) await control.query(`INSERT INTO schema_migrations
    (id,checksum_sha256,execution_id,status,statement_count,completed_statements,started_at_utc)
    VALUES (?,?,?,'running',?,0,UTC_TIMESTAMP(3))`, [migration.id, migration.checksum, executionId, migration.statements.length])
  try {
    for (let index = resume?.startIndex ?? 0; index < migration.statements.length; index++) {
      const correction = corrections.find(c => c.migrationId === migration.id && c.statementNumber === index + 1)
      if (correction) await appendMigrationEvent(control, migration.id, executionId, 'correction_started', correction,
        { originalChecksum: migration.checksum, originalStatementChecksum: correction.originalStatementChecksum, statementNumber: index + 1 })
      const sql = correction?.sql ?? migration.statements[index]
      const [result] = await execution.query(sql)
      // SHOW WARNINGS is permitted after DDL only. Never interleave it between data statements:
      // migration 008 consumes the prior INSERT's ROW_COUNT() and LAST_INSERT_ID().
      if (result.warningStatus) {
        check(/^(CREATE TABLE|ALTER TABLE)\b/.test(sql), 'migration_statement_warning', { id: migration.id, statement: index + 1 })
        const [warnings] = await execution.query('SHOW WARNINGS')
        check(warnings.length > 0 && warnings.every(warning => Number(warning.Code) === 1681
          && warning.Message === 'Integer display width is deprecated and will be removed in a future release.'),
        'migration_statement_warning', { id: migration.id, statement: index + 1, warningCodes: warnings.map(warning => Number(warning.Code)) })
      }
      if (correction) await appendMigrationEvent(control, migration.id, executionId, 'correction_completed', correction, { statementNumber: index + 1 })
      const [saved] = await control.query(`UPDATE schema_migrations SET completed_statements=?
        WHERE id=? AND execution_id=? AND status='running' AND completed_statements=?`, [index + 1, migration.id, executionId, index])
      check(saved.affectedRows === 1, 'migration_checkpoint_failed')
    }
    const [saved] = await control.query(`UPDATE schema_migrations SET status='completed',completed_at_utc=UTC_TIMESTAMP(3)
      WHERE id=? AND execution_id=? AND status='running' AND completed_statements=?`, [migration.id, executionId, migration.statements.length])
    check(saved.affectedRows === 1, 'migration_completion_failed')
  } catch (error) {
    const code = error instanceof V4SchemaMigrationError ? error.code : 'migration_statement_failed'
    await control.query(`UPDATE schema_migrations SET status='failed',error_code=?
      WHERE id=? AND execution_id=? AND status='running'`, [code, migration.id, executionId]).catch(() => undefined)
    throw new V4SchemaMigrationError(code, { id: migration.id, errno: Number.isInteger(error?.errno) ? error.errno : null, ...error.details })
  }
}
