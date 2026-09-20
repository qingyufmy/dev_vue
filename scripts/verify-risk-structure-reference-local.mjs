import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadRiskStructureMigration } from './lib/inplace-risk-structure.mjs'
import { readRiskStructureTable } from './lib/mysql-risk-structure-state.mjs'
import { freezeRiskStructureTools } from './lib/mysql-risk-structure-store.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.user === 'root' && Number.isInteger(credential.port)
  && credential.port > 1024 && credential.port < 65536)
const database = 'dev_vue_risk_reference_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_risk_reference_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
let connection, created = false
const checks = [], definitions = []
try {
  connection = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false, connectTimeout: 5000 })
  const [[server]] = await connection.query('SELECT @@server_uuid serverUuid,@@version version')
  assert.equal(server.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const root = new URL('../', import.meta.url), plan = await loadRiskStructureMigration(root)
  await connection.query('CREATE DATABASE `' + database + '`')
  created = true
  await connection.query('USE `' + database + '`')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('CREATE TABLE users (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('CREATE TABLE trading_accounts (id BIGINT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  for (const step of plan.additions) {
    const before = await readRiskStructureTable(connection, step.table)
    await connection.query(step.sql)
    const after = await readRiskStructureTable(connection, step.table)
    assert.equal(after.rows, 0)
    definitions.push({ stepId: step.id, stepChecksum: step.checksum, beforeHash: before?.hash ?? null,
      afterHash: after.hash, canonicalDdl: after.ddl })
  }
  checks.push('eight-ddl-transitions-with-enforced-foreign-keys')
  await connection.query('INSERT INTO users VALUES (42),(43)')
  await connection.query('INSERT INTO trading_accounts VALUES (7),(8)')
  await connection.query(`INSERT INTO risk_policy_sets_v4
    (id,scope,owner_user_id,trading_account_id,name,status,created_at_utc,updated_at_utc)
    VALUES (1,'platform',NULL,NULL,'Reference platform','active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)),
    (2,'account',42,7,'Reference account','active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`)
  await connection.query(`INSERT INTO risk_policy_versions_v4
    (id,policy_set_id,version_number,policy_json,policy_sha256,change_reason,created_at_utc)
    VALUES (1,1,1,'{}',REPEAT('a',64),'Reference',UTC_TIMESTAMP(3)),(2,2,1,'{}',REPEAT('b',64),'Reference',UTC_TIMESTAMP(3))`)
  const rejects = async (name, sql, params, code) => {
    await assert.rejects(connection.execute(sql, params), error => error.code === code)
    checks.push(name)
  }
  await rejects('active-version-must-belong-to-set', 'UPDATE risk_policy_sets_v4 SET active_version_id=2 WHERE id=1', [], 'ER_NO_REFERENCED_ROW_2')
  await connection.query('UPDATE risk_policy_sets_v4 SET active_version_id=1 WHERE id=1')
  checks.push('matching-active-version-accepted')
  await rejects('account-scope-requires-account', `INSERT INTO risk_policy_sets_v4
    (scope,owner_user_id,name,status,created_at_utc,updated_at_utc) VALUES ('account',42,'Invalid','active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [], 'ER_CHECK_CONSTRAINT_VIOLATED')
  const insertRelease = `INSERT INTO risk_manual_releases
    (id,user_id,trading_account_id,platform_policy_version_id,policy_set_revision,risk_state_revision,released_rules_json,
     baseline_json,breach_fingerprint,reason,idempotency_key,request_sha256,expires_at_utc,created_at_utc)
    VALUES (?,?,7,1,1,1,'[]','{}',?,'Reference','reference-key',REPEAT('a',64),'2026-09-10','2026-09-09 01:02:03.123')`
  await connection.execute(insertRelease, [randomUUID(), 42, 'a'.repeat(64)])
  await rejects('same-user-account-key-is-unique', insertRelease, [randomUUID(), 42, 'b'.repeat(64)], 'ER_DUP_ENTRY')
  await connection.execute(insertRelease, [randomUUID(), 43, 'b'.repeat(64)])
  checks.push('different-user-can-use-same-key')
  await rejects('account-breach-episode-is-unique', insertRelease, [randomUUID(), 43, 'a'.repeat(64)], 'ER_DUP_ENTRY')
  await rejects('release-user-must-exist', insertRelease, [randomUUID(), 999, 'c'.repeat(64)], 'ER_NO_REFERENCED_ROW_2')
  const [[saved]] = await connection.query('SELECT created_at_utc FROM risk_manual_releases WHERE user_id=42')
  assert.equal(saved.created_at_utc.toISOString(), '2026-09-09T01:02:03.123Z')
  checks.push('utc-millisecond-retained')
  await connection.query('DROP DATABASE `' + database + '`')
  created = false
  await output.writeFile(JSON.stringify({ kind: 'risk-structure-reference/v1', observedAt: new Date().toISOString(),
    identity: { database: 'dev_vue', serverUuid: server.serverUuid }, serverVersion: server.version,
    registryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))), definitions,
    tools: await freezeRiskStructureTools(root), checks, referenceDatabaseRemoved: true, existingDatabaseWrites: 0,
    scope: 'Isolated reference database with typed parent stubs and actual foreign keys. Not current dev_vue upgrade, historical data restore, or API/receipt concurrency acceptance.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, definitions: definitions.length, referenceDatabaseRemoved: true }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, checks, code: 'risk_reference_failed',
    driverCode: /^ER_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : undefined }) + '\n')
  console.log(JSON.stringify({ passed: false, code: 'risk_reference_failed' }))
  process.exitCode = 1
} finally {
  try {
    if (created) await connection.query('DROP DATABASE `' + database + '`')
  } finally {
    if (connection) await connection.end()
    await output.sync(); await output.close()
  }
}
