import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { mapLegacyRiskControl } from './lib/risk-legacy-control-mapping.mjs'
import { backfillRiskControl } from './lib/risk-control-backfill.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_control_reference_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_control_reference_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
const checks = [], artifacts = []
let connection, pool, created = false
try {
  connection = await mysql.createConnection({ ...credential, timezone: 'Z' })
  const [[server]] = await connection.query('SELECT @@server_uuid uuid')
  assert.equal(server.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await connection.query(`CREATE DATABASE \`${database}\``); created = true
  await connection.query(`USE \`${database}\``)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('CREATE TABLE users (id INT PRIMARY KEY) ENGINE=InnoDB')
  await connection.query(`CREATE TABLE global_risk_control (id INT PRIMARY KEY,global_kill_switch TINYINT,
    reason VARCHAR(1000),changed_by INT,updated_at DATETIME) ENGINE=InnoDB`)
  const files = ['server/db/migrations/inplace/003_identity_migration_tables.sql',
    'server/db/migrations/inplace/005_source_row_evidence.sql', 'server/db/migrations/20260903_007_deterministic_risk_review.sql']
  const wanted = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches',
    'data_migration_row_receipts', 'data_migration_source_rows', 'global_risk_controls']
  let ddlCount = 0
  for (const file of files) {
    const sql = await readFile(new URL('../' + file, import.meta.url), 'utf8')
    artifacts.push({ file, sha256: createHash('sha256').update(sql).digest('hex') })
    for (const statement of splitSqlStatements(sql)) {
      const match = /CREATE TABLE (?:IF NOT EXISTS )?`?([a-z_]+)`?\s*\(/i.exec(statement)
      if (match && wanted.includes(match[1])) { await connection.query(statement); ddlCount++ }
    }
  }
  assert.equal(ddlCount, wanted.length)
  await connection.query('INSERT INTO users VALUES (7)')
  await connection.query("INSERT INTO global_risk_control VALUES (1,1,'fixture',7,'2026-09-09 08:00:00')")
  const source = { id: 1, global_kill_switch: 1, reason: 'fixture', changed_by: 7, updated_at: '2026-09-09 08:00:00' }
  const spec = { runId: randomUUID(), sourceSha256: mapLegacyRiskControl([source], new Set(['7'])).sourceSha256,
    bindings: { kind: 'risk-control-backfill/v1', database, serverUuid: server.uuid } }
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', connectionLimit: 2 })
  const verify = async (c, bindings) => {
    const [[actual]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz')
    assert.equal(actual.db, bindings.database); assert.equal(actual.uuid, bindings.serverUuid); assert.equal(actual.tz, '+00:00')
  }
  const repository = new MysqlBackfillRepository(pool)
  const count = async table => { assert.ok(wanted.includes(table)); const [[row]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``); return Number(row.n) }
  // Failing the actual archive INSERT must roll back its already executed parent writes.
  const failRepository = { transaction: work => repository.transaction(tx => {
    const original = tx.connection.execute.bind(tx.connection)
    tx.connection.execute = async (sql, args) => {
      if (sql.includes('INSERT INTO data_migration_source_rows')) throw Error('injected_archive_failure')
      return original(sql, args)
    }
    return work(tx).finally(() => { tx.connection.execute = original })
  }) }
  await assert.rejects(backfillRiskControl(failRepository, spec, verify), error => error.code === 'backfill_storage_failed')
  for (const table of wanted) assert.equal(await count(table), 0)
  checks.push('archive_failure_real_transaction_rollback')
  const lostPool = { async getConnection() {
    const c = await pool.getConnection(), original = c.commit.bind(c)
    c.commit = async () => { await original(); throw Error('injected_commit_response_loss') }
    return c
  } }
  await assert.rejects(backfillRiskControl(new MysqlBackfillRepository(lostPool), spec, verify), error => error.code === 'backfill_commit_unknown')
  assert.equal((await backfillRiskControl(repository, spec, verify)).replay, true)
  for (const table of wanted) assert.equal(await count(table), 1)
  checks.push('commit_response_loss_exact_replay_one_row_each')
  const [[target]] = await connection.query("SELECT kill_switch,changed_by_user_id,DATE_FORMAT(updated_at_utc,'%Y-%m-%d %H:%i:%s.%f') utc FROM global_risk_controls")
  assert.equal(target.kill_switch, 1); assert.equal(target.changed_by_user_id, 7); assert.equal(target.utc, '2026-09-09 08:00:00.000000')
  checks.push('control_actor_and_utc_roundtrip')
  await connection.query('UPDATE global_risk_controls SET revision=2,kill_switch=0 WHERE id=1')
  assert.equal((await backfillRiskControl(repository, spec, verify)).replay, true)
  const [[changed]] = await connection.query('SELECT revision,kill_switch FROM global_risk_controls')
  assert.equal(Number(changed.revision), 2); assert.equal(changed.kill_switch, 0)
  checks.push('replay_preserves_subsequent_v4_update')
  await assert.rejects(backfillRiskControl(repository, { ...spec, runId: randomUUID() }, verify), error => error.code === 'risk_control_target_occupied')
  assert.equal(await count('data_migration_runs'), 1)
  checks.push('different_run_cannot_overwrite_target')
  await connection.query("UPDATE global_risk_control SET reason='drifted' WHERE id=1")
  await assert.rejects(backfillRiskControl(repository, { ...spec, runId: randomUUID() }, verify), error => error.code === 'risk_control_source_drift')
  assert.equal(await count('data_migration_runs'), 1)
  checks.push('source_drift_rejects_and_rolls_back_new_run')
  const [[archive]] = await connection.query('SELECT source_payload_json FROM data_migration_source_rows')
  assert.deepEqual(typeof archive.source_payload_json === 'string' ? JSON.parse(archive.source_payload_json) : archive.source_payload_json, source)
  checks.push('archived_source_preserved_after_legacy_change')
  for (const file of ['scripts/lib/risk-control-backfill.mjs', 'scripts/lib/risk-legacy-control-mapping.mjs',
    'scripts/lib/v4-backfill-mysql-repository.mjs', 'scripts/verify-risk-control-backfill-local.mjs']) {
    artifacts.push({ file, sha256: createHash('sha256').update(await readFile(new URL('../' + file, import.meta.url))).digest('hex') })
  }
  await pool.end(); pool = null
  await connection.query(`DROP DATABASE \`${database}\``); created = false
  const report = { kind: 'risk-control-backfill-reference/v1', passed: true, serverUuid: server.uuid, checks, artifacts,
    temporaryDatabaseRemoved: true, currentDatabaseWrites: 0 }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  console.log(JSON.stringify({ passed: false, code: error.code ?? 'risk_control_reference_failed' }))
  await output.writeFile(JSON.stringify({ passed: false, code: error.code ?? 'risk_control_reference_failed', checks }) + '\n')
  process.exitCode = 1
} finally {
  if (pool) await pool.end()
  if (connection && created) await connection.query(`DROP DATABASE \`${database}\``)
  if (connection) await connection.end()
  await output.sync(); await output.close()
}
