import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'

const destination = process.argv[2]
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection, phase = 'identity'
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.31.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  phase = 'private-temporary-table'
  await connection.query(`CREATE TEMPORARY TABLE users (id INT PRIMARY KEY,plan VARCHAR(20) NOT NULL,
    plan_expires_at DATETIME(3) NULL,token_version INT NOT NULL,deletion_status VARCHAR(24) NOT NULL,deleted_at DATETIME(3) NULL) ENGINE=InnoDB`)
  await connection.query(`INSERT INTO users VALUES
    (1,'pro','2026-09-09 12:30:45.123',7,'active',NULL),
    (2,'free',NULL,0,'active',NULL),
    (3,'plus',NULL,1,'deleted',NULL),
    (4,'pro',NULL,2,'active','2026-09-08 00:00:00.000')`)
  const reader = createAccountPrincipalReader(connection)
  const checks = []
  phase = 'snapshot-facts'
  await connection.beginTransaction()
  const facts = await reader.readMany([4, 3, 2, 1, 1, 5], 'none')
  assert.deepEqual([...facts.keys()], [1, 2])
  assert.deepEqual(facts.get(1), { userId: 1, plan: 'pro', planExpiresAtUtc: '2026-09-09T12:30:45.123Z', tokenVersion: 7 })
  assert.deepEqual(facts.get(2), { userId: 2, plan: 'free', planExpiresAtUtc: null, tokenVersion: 0 })
  checks.push('active-only-deduplicated-facts-with-utc-milliseconds')
  assert.deepEqual(await reader.readMany([1, 2, 3, 4], 'share'), facts)
  await connection.rollback()
  checks.push('shared-lock-read-on-caller-transaction')
  phase = 'malformed-version'
  await connection.query('UPDATE users SET token_version=-1 WHERE id=1')
  await assert.rejects(reader.readMany([1], 'none'), /^Error: auth_principal_unavailable$/)
  checks.push('negative-identity-version-rejected')
  await output.writeFile(JSON.stringify({ kind: 'account-principal-facts-mysql/v1', observedAt: new Date().toISOString(),
    identity, passed: true, checks, permanentBusinessWrites: 0, temporaryTables: 1,
    scope: 'Compiled auth principal facts reader in a private temporary InnoDB users fixture. Does not prove observer integration, cross-domain snapshot consistency, concurrent user locks or browser authorization.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, permanentBusinessWrites: 0 }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, phase, code: 'principal_facts_verification_failed' }) + '\n')
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
