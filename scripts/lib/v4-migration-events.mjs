import { randomUUID } from 'node:crypto'
import { requireMigration as check } from './v4-migration-plan.mjs'

export const EVENTS_TABLE = 'schema_migration_events'
const ddl = `CREATE TABLE schema_migration_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  migration_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('recovery_authorized','correction_started','correction_completed') NOT NULL,
  artifact_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  artifact_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  details_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  KEY idx_schema_event_execution (migration_id,execution_id,kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
const shape = [
  ['id', 'char(36)', 'NO', 'PRI'], ['migration_id', 'varchar(191)', 'NO', 'MUL'],
  ['execution_id', 'char(36)', 'NO', ''], ['kind', "enum('recovery_authorized','correction_started','correction_completed')", 'NO', ''],
  ['artifact_id', 'varchar(191)', 'NO', ''], ['artifact_sha256', 'char(64)', 'NO', ''],
  ['details_json', 'json', 'NO', ''], ['created_at_utc', 'datetime(3)', 'NO', ''],
]

export async function createMigrationEvents(control) { await control.query(ddl) }

export async function readMigrationEvents(control) {
  const [columns] = await control.query(`SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_KEY column_key
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schema_migration_events' ORDER BY ORDINAL_POSITION`)
  check(JSON.stringify(columns.map(c => [c.name, c.type, c.nullable, c.column_key])) === JSON.stringify(shape), 'migration_events_schema_invalid')
  const [rows] = await control.query('SELECT migration_id,execution_id,kind,artifact_id,artifact_sha256 FROM schema_migration_events ORDER BY created_at_utc,id')
  return rows
}

export async function appendMigrationEvent(control, migrationId, executionId, kind, artifact, details) {
  const [result] = await control.query(`INSERT INTO schema_migration_events
    (id,migration_id,execution_id,kind,artifact_id,artifact_sha256,details_json,created_at_utc)
    VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
  [randomUUID(), migrationId, executionId, kind, artifact.id, artifact.checksum, JSON.stringify(details)])
  check(result.affectedRows === 1, 'migration_event_write_failed')
}

export function validateCorrectionEvents(events, history, corrections) {
  const correctionEvents = events.filter(e => e.kind !== 'recovery_authorized')
  for (const event of correctionEvents) {
    check(corrections.some(c => c.id === event.artifact_id && c.checksum === event.artifact_sha256 && c.migrationId === event.migration_id), 'migration_correction_evidence_invalid')
  }
  for (const correction of corrections) {
    const row = history.find(h => h.id === correction.migrationId)
    if (!row || Number(row.completed_statements) < correction.statementNumber) continue
    const matching = correctionEvents.filter(e => e.artifact_id === correction.id && e.execution_id === row.execution_id)
    check(matching.filter(e => e.kind === 'correction_started').length === 1
      && matching.filter(e => e.kind === 'correction_completed').length === 1, 'migration_correction_receipt_missing')
  }
}
