import { sha256 } from './v4-migration-plan.mjs'

// Independent in-place steps: never mark legacy schema_migrations as V4 bootstrap.
const columns = [
  ['users', 'last_seen_at_utc', 'DATETIME(3) NULL DEFAULT NULL', 'datetime(3)', 'YES', null, null],
  ['users', 'profile_revision', 'BIGINT UNSIGNED NOT NULL DEFAULT 1', 'bigint unsigned', 'NO', '1', null],
  ['bridge_refresh_sessions', 'credential_version', 'TINYINT UNSIGNED NOT NULL DEFAULT 3', 'tinyint unsigned', 'NO', '3', null],
  ['bridge_refresh_sessions', 'installation_id', 'VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL', 'varchar(128)', 'YES', null, 'ascii_bin'],
  ['bridge_refresh_sessions', 'profile_id', 'VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL', 'varchar(128)', 'YES', null, 'ascii_bin'],
  ['bridge_refresh_sessions', 'generation', 'INT UNSIGNED NOT NULL DEFAULT 1', 'int unsigned', 'NO', '1', null],
  ['bridge_refresh_sessions', 'migration_key', 'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL', 'char(64)', 'YES', null, 'ascii_bin'],
  ['bridge_refresh_sessions', 'source_fingerprint', 'CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL', 'char(71)', 'YES', null, 'ascii_bin'],
  ['bridge_refresh_sessions', 'source_refresh_session_id', 'BIGINT NULL', 'bigint', 'YES', null, null],
]

export const inplaceColumnSteps = Object.freeze(columns.map(([table, column, declaration, type, nullable, defaultValue, collation], index) => {
  const sql = `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${declaration}`
  const expected = { type, nullable, defaultValue, collation, extra: '' }
  return Object.freeze({ id: `inplace_001_${String(index + 1).padStart(2, '0')}_${table}_${column}`, table, column, sql,
    expected: Object.freeze(expected), checksum: sha256(JSON.stringify({ sql, expected })) })
}))

export function columnMatches(actual, expected) {
  return actual !== null && Object.keys(expected).every(key => actual[key] === expected[key])
}

export function validateColumnHistory(rows, steps = inplaceColumnSteps) {
  const byId = new Map(rows.map(row => [row.id, row]))
  if (byId.size !== rows.length || rows.some(row => !steps.some(step => step.id === row.id))) throw new Error('inplace_unknown_history')
  let ended = false
  for (const step of steps) {
    const row = byId.get(step.id)
    if (!row) { ended = true; continue }
    if (ended) throw new Error('inplace_history_gap')
    if (row.checksum !== step.checksum) throw new Error('inplace_step_checksum_mismatch')
    if (!['started', 'completed'].includes(row.status)) throw new Error('inplace_step_status_invalid')
    const started = Date.parse(row.startedAt)
    const completed = row.completedAt === null ? null : Date.parse(row.completedAt)
    if (!Number.isFinite(started) || (row.status === 'started' ? completed !== null :
      completed === null || !Number.isFinite(completed) || completed < started)) throw new Error('inplace_history_time_invalid')
    if (row.status === 'started') ended = true
  }
  return byId
}

// Adapter must hold an exclusive upgrade lock for this entire call.
// Journal begin must be durable BEFORE DDL. Failed/uncertain DDL is never blindly replayed.
export async function executeColumnSteps(store, steps = inplaceColumnSteps, { apply = false } = {}) {
  const history = validateColumnHistory(await store.history(), steps)
  const report = []
  const states = []
  for (const step of steps) {
    const journal = history.get(step.id) ?? null
    const actual = await store.column(step.table, step.column)
    if (journal && journal.checksum !== step.checksum) throw new Error('inplace_step_checksum_mismatch')
    if (journal && !['started', 'completed'].includes(journal.status)) throw new Error('inplace_step_status_invalid')
    if (actual && !columnMatches(actual, step.expected)) throw new Error('inplace_column_definition_conflict')
    if (!journal && actual) throw new Error('inplace_unrecorded_column')
    if (journal?.status === 'completed' && !actual) throw new Error('inplace_completed_column_missing')
    states.push({ step, journal, actual })
  }
  // Preflight every step before any writes. An unrelated later conflict must not partially upgrade this batch.
  for (const { step, journal, actual } of states) {
    if (journal?.status === 'completed') { report.push({ id: step.id, status: 'completed' }); continue }
    if (!apply) { report.push({ id: step.id, status: actual ? 'reconcile' : 'pending' }); continue }
    if (!journal) await store.begin(step)
    if (!actual) await store.execute(step.sql)
    const after = await store.column(step.table, step.column)
    if (!columnMatches(after, step.expected)) throw new Error('inplace_column_postcondition_failed')
    await store.complete(step)
    report.push({ id: step.id, status: actual ? 'reconciled' : 'applied' })
  }
  return { apply, steps: report }
}
