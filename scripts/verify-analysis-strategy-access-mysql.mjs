import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAnalysisStrategyAccess } from '../server/dist-v4/modules/strategies/composition.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection
const checks = []
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  // Session-local shadow: all fixture DDL/DML affects only this connection's temporary table.
  await connection.query(`CREATE TEMPORARY TABLE strategies (
    id BIGINT UNSIGNED PRIMARY KEY,kind VARCHAR(32),scope VARCHAR(32),owner_user_id INT,
    status VARCHAR(32),active_version_id BIGINT UNSIGNED NULL,deleted_at_utc DATETIME(3) NULL
  ) ENGINE=InnoDB`)
  await connection.beginTransaction()
  const cases = [
    ['1', 'analysis', 'platform', 9, 'active', '1', null, true, 'platform-analysis'],
    ['2', 'analysis', 'personal', 7, 'active', '1', null, true, 'owned-analysis'],
    ['3', 'analysis', 'personal', 9, 'active', '1', null, false, 'other-user-denied'],
    ['4', 'execution', 'platform', 7, 'active', '1', null, false, 'execution-denied'],
    ['5', 'analysis', 'platform', 7, 'disabled', '1', null, false, 'disabled-denied'],
    ['6', 'analysis', 'platform', 7, 'active', null, null, false, 'unpublished-denied'],
    ['7', 'analysis', 'platform', 7, 'active', '1', '2026-09-09 00:00:00.000', false, 'deleted-denied'],
    ['18446744073709551615', 'analysis', 'personal', 7, 'active', '1', null, true, 'unsigned-bigint-preserved'],
  ]
  const access = createAnalysisStrategyAccess(connection)
  for (const row of cases) {
    await connection.execute('INSERT INTO strategies (id,kind,scope,owner_user_id,status,active_version_id,deleted_at_utc) VALUES (?,?,?,?,?,?,?)', row.slice(0, 7))
    assert.equal(await access.canUse(7, row[0]), row[7])
    checks.push(row[8])
  }
  assert.equal(await access.canUse(7, '999'), false)
  checks.push('missing-denied')
  await connection.rollback()
  const [[remaining]] = await connection.query('SELECT COUNT(*) n FROM strategies')
  assert.equal(Number(remaining.n), 0)
  checks.push('fixture-inserts-rolled-back')
  await connection.query('DROP TEMPORARY TABLE strategies')
  await output.writeFile(JSON.stringify({ kind: 'analysis-strategy-access-mysql/v1', passed: true,
    observedAt: new Date().toISOString(), identity, checks,
    scope: 'Real MySQL predicates using a session-local temporary strategies table and compiled capability. No permanent table writes, schema migration, runtime restart, HTTP/browser or cross-connection lock proof.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, code: 'analysis_strategy_access_verification_failed', checks }) + '\n')
  process.exitCode = 1
  console.log(JSON.stringify({ passed: false, checks: checks.length }))
} finally {
  // Destroying the exact connection also removes its temporary table on failure.
  connection?.destroy()
  await pool?.end()
  await output.sync(); await output.close()
}
