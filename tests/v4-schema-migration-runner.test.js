import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_ID, loadMigrationPlan, sha256, splitSqlStatements, validateMigrationStatement } from '../scripts/lib/v4-migration-plan.mjs'
import { runSchemaMigrations, validateHistory } from '../scripts/lib/v4-schema-migration-runner.mjs'

const options = { sourceDatabase: 'source_db', targetDatabase: 'test_db' }
const sql1 = 'CREATE TABLE users (id INT PRIMARY KEY)'
const sql2 = 'CREATE TABLE sessions (id INT PRIMARY KEY)'
const plan = [
  { id: BOOTSTRAP_ID, checksum: sha256(sql1), statements: [sql1] },
  { id: '20260903_001_test', checksum: sha256(sql2), statements: [sql2] },
]

describe('V4 schema runner', () => {
  it('loads all 18 files including reviewed DML in original order', async () => {
    const actual = await loadMigrationPlan({ rootDirectory: process.cwd() })
    expect(actual).toHaveLength(18)
    expect(actual[0].id).toBe(BOOTSTRAP_ID)
    expect(actual.reduce((total, m) => total + m.statements.length, 0)).toBe(143)
  })
  it('splits quoted semicolons, escapes and comments without executing comments', () => {
    expect(splitSqlStatements("-- skip;\nCREATE TABLE x (v TEXT DEFAULT 'a;''b'); /* skip; */ ALTER TABLE x ADD y INT;"))
      .toEqual(["CREATE TABLE x (v TEXT DEFAULT 'a;''b')", 'ALTER TABLE x ADD y INT'])
    expect(() => splitSqlStatements('/*! SELECT 1 */')).toThrow('migration_executable_comment')
    expect(() => splitSqlStatements("CREATE TABLE x (v TEXT DEFAULT 'oops)")).toThrow('migration_quote_unterminated')
    expect(() => splitSqlStatements('/* unclosed')).toThrow('migration_comment_unterminated')
  })
  it.each(['USE source_db', 'DELETE FROM users', 'CREATE TABLE x AS SELECT 1', 'ALTER TABLE x RENAME TO source_db.y',
    'CREATE TABLE source_db.x (id int)', 'SET GLOBAL foreign_key_checks=0', 'DELIMITER $$'])('rejects unapproved SQL: %s', sql => {
    expect(() => validateMigrationStatement(sql, BOOTSTRAP_ID)).toThrow()
  })
  it('defaults to read-only planning and never creates the journal', async () => {
    const f = fixture()
    expect(await runSchemaMigrations(f.execution, f.control, plan, options)).toMatchObject({ status: 'planned', writes: false })
    expect(f.state.tables.size).toBe(0)
    expect(f.state.history.size).toBe(0)
    expect(f.state.locked).toBe(false)
  })
  it('applies once, skips completed files and never interleaves control SQL on the execution connection', async () => {
    const f = fixture()
    expect(await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).toMatchObject({ applied: plan.map(m => m.id) })
    const statements = f.state.executionSql
    const first = statements.indexOf(sql1), last = statements.indexOf(sql2)
    expect(statements.slice(first, last + 1)).toEqual([sql1, sql2])
    expect(await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).toMatchObject({ applied: [], skipped: 2 })
    expect(f.state.executionSql.filter(sql => sql.startsWith('CREATE TABLE'))).toHaveLength(2)
  })
  it('pauses and resumes at completed file boundaries only', async () => {
    const f = fixture()
    const paused = { ...options, apply: true, stopAfterMigration: BOOTSTRAP_ID }
    expect(await runSchemaMigrations(f.execution, f.control, plan, paused)).toMatchObject({ status: 'paused', applied: [BOOTSTRAP_ID] })
    expect(await runSchemaMigrations(f.execution, f.control, plan, paused)).toMatchObject({ status: 'paused', applied: [] })
    expect(await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).toMatchObject({ applied: [plan[1].id] })
  })
  it('executes only the explicit correction with before/after receipts and keeps the original file hash', async () => {
    const f = fixture()
    const replacement = 'CREATE TABLE sessions (id BIGINT PRIMARY KEY)'
    const corrections = [{ id: 'correction', migrationId: plan[1].id, statementNumber: 1, originalChecksum: plan[1].checksum,
      originalStatementChecksum: sha256(sql2), checksum: sha256(replacement), sqlChecksum: sha256(replacement), sql: replacement }]
    await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true, corrections })
    expect(f.state.executionSql).toContain(replacement)
    expect(f.state.executionSql).not.toContain(sql2)
    expect(f.state.events.map(e => e.kind)).toEqual(['correction_started', 'correction_completed'])
    expect(f.state.history.get(plan[1].id).checksum_sha256).toBe(plan[1].checksum)
    expect(await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true, corrections })).toMatchObject({ applied: [] })
    f.state.events.pop()
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, corrections })).rejects.toThrow('migration_correction_receipt_missing')
  })
  it('never executes a correction when its authorization event cannot be persisted', async () => {
    const f = fixture({ failEvent: true })
    const corrections = [{ id: 'correction', migrationId: plan[1].id, statementNumber: 1, originalChecksum: plan[1].checksum,
      originalStatementChecksum: sha256(sql2), checksum: sha256(sql2), sqlChecksum: sha256(sql2), sql: sql2 }]
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true, corrections })).rejects.toThrow('migration_statement_failed')
    expect(f.state.executionSql).not.toContain(sql2)
    expect(f.state.history.get(plan[1].id).status).toBe('failed')
  })
  it('rejects source, wrong connection, shared connection, and lock contention', async () => {
    const f = fixture()
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, sourceDatabase: 'test_db', apply: true })).rejects.toThrow('migration_target_is_source')
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, targetDatabase: 'wrong_db' })).rejects.toThrow('migration_target_mismatch')
    await expect(runSchemaMigrations(f.execution, f.execution, plan, options)).rejects.toThrow('migration_separate_connections_required')
    f.state.locked = true
    await expect(runSchemaMigrations(f.execution, f.control, plan, options)).rejects.toThrow('migration_lock_busy')
    expect(f.state.tables.size).toBe(0)
  })
  it('rejects unmanaged nonempty databases and incompatible old journals', async () => {
    const f = fixture()
    f.state.tables.add('legacy_users')
    await expect(runSchemaMigrations(f.execution, f.control, plan, options)).rejects.toThrow('migration_table_inventory_mismatch')
    f.state.tables.clear(); f.state.tables.add('schema_migrations'); f.state.oldJournal = true
    await expect(runSchemaMigrations(f.execution, f.control, plan, options)).rejects.toThrow('migration_journal_schema_invalid')
  })
  it('rejects an unknown table even with a valid completed history', async () => {
    const f = fixture()
    await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })
    f.state.tables.add('unexpected')
    await expect(runSchemaMigrations(f.execution, f.control, plan, options)).rejects.toThrow('migration_table_inventory_mismatch')
  })
  it('records a database error without leaking the raw SQL error and blocks replay', async () => {
    const f = fixture({ failDdl: true })
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).rejects.toThrow('migration_statement_failed')
    expect(f.state.history.get(BOOTSTRAP_ID)).toMatchObject({ status: 'failed', completed_statements: 0 })
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).rejects.toThrow('migration_incomplete')
  })
  it('does not replay committed DDL when its checkpoint failed', async () => {
    const f = fixture({ failCheckpoint: true })
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).rejects.toThrow('migration_statement_failed')
    expect(f.state.tables.has('users')).toBe(true)
    f.state.failCheckpoint = false
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).rejects.toThrow('migration_incomplete')
    expect(f.state.executionSql.filter(sql => sql === sql1)).toHaveLength(1)
  })
  it('permits only the verified MySQL 1681 integer-width DDL warning', async () => {
    const f = fixture({ warnings: [{ Code: 1681, Message: 'Integer display width is deprecated and will be removed in a future release.' }] })
    expect(await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).toMatchObject({ status: 'completed' })
    expect(f.state.executionSql.filter(sql => sql === 'SHOW WARNINGS')).toHaveLength(2)
  })
  it('rejects a table-exists warning instead of accepting IF NOT EXISTS drift', async () => {
    const f = fixture({ warnings: [{ Code: 1050, Message: 'table already exists' }] })
    await expect(runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })).rejects.toThrow('migration_statement_warning')
    expect(f.state.history.get(BOOTSTRAP_ID).status).toBe('failed')
  })
  it('rejects checksums, unknown IDs, incomplete checkpoints and history gaps', async () => {
    const f = fixture()
    await runSchemaMigrations(f.execution, f.control, plan, { ...options, apply: true })
    const rows = [...f.state.history.values()]
    expect(() => validateHistory([{ ...rows[0], checksum_sha256: 'a'.repeat(64) }], plan)).toThrow('migration_checksum_mismatch')
    expect(() => validateHistory([{ ...rows[0], id: 'unknown' }], plan)).toThrow('migration_history_unknown')
    expect(() => validateHistory([{ ...rows[0], completed_statements: 0 }], plan)).toThrow('migration_checkpoint_invalid')
    expect(() => validateHistory([rows[1]], plan)).toThrow('migration_history_gap')
    const bad = [plan[0], { ...plan[1], id: '20260904_003_gap' }]
    await expect(runSchemaMigrations(f.execution, f.control, bad, options)).rejects.toThrow('migration_sequence_invalid')
  })
  it('requires explicit CLI target confirmation before any connection and never echoes credentials', () => {
    const env = { ...process.env, V4_MIGRATION_SOURCE_DATABASE: 'source_db', V4_MIGRATION_TARGET_DATABASE: 'test_db', V4_MIGRATION_TARGET_PASSWORD: 'do-not-print-this-secret' }
    const result = spawnSync(process.execPath, ['scripts/migrate-v4-schema.mjs', '--apply', '--confirm-target=wrong'], { cwd: process.cwd(), env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('migration_target_confirmation_required')
    expect(result.stderr).not.toContain(env.V4_MIGRATION_TARGET_PASSWORD)
  })
})

