import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { decodeTerminalHistoryPage } from '../server/dist-v4/modules/trade-history/domain/terminal-history-projection.js'
import { persistHistoryOrderProvenance } from '../server/dist-v4/modules/trade-history/infrastructure/mysql-history-order-provenance-writer.js'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_history_runtime_ref_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_history_runtime_ref_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'history-runtime-schema-reference/v1', passed: false, existingDatabaseWrites: 0, referenceDatabaseRemoved: false,
  scaffoldParents: ['users', 'trading_accounts', 'trading_account_ownership_intervals'], checks: [], steps: [], tables: {} }
let connection, created = false
try {
  const migration = await readFile(new URL('../server/db/migrations/inplace/046_terminal_history_order_provenance.sql', import.meta.url), 'utf8')
  report.migrationSha256 = createHash('sha256').update(migration).digest('hex')
  const prerequisites = await readFile(new URL('../server/db/migrations/inplace/047_trade_history_runtime_tables.sql', import.meta.url), 'utf8')
  report.prerequisitesSha256 = createHash('sha256').update(prerequisites).digest('hex')
  const statements = splitSqlStatements(prerequisites)
  assert.equal(statements.length, 11)
  connection = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false })
  const [[server]] = await connection.query('SELECT @@server_uuid uuid,@@version version')
  assert.equal(server.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.serverUuid = server.uuid; report.serverVersion = server.version
  await connection.query(`CREATE DATABASE \`${database}\``); created = true
  await connection.query(`USE \`${database}\``)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('CREATE TABLE users (id INT PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('CREATE TABLE trading_account_ownership_intervals (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY) ENGINE=InnoDB')
  for (const [index, sql] of statements.entries()) {
    const match = /^(CREATE|ALTER) TABLE ([a-z0-9_]+)\s/.exec(sql)
    assert.ok(match)
    await connection.query(sql)
    const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${match[2]}\``)
    const canonicalDdl = definition['Create Table']
    report.steps.push({ index: index + 1, operation: match[1], table: match[2], sqlSha256: createHash('sha256').update(sql).digest('hex'), canonicalDdl })
    report.tables[match[2]] = canonicalDdl
  }
  assert.equal(Object.keys(report.tables).length, 7)
  report.checks.push('eleven_history_prerequisite_statements_in_dependency_order')
  await connection.query(migration)
  const [[definition]] = await connection.query('SHOW CREATE TABLE terminal_history_order_provenance_v4')
  report.canonicalDdl = definition['Create Table']
  await connection.query('INSERT INTO users VALUES (7)')
  await connection.query('INSERT INTO trading_accounts VALUES (42)')
  const now = new Date(), orderId = randomUUID()
  const raw = { ticket: '99', symbol: 'XAUUSD.a', type: 'buy_limit', state: 'cancelled' }
  const fact = decodeTerminalHistoryPage('orders', [raw])[0]
  await connection.execute(`INSERT INTO terminal_history_orders_v4
    (id,trading_account_id,platform,order_ticket,side,order_kind,order_state,terminal_timezone_offset_minutes,evidence_sha256,evidence_json,observed_at_utc,created_at_utc,updated_at_utc)
    VALUES (?,?,?,?,'buy','buy_limit','cancelled',180,?,?,?,?,?)`, [orderId, 42, 'mt5', '99', fact.evidenceHash, fact.evidenceJson, now, now, now])
  const route = { userId: 7, accountId: '42', platform: 'mt5', terminalInstanceId: 't1', terminalProfileId: 'p1', brokerServer: 'Broker',
    login: '123', connectionEpoch: 9, connectionId: 'c1', sessionId: 's1', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
  const response = { v: 4, type: 'query.response', message_id: 'm1', correlation_id: 'q1', sent_at_utc_msc: now.getTime(),
    route: { terminal_instance_id: 't1', account_ref: { broker_server: 'Broker', login: '123' }, connection_epoch: 9 },
    payload: { request_id: 'r1', resource: 'history.orders', observed_at_utc_msc: now.getTime() - 1, source_revision: '3', source: 'terminal', items: [raw], has_more: false, next_cursor: null } }
  const input = { route, response, fact, receivedAt: now }
  await connection.beginTransaction()
  const first = await persistHistoryOrderProvenance(connection, input)
  await connection.commit()
  assert.equal(first.created, true)
  await connection.beginTransaction()
  assert.deepEqual(await persistHistoryOrderProvenance(connection, { ...input, receivedAt: new Date(now.getTime() + 1) }), { id: first.id, created: false })
  await assert.rejects(persistHistoryOrderProvenance(connection, { ...input, response: { ...response, correlation_id: 'other' } }), /trade_history_provenance_conflict/)
  await connection.rollback()
  report.checks.push('real_writer_insert_replay_and_conflict')
  for (const [column, value] of [['user_id', 8], ['trading_account_id', 43], ['terminal_history_order_id', randomUUID()]]) {
    await assert.rejects(connection.execute(`UPDATE terminal_history_order_provenance_v4 SET ${column}=? WHERE id=?`, [value, first.id]), { code: 'ER_NO_REFERENCED_ROW_2' })
  }
  report.checks.push('three_real_foreign_keys')
  for (const [column, value] of [['connection_epoch', 0], ['ownership_revision', 0], ['fact_sha256', 'invalid'], ['provenance_sha256', 'invalid']]) {
    await assert.rejects(connection.execute(`UPDATE terminal_history_order_provenance_v4 SET ${column}=? WHERE id=?`, [value, first.id]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
  }
  report.checks.push('revision_and_hash_check_constraints')
  await connection.beginTransaction()
  await persistHistoryOrderProvenance(connection, { ...input, response: { ...response, message_id: 'm2' } })
  await connection.rollback()
  const [[count]] = await connection.query('SELECT COUNT(*) quantity FROM terminal_history_order_provenance_v4')
  assert.equal(count.quantity, 1)
  report.checks.push('transaction_rollback_preserves_prior_receipt')
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'reference_failed'; process.exitCode = 1 }
finally {
  if (connection) {
    try { if (created) { await connection.query(`DROP DATABASE \`${database}\``); report.referenceDatabaseRemoved = true } }
    catch { report.passed = false; report.cleanupError = true; report.referenceDatabase = database; process.exitCode = 1 }
    await connection.end()
  }
  report.finishedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode, referenceDatabaseRemoved: report.referenceDatabaseRemoved }))
}
