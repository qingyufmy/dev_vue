import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { MysqlTradeHistoryCollectorRepository } from '../server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_history_collector_ref_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_history_collector_ref_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'history-collector-transaction-reference/v1', passed: false, existingDatabaseWrites: 0, referenceDatabaseRemoved: false,
  scaffoldParents: ['users', 'trading_accounts', 'trading_account_ownership_intervals'], checks: [], steps: [], tables: {} }
let connection, pool, created = false
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
  report.routeAuthorization = 'fixture guard locks scaffold account; real ownership/session authorization is not covered'
  report.collectorSha256 = createHash('sha256').update(await readFile(new URL('../server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js', import.meta.url))).digest('hex')
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', connectionLimit: 2, multipleStatements: false })
  const collector = new MysqlTradeHistoryCollectorRepository({ getConnection: async () => {
    const acquired = await pool.getConnection()
    await acquired.query("SET SESSION time_zone='+00:00'")
    return acquired
  } }, conn => ({ assert: async route => {
    assert.equal(route.accountId, '42')
    const [rows] = await conn.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [route.accountId])
    assert.equal(rows.length, 1)
  } }))
  const now = new Date(), raw = { ticket: '99', symbol: 'XAUUSD.a', type: 'buy_limit', state: 'cancelled' }
  const route = { userId: 7, accountId: '42', platform: 'mt5', terminalInstanceId: 't1', terminalProfileId: 'p1', brokerServer: 'Broker',
    login: '123', connectionEpoch: 9, connectionId: 'c1', sessionId: 's1', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
  const response = { v: 4, type: 'query.response', message_id: 'm1', correlation_id: 'q1', sent_at_utc_msc: now.getTime(),
    route: { terminal_instance_id: 't1', account_ref: { broker_server: 'Broker', login: '123' }, connection_epoch: 9 },
    payload: { request_id: 'r1', resource: 'history.orders', observed_at_utc_msc: now.getTime() - 1, source_revision: '3', source: 'terminal', items: [raw], has_more: false, next_cursor: null } }
  await collector.begin(route, now)
  await collector.persistPage(route, 'history.orders', response, now)
  const snapshot = async () => {
    const [orders] = await connection.query('SELECT id,order_ticket,evidence_sha256 FROM terminal_history_orders_v4 ORDER BY order_ticket')
    const [receipts] = await connection.query('SELECT id,terminal_history_order_id,response_message_id,provenance_sha256,received_at_utc FROM terminal_history_order_provenance_v4 ORDER BY id')
    const [sync] = await connection.query('SELECT trading_account_id,status,history_revision,updated_at_utc FROM trade_history_sync_states_v4')
    return { orders, receipts, sync }
  }
  const first = await snapshot()
  assert.equal(first.orders.length, 1); assert.equal(first.receipts.length, 1)
  assert.equal(first.receipts[0].terminal_history_order_id, first.orders[0].id)
  report.checks.push('collector_commits_fact_and_provenance_together')
  await collector.persistPage(route, 'history.orders', response, now)
  assert.deepEqual(await snapshot(), first)
  report.checks.push('collector_response_replay_preserves_receipt')
  const changed = structuredClone(response)
  changed.correlation_id = 'conflicting-query'
  changed.payload.items = [{ ...raw, ticket: '10' }, raw]
  await assert.rejects(collector.persistPage(route, 'history.orders', changed, new Date(now.getTime() + 1000)), /trade_history_provenance_conflict/)
  assert.deepEqual(await snapshot(), first)
  report.checks.push('later_order_conflict_rolls_back_earlier_fact_receipt_and_sync')
  const next = structuredClone(response); next.message_id = 'm2'; next.payload.items = [{ ...raw, ticket: '10' }, raw]
  await collector.persistPage(route, 'history.orders', next, new Date(now.getTime() + 2000))
  const committed = await snapshot()
  assert.equal(committed.orders.length, 2); assert.equal(committed.receipts.length, 3)
  report.checks.push('subsequent_valid_page_commits_after_rollback')
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'reference_failed'; process.exitCode = 1 }
finally {
  if (pool) await pool.end()
  if (connection) {
    try { if (created) { await connection.query(`DROP DATABASE \`${database}\``); report.referenceDatabaseRemoved = true } }
    catch { report.passed = false; report.cleanupError = true; report.referenceDatabase = database; process.exitCode = 1 }
    await connection.end()
  }
  report.finishedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode, referenceDatabaseRemoved: report.referenceDatabaseRemoved }))
}