function fixture(overrides = {}) {
  const state = { tables: new Set(), history: new Map(), events: [], locked: false, executionSql: [], ...overrides }
  const identity = id => [[{ db: 'test_db', connection_id: id, server_uuid: 'same-server' }]]
  const execution = { query: async (sql) => {
    state.executionSql.push(sql)
    if (sql.startsWith('SELECT DATABASE()')) return identity(1)
    if (sql.startsWith('SET SESSION')) return [{}]
    if (sql.includes('GET_LOCK')) { const acquired = state.locked ? 0 : 1; state.locked = true; return [[{ acquired }]] }
    if (sql.includes('RELEASE_LOCK')) { state.locked = false; return [[{ released: 1 }]] }
    if (sql === 'SHOW WARNINGS') return [state.warnings]
    if (state.failDdl) throw Object.assign(new Error('raw SQL with private details'), { errno: 1826 })
    const table = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
    if (table) state.tables.add(table)
    return [{ warningStatus: state.warnings?.length ?? 0 }]
  } }
  const control = { query: async (sql, params = []) => {
    if (sql.startsWith('SELECT DATABASE()')) return identity(2)
    if (sql.startsWith('SET SESSION')) return [{}]
    if (sql.includes('FROM information_schema.TABLES')) return [[...state.tables].map(name => ({ name, type: 'BASE TABLE' }))]
    if (sql.includes('FROM information_schema.COLUMNS')) return [state.oldJournal ? [] : sql.includes("TABLE_NAME='schema_migration_events'") ? eventShape() : journalShape()]
    if (sql.startsWith('SELECT migration_id,execution_id')) return [state.events.map(e => ({ ...e }))]
    if (sql.startsWith('CREATE TABLE schema_migration_events')) { state.tables.add('schema_migration_events'); return [{}] }
    if (sql.startsWith('INSERT INTO schema_migration_events')) {
      if (state.failEvent) throw new Error('audit unavailable')
      state.events.push({ migration_id: params[1], execution_id: params[2], kind: params[3], artifact_id: params[4], artifact_sha256: params[5] })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT id,checksum_sha256')) return [[...state.history.values()].map(row => ({ ...row }))]
    if (sql.startsWith('CREATE TABLE schema_migrations')) { state.tables.add('schema_migrations'); return [{}] }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      state.history.set(params[0], { id: params[0], checksum_sha256: params[1], execution_id: params[2], statement_count: params[3], completed_statements: 0, status: 'running' })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE schema_migrations SET completed_statements')) {
      if (state.failCheckpoint) throw new Error('checkpoint lost')
      state.history.get(params[1]).completed_statements = params[0]
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith("UPDATE schema_migrations SET status='completed'")) {
      Object.assign(state.history.get(params[0]), { status: 'completed', completed_at_utc: new Date(), error_code: null })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith("UPDATE schema_migrations SET status='failed'")) { Object.assign(state.history.get(params[1]), { status: 'failed', error_code: params[0] }); return [{ affectedRows: 1 }] }
    throw new Error(`unexpected test query: ${sql}`)
  } }
  return { state, execution, control }
}

