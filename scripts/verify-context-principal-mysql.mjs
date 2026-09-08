import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createActivePrincipalAccess } from '../server/dist-v4/modules/auth/composition.js'
import { MysqlContextCommands } from '../server/dist-v4/modules/trading/infrastructure/mysql-context-commands.js'

const destination = process.argv[2]
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection, phase = 'connect'
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.31.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  phase = 'shadow-tables'
  // All three targets are private temporary tables before the first DML. No permanent table is written.
  // Minimal SQL fixtures deliberately do not claim current-schema FK/CHECK or multi-connection coverage.
  await connection.query(`CREATE TEMPORARY TABLE users (id INT PRIMARY KEY, deletion_status VARCHAR(24) NOT NULL,
    deleted_at DATETIME(3) NULL) ENGINE=InnoDB`)
  await connection.query(`CREATE TEMPORARY TABLE trading_contexts (user_id INT PRIMARY KEY, mode VARCHAR(20) NOT NULL,
    trading_account_id BIGINT UNSIGNED NULL, observer_channel_id BIGINT UNSIGNED NULL, read_only TINYINT NOT NULL,
    revision BIGINT UNSIGNED NOT NULL, updated_at_utc DATETIME(3) NOT NULL) ENGINE=InnoDB`)
  await connection.query(`CREATE TEMPORARY TABLE trading_context_changes_v4 (user_id INT NOT NULL, request_id CHAR(36) NOT NULL,
    request_sha256 CHAR(64) NOT NULL, action VARCHAR(30) NOT NULL, target_id VARCHAR(191) NULL,
    prior_revision BIGINT UNSIGNED NOT NULL, revision BIGINT UNSIGNED NOT NULL, result_mode VARCHAR(20) NOT NULL,
    result_account_id VARCHAR(191) NULL, result_observer_channel_id VARCHAR(191) NULL, result_read_only TINYINT NOT NULL,
    recorded_at_utc DATETIME(3) NOT NULL, PRIMARY KEY(user_id,request_id), UNIQUE KEY(user_id,revision)) ENGINE=InnoDB`)
  await connection.query("INSERT INTO users(id,deletion_status) VALUES (42,'active')")
  const calls = [], sqlFailures = []
  const adapter = {
    async execute(sql, params) {
      calls.push(sql.includes('FROM users') ? (sql.endsWith('FOR UPDATE') ? 'user-lock' : 'user-read')
        : sql.includes('INSERT INTO trading_context_changes_v4') ? 'receipt-write'
          : sql.includes('INSERT INTO trading_contexts') ? 'context-write' : 'read')
      try { return await connection.execute(sql, params) }
      catch (error) { sqlFailures.push(error.code); throw error }
    },
    async beginTransaction() { calls.push('begin'); await connection.beginTransaction() },
    async commit() { calls.push('commit'); await connection.commit() },
    async rollback() { calls.push('rollback'); await connection.rollback() },
    destroy() { connection.destroy() }, release() {},
  }
  let resolutions = 0
  const writer = new MysqlContextCommands({ async getConnection() { return adapter } }, async (same, command) => {
    assert.equal(same, adapter); resolutions++
    return { userId: command.userId, mode: 'full', accountId: command.targetId, observerChannelId: null, readOnly: false }
  }, same => { assert.equal(same, adapter); return createActivePrincipalAccess(same) })
  const command = { userId: 42, requestId: randomUUID(), action: 'select_account', targetId: '7', expectedRevision: 0 }
  const checks = []
  phase = 'commit-and-replay'
  const first = await writer.execute(command)
  assert.equal(first.result.revision, 1); assert.equal(first.replayed, false)
  assert.deepEqual(calls.slice(0, 2), ['begin', 'user-lock'])
  assert.equal((await writer.execute(command)).replayed, true)
  assert.equal(resolutions, 1)
  assert.deepEqual((await writer.receipt(42, command.requestId)).result, first.result)
  checks.push('commit-and-replay-with-same-connection-principal-lock')
  phase = 'conflicts'
  await assert.rejects(writer.execute({ ...command, targetId: '8' }), error => error.code === 'trading_context_idempotency_conflict')
  await assert.rejects(writer.execute({ ...command, requestId: randomUUID() }), error => error.code === 'revision_conflict')
  checks.push('changed-body-and-stale-revision-rejected')
  phase = 'receipt-failure-rollback'
  // Occupy the next receipt revision so MySQL itself rejects the second insert after the context update.
  await connection.execute(`INSERT INTO trading_context_changes_v4
    (user_id,request_id,request_sha256,action,target_id,prior_revision,revision,result_mode,result_account_id,result_observer_channel_id,result_read_only,recorded_at_utc)
    VALUES (42,?,?,'select_account','7',1,2,'full','7',NULL,0,UTC_TIMESTAMP(3))`, [randomUUID(), '0'.repeat(64)])
  const failed = { ...command, requestId: randomUUID(), targetId: '8', expectedRevision: 1 }
  calls.length = 0
  await assert.rejects(writer.execute(failed), error => error.code === 'trading_context_write_failed')
  assert.ok(sqlFailures.includes('ER_DUP_ENTRY'))
  assert.ok(calls.indexOf('context-write') < calls.indexOf('receipt-write'))
  assert.equal(calls.at(-1), 'rollback')
  const [[current]] = await connection.query('SELECT revision,trading_account_id accountId FROM trading_contexts WHERE user_id=42')
  assert.equal(Number(current.revision), 1); assert.equal(String(current.accountId), '7')
  assert.equal(await writer.receipt(42, failed.requestId), null)
  checks.push('mysql-receipt-duplicate-rolls-back-context')
  phase = 'revoked-user'
  await connection.query("UPDATE users SET deletion_status='deleted',deleted_at=UTC_TIMESTAMP(3) WHERE id=42")
  await assert.rejects(writer.execute(command), error => error.code === 'trading_account_forbidden')
  await assert.rejects(writer.receipt(42, command.requestId), error => error.code === 'trading_account_forbidden')
  checks.push('revoked-user-cannot-replay-or-read-receipt')
  await output.writeFile(JSON.stringify({ kind: 'context-principal-mysql/v1', observedAt: new Date().toISOString(), identity,
    passed: true, checks, permanentBusinessWrites: 0, temporaryTables: 3,
    scope: 'Compiled auth principal adapter and context commands in real MySQL private temporary InnoDB fixtures. Resolver is synthetic. Does not prove full schema/FKs/CHECKs, lock contention, lost commit acknowledgement, positive observer routing or browser behavior.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, permanentBusinessWrites: 0 }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, phase, code: typeof error?.code === 'string' ? error.code : 'verification_failed' }) + '\n')
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
