import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadTradingContextChanges } from './lib/inplace-trading-context-changes.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString())
assert.ok(credential.host === '127.0.0.1' && credential.user === 'root' && Number.isInteger(credential.port) && credential.port > 1024 && credential.port < 65536)
const database = 'dev_vue_context_reference_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_context_reference_[0-9a-f]{32}$/)
const connection = await mysql.createConnection({ host: credential.host, port: credential.port, user: credential.user,
  password: credential.password, timezone: 'Z', multipleStatements: false, connectTimeout: 5000 })
let created = false
const checks = []
try {
  const [[identity]] = await connection.query('SELECT @@server_uuid serverUuid,@@version version')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const plan = await loadTradingContextChanges(new URL('../', import.meta.url))
  await connection.query('CREATE DATABASE `' + database + '`'); created = true
  await connection.query('USE `' + database + '`')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('CREATE TABLE users (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('INSERT INTO users (id) VALUES (42)')
  await connection.query(plan.additions[0].sql)
  const [[ddl]] = await connection.query('SHOW CREATE TABLE trading_context_changes_v4')
  const columns = ['user_id','request_id','request_sha256','action','target_id','prior_revision','revision','result_mode','result_account_id','result_observer_channel_id','result_read_only','recorded_at_utc']
  const base = { user_id: 42, request_id: randomUUID(), request_sha256: 'a'.repeat(64), action: 'select_account', target_id: '7',
    prior_revision: 0, revision: 1, result_mode: 'full', result_account_id: '7', result_observer_channel_id: null, result_read_only: 0,
    recorded_at_utc: '2026-09-08 12:00:00.123' }
  const insert = row => connection.execute('INSERT INTO trading_context_changes_v4 (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')', columns.map(name => row[name]))
  await insert(base)
  const [[saved]] = await connection.query('SELECT recorded_at_utc FROM trading_context_changes_v4')
  assert.equal(saved.recorded_at_utc.toISOString(), '2026-09-08T12:00:00.123Z')
  checks.push({ name: 'valid-write-utc-milliseconds', passed: true })
  for (const [name, patch, errorCode] of [
    ['same-user-request-key', { request_id: base.request_id }, 'ER_DUP_ENTRY'],
    ['same-user-result-revision', { prior_revision: 0, revision: 1 }, 'ER_DUP_ENTRY'],
    ['missing-user', { user_id: 43 }, 'ER_NO_REFERENCED_ROW_2'],
    ['revision-jump', { revision: 9 }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['unsafe-revision', { prior_revision: '9007199254740991', revision: '9007199254740992' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['missing-target', { target_id: null }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['wrong-result-account', { result_account_id: '8' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['writable-observer', { action: 'enter_observer', target_id: '12', result_mode: 'observer', result_account_id: null, result_observer_channel_id: '12' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['mixed-result-scope', { result_observer_channel_id: '12' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ]) {
    await assert.rejects(insert({ ...base, request_id: randomUUID(), prior_revision: 1, revision: 2, ...patch }), error => error.code === errorCode)
    checks.push({ name, passed: true })
  }
  await connection.beginTransaction()
  await insert({ ...base, request_id: randomUUID(), prior_revision: 1, revision: 2, action: 'enter_observer', target_id: '12', result_mode: 'observer', result_account_id: null, result_observer_channel_id: '12', result_read_only: 1 })
  checks.push({ name: 'valid-observer-result', passed: true })
  await insert({ ...base, request_id: randomUUID(), prior_revision: 2, revision: 3, action: 'leave_observer', target_id: null })
  checks.push({ name: 'valid-exit-to-owned-account', passed: true })
  await insert({ ...base, request_id: randomUUID(), prior_revision: 3, revision: 4, action: 'leave_observer', target_id: null, result_mode: 'blocked', result_account_id: null, result_read_only: 1 })
  await connection.rollback()
  const [[count]] = await connection.query('SELECT COUNT(*) n FROM trading_context_changes_v4')
  assert.equal(Number(count.n), 1)
  checks.push({ name: 'receipt-insert-rollback', passed: true })
  await connection.query('DROP DATABASE `' + database + '`'); created = false
  const report = { kind: 'context-receipt-schema-reference/v1', observedAt: new Date().toISOString(), identity,
    toolHash: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    registrySteps: plan.steps.length, stepChecksum: plan.additions[0].checksum, canonicalDdl: ddl['Create Table'],
    sourceHash: createHash('sha256').update(await readFile(new URL('../server/db/migrations/inplace/041_trading_context_changes.sql', import.meta.url))).digest('hex'),
    checks, referenceDatabaseRemoved: true, existingDatabaseWrites: 0,
    scope: 'Temporary isolated MySQL schema constraints only; no existing dev_vue upgrade or context-command transaction/concurrency claim.' }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ checks: checks.length, referenceDatabaseRemoved: true }))
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: /^ER_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'context_reference_failed' }))
  process.exitCode = 1
} finally {
  if (created) await connection.query('DROP DATABASE `' + database + '`')
  await connection.end()
}
