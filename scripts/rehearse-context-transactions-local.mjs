import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { MysqlContextCommands } from '../server/dist-v4/modules/trading/infrastructure/mysql-context-commands.js'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'

const root = new URL('../', import.meta.url), [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString())
assert.ok(credential.host === '127.0.0.1' && credential.user === 'root' && Number.isInteger(credential.port) && credential.port > 1024 && credential.port < 65536)
const database = 'dev_vue_context_tx_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_context_tx_[0-9a-f]{32}$/)
let connection, pool, created = false
const checks = []
try {
  connection = await mysql.createConnection({ host: credential.host, port: credential.port, user: credential.user, password: credential.password, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await connection.query('SELECT @@server_uuid serverUuid,@@version version')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await connection.query('CREATE DATABASE `' + database + '`'); created = true
  await connection.query('USE `' + database + '`')
  await connection.query('CREATE TABLE users (id INT NOT NULL PRIMARY KEY,deletion_status VARCHAR(16) NOT NULL,deleted_at DATETIME(3) NULL) ENGINE=InnoDB')
  await connection.query("INSERT INTO users (id,deletion_status) VALUES (42,'active'),(43,'active'),(44,'active'),(45,'active')")
  await connection.query('CREATE TABLE trading_accounts (id BIGINT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('INSERT INTO trading_accounts VALUES (7),(8)')
  await connection.query('CREATE TABLE observer_channels (id BIGINT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('INSERT INTO observer_channels VALUES (12)')
  const contextSource = await readFile(new URL('server/db/migrations/inplace/037_observer_context_tables.sql', root), 'utf8')
  const contextDdl = splitSqlStatements(contextSource).find(sql => sql.startsWith('CREATE TABLE `trading_contexts` ('))
  assert.ok(contextDdl)
  await connection.query(contextDdl)
  const receiptSource = await readFile(new URL('server/db/migrations/inplace/041_trading_context_changes.sql', root), 'utf8')
  await connection.query(receiptSource)
  pool = createMysqlPool({ host: credential.host, port: credential.port, user: credential.user, password: credential.password, database, poolSize: 4 })
  const resolver = async (_connection, c) => ({ userId: c.userId, mode: c.action === 'enter_observer' ? 'observer' : c.action === 'leave_observer' ? 'blocked' : 'full',
    accountId: c.action === 'select_account' ? c.targetId : null, observerChannelId: c.action === 'enter_observer' ? c.targetId : null, readOnly: c.action !== 'select_account' })
  const parallelConnections = []
  const barrier = () => { let release; return { ids: [], gate: new Promise(resolve => { release = resolve }), release: () => release() } }
  let nextBarrier = barrier()
  const observedPool = { async getConnection() {
    const rendezvous = nextBarrier
    const actual = await pool.getConnection()
    if (rendezvous) {
      const [[row]] = await actual.query('SELECT CONNECTION_ID() id')
      rendezvous.ids.push(Number(row.id))
      if (rendezvous.ids.length === 2) {
        nextBarrier = null
        parallelConnections.push(new Set(rendezvous.ids).size)
        rendezvous.release()
      }
      await rendezvous.gate
    }
    return actual
  } }
  const writer = new MysqlContextCommands(observedPool, resolver)
  const command = (userId, expectedRevision = 0, targetId = '7') => ({ userId, requestId: randomUUID(), action: 'select_account', targetId, expectedRevision })
  const first = command(42)
  const same = await Promise.all([writer.execute(first), writer.execute(first)])
  assert.deepEqual(same.map(row => row.replayed).sort(), [false, true])
  assert.ok(same.every(row => row.result.revision === 1))
  checks.push({ name: 'concurrent-first-write-same-key-one-receipt', passed: true })
  await assert.rejects(writer.execute({ ...first, targetId: '8' }), error => error.code === 'trading_context_idempotency_conflict')
  checks.push({ name: 'same-key-different-body-conflict', passed: true })
  nextBarrier = barrier()
  const distinct = await Promise.allSettled([writer.execute(command(43)), writer.execute(command(43, 0, '8'))])
  assert.equal(distinct.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(distinct.find(row => row.status === 'rejected').reason.code, 'revision_conflict')
  checks.push({ name: 'concurrent-first-write-different-keys-one-revision', passed: true })

  assert.deepEqual(parallelConnections, [2, 2])
  let loseAck = true, corruptReceipt = false
  const faultPool = { async getConnection() {
    const actual = await pool.getConnection()
    return new Proxy(actual, { get(target, key) {
      if (key === 'commit') return async () => { await target.commit(); if (loseAck) { loseAck = false; throw Error('injected-commit-ack-loss') } }
      if (key === 'execute') return async (sql, values) => {
        if (corruptReceipt && sql.includes('INSERT INTO trading_context_changes_v4')) {
          corruptReceipt = false
          return target.execute(sql, [999999, ...values.slice(1)])
        }
        return target.execute(sql, values)
      }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  const faulty = new MysqlContextCommands(faultPool, resolver), uncertain = command(44)
  await assert.rejects(faulty.execute(uncertain), error => error.code === 'trading_context_commit_unknown')
  assert.equal((await writer.receipt(44, uncertain.requestId)).result.revision, 1)
  assert.equal((await writer.execute(uncertain)).replayed, true)
  checks.push({ name: 'committed-ack-loss-independent-connection-recovery', passed: true })
  corruptReceipt = true
  const failed = command(44, 1, '8')
  await assert.rejects(faulty.execute(failed), error => error.code === 'trading_context_write_failed')
  assert.equal(await writer.receipt(44, failed.requestId), null)
  const [[afterFailure]] = await connection.execute('SELECT revision,trading_account_id FROM trading_contexts WHERE user_id=?', [44])
  assert.equal(Number(afterFailure.revision), 1); assert.equal(String(afterFailure.trading_account_id), '7')
  checks.push({ name: 'real-receipt-foreign-key-failure-rolls-back-context', passed: true })
  await writer.execute(command(44, 1, '8'))
  assert.equal((await writer.execute(uncertain)).result.accountId, '7')
  const [[current]] = await connection.execute('SELECT revision,trading_account_id FROM trading_contexts WHERE user_id=?', [44])
  assert.equal(Number(current.revision), 2); assert.equal(String(current.trading_account_id), '8')
  checks.push({ name: 'historical-replay-does-not-restore-old-context', passed: true })
  await connection.execute("UPDATE users SET deletion_status='inactive' WHERE id=?", [44])
  await assert.rejects(writer.receipt(44, uncertain.requestId), error => error.status === 403)
  await assert.rejects(writer.execute(uncertain), error => error.status === 403)
  checks.push({ name: 'inactive-user-cannot-read-or-replay-receipt', passed: true })
  const observe = { ...command(45), action: 'enter_observer', targetId: '12' }
  assert.equal((await writer.execute(observe)).result.readOnly, true)
  const leave = { ...command(45, 1), action: 'leave_observer', targetId: null }
  assert.equal((await writer.execute(leave)).result.mode, 'blocked')
  checks.push({ name: 'observer-and-blocked-results-persist-and-roundtrip', passed: true })
  const [[counts]] = await connection.query('SELECT (SELECT COUNT(*) FROM trading_contexts) contexts,(SELECT COUNT(*) FROM trading_context_changes_v4) receipts')
  assert.equal(Number(counts.contexts), 4); assert.equal(Number(counts.receipts), 6)
  const hashes = {}
  for (const file of ['server/src/modules/trading/infrastructure/mysql-context-commands.ts','server/src/modules/trading/infrastructure/mysql-context-receipts.ts',
    'server/dist-v4/modules/trading/infrastructure/mysql-context-commands.js','server/dist-v4/modules/trading/infrastructure/mysql-context-receipts.js']) {
    hashes[file] = createHash('sha256').update(await readFile(new URL(file, root))).digest('hex')
  }
  await pool.end(); pool = null
  await connection.query('DROP DATABASE `' + database + '`'); created = false
  const report = { kind: 'context-command-mysql-rehearsal/v1', observedAt: new Date().toISOString(), identity, checks, hashes, parallelConnections,
    toolHash: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    sourceHashes: { contexts: createHash('sha256').update(contextSource).digest('hex'), receipts: createHash('sha256').update(receiptSource).digest('hex') },
    counts, referenceDatabaseRemoved: true, existingDatabaseWrites: 0,
    scope: 'Real MySQL transaction/idempotency with actual compiled writer and synthetic target resolver; no real target authorization, HTTP/browser or existing database activation.' }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ checks: checks.length, counts, referenceDatabaseRemoved: true }))
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: /^ER_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'context_transaction_rehearsal_failed' }))
  process.exitCode = 1
} finally {
  if (pool) await pool.end()
  if (created) await connection.query('DROP DATABASE `' + database + '`')
  if (connection) await connection.end()
}
