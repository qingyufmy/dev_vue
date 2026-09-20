import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { MysqlObserverAccessReader } from '../server/dist-v4/modules/trading/infrastructure/mysql-observer-access-reader.js'
import { createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'

const destination = process.argv[2]
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection, phase = 'identity'
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  phase = 'private-temporary-tables'
  const definitions = {
    users: 'id INT PRIMARY KEY,plan VARCHAR(20),plan_expires_at DATETIME(3),token_version INT,deletion_status VARCHAR(24),deleted_at DATETIME(3)',
    observer_channels: 'id INT PRIMARY KEY,display_name VARCHAR(100),source_id INT,source_trading_account_id INT,slug VARCHAR(100),active INT,audience VARCHAR(20),revision INT',
    observer_sources: 'id INT PRIMARY KEY,trading_account_id INT,revision INT,status VARCHAR(20),configuration_status VARCHAR(20),operator_user_id INT',
    trading_accounts: 'id INT PRIMARY KEY,ownership_revision INT,deleted_at_utc DATETIME(3)',
    observer_channel_accesses: 'observer_channel_id INT,user_id INT,granted_at_utc DATETIME(3),revoked_at_utc DATETIME(3),revision INT',
    trading_account_ownerships: 'trading_account_id INT,user_id INT,interval_id INT,role VARCHAR(20),revoked_at_utc DATETIME(3),revision INT,granted_at_utc DATETIME(3)',
    trading_account_ownership_intervals: 'id INT PRIMARY KEY,user_id INT,trading_account_id INT,role VARCHAR(20),ended_at_utc DATETIME(3),started_at_utc DATETIME(3)',
  }
  // Fixed code-owned table identifiers. Shadow every target before the first fixture write.
  for (const [name, columns] of Object.entries(definitions)) await connection.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`)
  await connection.query("INSERT INTO users VALUES (9,'plus','2026-09-05 08:00:10.123',7,'active',NULL),(42,'free',NULL,0,'active',NULL)")
  await connection.query("INSERT INTO observer_channels VALUES (12,'Observer',13,7,'gold',1,'plus',3)")
  await connection.query("INSERT INTO observer_sources VALUES (13,7,2,'active','ready',42)")
  await connection.query('INSERT INTO trading_accounts VALUES (7,4,NULL)')
  await connection.query("INSERT INTO trading_account_ownerships VALUES (7,42,1,'owner',NULL,4,'2026-09-01 00:00:00.000')")
  await connection.query("INSERT INTO trading_account_ownership_intervals VALUES (1,42,7,'owner',NULL,'2026-09-01 00:00:00.000')")
  const reader = new MysqlObserverAccessReader(connection, createAccountPrincipalReader(connection), () => new Date('2026-09-05T08:00:00.000Z'))
  const checks = []
  phase = 'positive-member'
  await connection.beginTransaction()
  const authorization = await reader.authorizeOn(connection, 9, '12', '7')
  assert.equal(authorization?.userTokenVersion, 7)
  assert.equal(authorization?.expiresAtUtc, '2026-09-05T08:00:10.123Z')
  assert.equal(authorization?.ownershipRevision, '4')
  await connection.rollback()
  checks.push('positive-shared-authorization-with-membership-expiry-and-version')
  phase = 'operator-revoked'
  await connection.query("UPDATE users SET deletion_status='disabled' WHERE id=42")
  assert.equal(await reader.authorize(9, '12'), null)
  await connection.query("UPDATE users SET deletion_status='active' WHERE id=42")
  checks.push('inactive-operator-rejected')
  phase = 'expired-viewer'
  await connection.query("UPDATE users SET plan_expires_at='2026-09-05 07:59:59.000' WHERE id=9")
  assert.equal(await reader.authorize(9, '12'), null)
  checks.push('expired-membership-rejected')
  phase = 'explicit-grant'
  await connection.query("INSERT INTO observer_channel_accesses VALUES (12,9,'2026-09-01 00:00:00.000',NULL,8)")
  const granted = await reader.authorize(9, '12')
  assert.equal(granted?.accessRevision, '8')
  assert.equal(granted?.expiresAtUtc, '2026-09-05T08:00:30.000Z')
  checks.push('explicit-grant-preserves-original-membership-override')
  await connection.query("UPDATE users SET deletion_status='disabled' WHERE id=9")
  assert.equal(await reader.authorize(9, '12'), null)
  checks.push('inactive-viewer-cannot-use-explicit-grant')
  await output.writeFile(JSON.stringify({ kind: 'observer-principal-composition-mysql/v1', observedAt: new Date().toISOString(),
    identity, passed: true, checks, permanentBusinessWrites: 0, temporaryTables: 7,
    scope: 'Compiled observer and auth readers over seven private temporary InnoDB fixtures. Positive SQL authorization, expiry, revocation and grants are covered. Does not prove full schema constraints, concurrent cross-connection snapshots, permanent observer routing or browser behavior.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, permanentBusinessWrites: 0 }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, phase, code: 'principal_facts_verification_failed' }) + '\n')
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
