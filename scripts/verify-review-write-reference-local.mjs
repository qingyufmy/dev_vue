import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { createReviewWriteCommand, reviewWriteActions } from '../server/dist-v4/modules/reviews/application/review-write-command.js'
import { executeReviewWrite } from '../server/dist-v4/modules/reviews/infrastructure/mysql-review-write-receipts.js'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_review_ref_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_review_ref_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-write-receipt-reference/v1', passed: false, existingDatabaseWrites: 0,
  referenceDatabaseRemoved: false, checks: [],
  scope: 'Real receipt primitive and migration 049; scaffold users/effects; not six domain repositories, history upgrade or restoration proof.' }
const sha = value => createHash('sha256').update(value).digest('hex')
let connection, pool, created = false
try {
  const sql = await readFile(new URL('../server/db/migrations/inplace/049_review_write_receipts.sql', import.meta.url), 'utf8')
  assert.equal(splitSqlStatements(sql).length, 1)
  report.migrationSha256 = sha(sql)
  const artifacts = ['scripts/verify-review-write-reference-local.mjs', 'scripts/run-review-write-reference-local.py',
    'server/dist-v4/modules/reviews/application/review-write-command.js',
    'server/dist-v4/modules/reviews/infrastructure/mysql-review-write-receipts.js',
    'server/dist-v4/modules/reviews/infrastructure/review-transaction.js']
  report.artifacts = await Promise.all(artifacts.map(async path => ({ path, sha256: sha(await readFile(new URL('../' + path, import.meta.url))) })))
  connection = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false })
  const [[server]] = await connection.query('SELECT @@server_uuid uuid,@@version version')
  assert.equal(server.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.serverUuid = server.uuid; report.serverVersion = server.version
  await connection.query(`CREATE DATABASE \`${database}\``); created = true
  await connection.query(`USE \`${database}\``)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query("CREATE TABLE users (id INT PRIMARY KEY,deletion_status VARCHAR(20) NOT NULL,deleted_at DATETIME(3) NULL,write_allowed BOOLEAN NOT NULL) ENGINE=InnoDB")
  await connection.query('CREATE TABLE reference_effects (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, command_key VARCHAR(128) NOT NULL,action VARCHAR(40) NOT NULL) ENGINE=InnoDB')
  await connection.query(sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE review_write_receipts_v4')
  report.canonicalDdl = definition['Create Table']
  await connection.query("INSERT INTO users VALUES (7,'active',NULL,1)")
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 4 })
  let loseAck = false, failReceipt = false
  const wrapped = new Proxy(pool, { get(target, name) {
    if (name === 'getConnection') return async () => {
      const db = await target.getConnection()
      await db.query("SET SESSION time_zone='+00:00'")
      return new Proxy(db, { get(client, method) {
        if (method === 'commit') return async () => { await client.commit(); if (loseAck) { loseAck = false; throw Error('injected_postcommit_ack_loss') } }
        if (method === 'execute') return async (statement, values) => {
          if (failReceipt && statement.startsWith('INSERT INTO review_write_receipts_v4')) { failReceipt = false; throw Error('injected_receipt_insert_failure') }
          return client.execute(statement, values)
        }
        const value = Reflect.get(client, method); return typeof value === 'function' ? value.bind(client) : value
      } })
    }
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value
  } })
  const make = (action, key, body = { value: 'original' }) => createReviewWriteCommand({ actorUserId: 7, action, idempotencyKey: key,
    targetId: action === 'create_manual_case' ? null : 'resource-1', expectedRevision: action === 'create_manual_case' ? null : 1 }, body)
  const run = command => executeReviewWrite(wrapped, command, async db => {
    const [effect] = await db.execute('INSERT INTO reference_effects (command_key,action) VALUES (?,?)', [command.idempotencyKey, command.action])
    return { resourceId: 'resource-1', revision: 2, value: { effectId: String(effect.insertId), action: command.action } }
  }, value => !!value && typeof value === 'object' && typeof value.resourceId === 'string' && Number.isSafeInteger(value.revision)
      && typeof value.value?.effectId === 'string' && value.value?.action === command.action,
  async db => {
    const [[actor]] = await db.execute('SELECT write_allowed FROM users WHERE id=? FOR SHARE', [7])
    if (!actor?.write_allowed) throw Object.assign(new Error('reference_forbidden'), { code: 'reference_forbidden' })
  })
  for (const action of reviewWriteActions) {
    report.stage = action
    const cmd = make(action, `reference-review-${action}`)
    const values = await Promise.all(Array.from({ length: 4 }, () => run(cmd)))
    for (const value of values) assert.deepEqual(value, values[0])
    const [[count]] = await connection.execute('SELECT COUNT(*) quantity FROM reference_effects WHERE command_key=?', [cmd.idempotencyKey])
    assert.equal(count.quantity, 1)
    await assert.rejects(run(make(action, cmd.idempotencyKey, { value: 'changed' })), { code: 'review_idempotency_conflict' })
  }
  report.checks.push('six_action_receipts_four_concurrent_same_key_one_effect_each_and_body_conflict')
  report.stage = 'commit_ack_loss'
  const ack = make('return_case', 'reference-review-ack-loss')
  loseAck = true
  await assert.rejects(run(ack), { code: 'review_commit_unknown' })
  const recovered = await run(ack)
  assert.ok(recovered.value.effectId)
  const [[ackCount]] = await connection.execute('SELECT COUNT(*) quantity FROM reference_effects WHERE command_key=?', [ack.idempotencyKey])
  assert.equal(ackCount.quantity, 1)
  report.checks.push('actual_commit_followed_by_injected_ack_loss_replays_once')
  report.stage = 'rollback'
  const failed = make('return_case', 'reference-review-insert-fail')
  failReceipt = true
  await assert.rejects(run(failed), /injected_receipt_insert_failure/)
  const [[rolledBack]] = await connection.execute('SELECT COUNT(*) quantity FROM reference_effects WHERE command_key=?', [failed.idempotencyKey])
  assert.equal(rolledBack.quantity, 0)
  report.checks.push('receipt_failure_rolls_back_actual_effect')
  await connection.execute('UPDATE users SET write_allowed=0 WHERE id=?', [7])
  await assert.rejects(run(ack), { code: 'reference_forbidden' })
  await connection.execute('UPDATE users SET write_allowed=1 WHERE id=?', [7])
  await connection.execute('UPDATE review_write_receipts_v4 SET result_sha256=? WHERE actor_user_id=? AND idempotency_key=?', ['0'.repeat(64), 7, ack.idempotencyKey])
  await assert.rejects(run(ack), { code: 'review_receipt_invalid' })
  report.checks.push('current_authorization_rechecked_and_corrupt_receipt_not_reexecuted')
  const insert = `INSERT INTO review_write_receipts_v4
    (actor_user_id,idempotency_key,action,request_sha256,resource_id,result_revision,result_json,result_sha256,recorded_at_utc)
    VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`
  for (const [index, value, code] of [[0, 999, 'ER_NO_REFERENCED_ROW_2'], [2, 'invalid', 'ER_CHECK_CONSTRAINT_VIOLATED'],
    [3, 'A'.repeat(64), 'ER_CHECK_CONSTRAINT_VIOLATED'], [5, 0, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    [6, '[]', 'ER_CHECK_CONSTRAINT_VIOLATED'], [1, 'short', 'ER_CHECK_CONSTRAINT_VIOLATED']]) {
    const values = [7, randomUUID(), 'return_case', 'a'.repeat(64), 'resource-1', 2, '{}', 'b'.repeat(64)]
    values[index] = value
    await assert.rejects(connection.execute(insert, values), { code })
  }
  report.checks.push('actual_foreign_key_and_five_check_constraints_reject_invalid_receipts')
  const [[counts]] = await connection.query('SELECT (SELECT COUNT(*) FROM reference_effects) effects,(SELECT COUNT(*) FROM review_write_receipts_v4) receipts')
  assert.deepEqual({ effects: counts.effects, receipts: counts.receipts }, { effects: 7, receipts: 7 })
  report.counts = counts
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'reference_failed'; process.exitCode = 1 }
finally {
  if (pool) await pool.end()
  if (connection) {
    try { if (created) { await connection.query(`DROP DATABASE \`${database}\``); report.referenceDatabaseRemoved = true } }
    catch { report.passed = false; report.cleanupError = true; report.referenceDatabase = database; process.exitCode = 1 }
    await connection.end()
  }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode, stage: report.stage,
    referenceDatabaseRemoved: report.referenceDatabaseRemoved, existingDatabaseWrites: 0 }))
}
