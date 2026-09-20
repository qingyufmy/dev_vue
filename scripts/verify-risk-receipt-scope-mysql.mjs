import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { MysqlRiskRepository } from '../server/dist-v4/modules/risk/infrastructure/mysql-risk-repository.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254')
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
let identity, missingTables = []
const checks = []
try {
  connection = await pool.getConnection()
  const [identityRows] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  identity = identityRows[0]
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  const requiredTables = ['risk_manual_releases', 'trading_account_ownerships']
  const [tables] = await connection.query(`SELECT TABLE_NAME name FROM information_schema.tables
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('risk_manual_releases','trading_account_ownerships')`)
  missingTables = requiredTables.filter(name => !tables.some(row => row.name === name))
  assert.deepEqual(missingTables, [])
  // Preserve actual columns/indexes; only these session-local tables receive fixture writes.
  for (const table of requiredTables) {
    await connection.query(`CREATE TEMPORARY TABLE local_probe_${table} LIKE ${table}`)
    await connection.query(`ALTER TABLE local_probe_${table} RENAME TO ${table}`)
  }
  await connection.beginTransaction()
  const repository = new MysqlRiskRepository({ execute: (...args) => connection.execute(...args) })
  await connection.query(`INSERT INTO trading_account_ownerships
    (user_id,trading_account_id,role,granted_at_utc,revoked_at_utc) VALUES
    (41,7,'owner','2026-09-01','2026-09-02'),(42,7,'owner','2026-09-02',NULL),
    (42,8,'owner','2026-09-02',NULL),(43,7,'observer_source','2026-09-02',NULL)`)
  const insert = async (userId, id, fingerprint) => connection.execute(`INSERT INTO risk_manual_releases
    (id,user_id,trading_account_id,platform_policy_version_id,policy_set_revision,risk_state_revision,
     released_rules_json,baseline_json,breach_fingerprint,reason,idempotency_key,request_sha256,
     status,expires_at_utc,created_at_utc,revision)
    VALUES (?,?,7,1,1,1,'[]','{}',?,'Local fixture','scope-probe-key',REPEAT('a',64),'expired','2026-09-03','2026-09-02',1)`,
  [id, userId, fingerprint.repeat(64)])
  await insert(41, 'old-owner-receipt', 'b')
  assert.equal(await repository.getManualReleaseByIdempotency(42, '7', 'scope-probe-key'), null)
  checks.push('new-owner-cannot-replay-old-owner-receipt')
  assert.equal(await repository.getManualReleaseByIdempotency(41, '7', 'scope-probe-key'), null)
  checks.push('revoked-owner-cannot-read-receipt')
  await insert(42, 'current-owner-receipt', 'c')
  const receipt = await repository.getManualReleaseByIdempotency(42, '7', 'scope-probe-key')
  assert.equal(receipt.release.id, 'current-owner-receipt')
  assert.equal(receipt.release.userId, 42)
  assert.equal(receipt.release.status, 'expired')
  assert.equal(receipt.requestHash, 'a'.repeat(64))
  checks.push('same-key-distinct-users-selects-exact-receipt-including-expired')
  assert.equal(await repository.getManualReleaseByIdempotency(42, '8', 'scope-probe-key'), null)
  assert.equal(await repository.getManualReleaseByIdempotency(42, '7', 'different-key'), null)
  checks.push('account-and-key-isolation')
  assert.equal(await repository.getManualReleaseByIdempotency(43, '7', 'scope-probe-key'), null)
  checks.push('observer-cannot-read-owner-receipt')
  await connection.rollback()
  const [[remaining]] = await connection.query('SELECT COUNT(*) n FROM risk_manual_releases')
  assert.equal(Number(remaining.n), 0)
  checks.push('fixture-writes-rolled-back')
  await output.writeFile(JSON.stringify({ passed: true, kind: 'risk-receipt-scope-mysql/v1', observedAt: new Date().toISOString(), identity, checks,
    scope: 'Unmodified compiled repository query on session-local LIKE tables. No permanent writes. LIKE does not copy foreign keys. Read isolation only, not concurrent commit, HTTP or frontend recovery validation.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, identity, missingTables, checks, code: 'risk_receipt_scope_probe_failed',
    failureKind: error instanceof assert.AssertionError ? 'assertion' : 'storage', driverCode: error.code }) + '\n')
  console.log(JSON.stringify({ passed: false, code: 'risk_receipt_scope_probe_failed', driverCode: error.code }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool.end()
  await output.sync()
  await output.close()
}