function journalShape() {
  return [
    ['id', 'varchar(191)', 'NO', 'PRI'], ['checksum_sha256', 'char(64)', 'NO', ''], ['execution_id', 'char(36)', 'NO', ''],
    ['status', "enum('running','completed','failed')", 'NO', ''], ['statement_count', 'int unsigned', 'NO', ''],
    ['completed_statements', 'int unsigned', 'NO', ''], ['started_at_utc', 'datetime(3)', 'NO', ''],
    ['completed_at_utc', 'datetime(3)', 'YES', ''], ['error_code', 'varchar(64)', 'YES', ''],
  ].map(([name, type, nullable, column_key]) => ({ name, type, nullable, column_key }))
}

function eventShape() {
  return [
    ['id', 'char(36)', 'NO', 'PRI'], ['migration_id', 'varchar(191)', 'NO', 'MUL'], ['execution_id', 'char(36)', 'NO', ''],
    ['kind', "enum('recovery_authorized','correction_started','correction_completed')", 'NO', ''],
    ['artifact_id', 'varchar(191)', 'NO', ''], ['artifact_sha256', 'char(64)', 'NO', ''],
    ['details_json', 'json', 'NO', ''], ['created_at_utc', 'datetime(3)', 'NO', ''],
  ].map(([name, type, nullable, column_key]) => ({ name, type, nullable, column_key }))
}
