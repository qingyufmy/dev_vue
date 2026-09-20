import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { loadMigrationPlan, sha256 } from './lib/v4-migration-plan.mjs'
import { loadCorrectedBridgeInstallationUpgrade } from './lib/bridge-installation-corrected-upgrade.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'

const root = new URL('../', import.meta.url)
const args = process.argv.slice(2)
const apply = args[0] === '--apply-dev-vue'
assert.ok(args.length === 0 || apply && args.length === 2, 'market_upgrade_arguments_invalid')
const id = 'inplace_081_01_market_source_selections'
const plan = await loadMigrationPlan({ rootDirectory: resolve('.') })
const migration = plan.find(m => m.id === '20260914_029_market_source_selections')
assert.ok(migration && migration.statements.length === 1, 'market_migration_source_invalid')
assert.match(migration.statements[0], /^CREATE TABLE IF NOT EXISTS market_source_selections /)
const checksum = sha256(JSON.stringify({ id, migrationId: migration.id, migrationChecksum: migration.checksum }))
const prior = await loadCorrectedBridgeInstallationUpgrade(root)
const env = parse(await readFile(new URL('server/.env', root)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue'); assert.equal(Number(env.MYSQL_PORT), 3306)
const db = await mysql.createConnection({ host: env.MYSQL_HOST, port: 3306, user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: 'dev_vue', timezone: 'Z', multipleStatements: false })
const report = { id, checksum, migrationChecksum: migration.checksum, target: '192.168.1.254:3306/dev_vue', apply, ddlExecuted: false, status: 'pending' }
let locked = false
async function tableExists() {
  const [rows] = await db.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['market_source_selections'])
  return rows.length === 1
}
async function verifyTable() {
  const [columns] = await db.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLLATION_NAME collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['market_source_selections'])
  assert.deepEqual(columns.map(c => [c.name, c.type, c.nullable, c.collation]), [
    ['pool_key', 'varchar(40)', 'NO', 'ascii_bin'], ['standard_symbol', 'varchar(64)', 'NO', 'ascii_bin'],
    ['revision', 'bigint unsigned', 'NO', null], ['source_generation', 'bigint unsigned', 'NO', null],
    ['state_json', 'json', 'NO', null], ['updated_at_utc', 'datetime(3)', 'NO', null],
  ], 'market_table_columns_conflict')
  const [indexes] = await db.execute('SELECT INDEX_NAME name,COLUMN_NAME columnName,NON_UNIQUE nonUnique,SUB_PART subPart FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', ['market_source_selections'])
  assert.deepEqual(indexes.map(i => [i.name, i.columnName, i.nonUnique, i.subPart]), [['PRIMARY', 'pool_key', 0, null], ['PRIMARY', 'standard_symbol', 0, null]])
  const [[table]] = await db.execute('SELECT ENGINE engine,TABLE_COLLATION collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['market_source_selections'])
  assert.deepEqual([table.engine, table.collation], ['InnoDB', 'utf8mb4_unicode_ci'])
  const [triggers] = await db.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', ['market_source_selections'])
  assert.equal(triggers.length, 0)
}
try {
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query("SET SESSION time_zone='+00:00'")
  await db.query('SET SESSION lock_wait_timeout=10')
  const [[lock]] = await db.execute('SELECT GET_LOCK(?,0) acquired', ['aurum:inplace:dev_vue'])
  assert.equal(Number(lock.acquired), 1); locked = true
  assert.equal(await verifyInplaceJournal(db), true)
  const [history] = await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  const byId = new Map(history.map(row => [row.id, row]))
  assert.ok(prior.steps.every(step => byId.get(step.id)?.checksum === step.checksum && byId.get(step.id)?.status === 'completed'), 'market_prior_upgrade_incomplete')
  assert.ok(history.every(row => row.id === id || prior.steps.some(step => step.id === row.id)), 'market_unknown_upgrade')
  const existing = byId.get(id), exists = await tableExists()
  if (existing) assert.equal(existing.checksum, checksum, 'market_migration_checksum_changed')
  if (!existing) assert.equal(exists, false, 'market_unmanaged_table_exists')
  if (exists) await verifyTable()
  if (existing?.status === 'completed') { assert.ok(exists); report.status = 'already_completed' }
  else if (apply) {
    if (!existing) await db.execute("INSERT INTO database_upgrade_steps_v4 (id,checksum_sha256,status,started_at_utc) VALUES (?,?,'started',UTC_TIMESTAMP(3))", [id, checksum])
    if (!exists) { await db.query(migration.statements[0]); report.ddlExecuted = true }
    await verifyTable()
    const [completed] = await db.execute("UPDATE database_upgrade_steps_v4 SET status='completed',completed_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND checksum_sha256=? AND status='started'", [id, checksum])
    assert.equal(completed.affectedRows, 1)
    report.status = 'completed'
  }
  if (apply) await writeFile(resolve(args[1]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report))
} finally {
  if (locked) await db.execute('SELECT RELEASE_LOCK(?)', ['aurum:inplace:dev_vue'])
  await db.end()
}
