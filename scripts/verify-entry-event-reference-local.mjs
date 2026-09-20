import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadMemoryAuditCompletionUpgrade } from './lib/memory-audit-completion-upgrade.mjs'
import { loadEntryEventSource, composeEntryEventUpgrade } from './lib/entry-event-upgrade.mjs'
import { createSchemaTransitionReference } from './lib/schema-transition-reference.mjs'
import { inferenceRootSchemaState } from './lib/inference-root-schema-state.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore } from './lib/mysql-inplace-column-store.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { entryEventsOccupied, reserveEntryEvents } from '../server/dist-v4/modules/inference/infrastructure/mysql-entry-event-claims.js'
import { createMysqlTradeDecisionRiskWriter } from '../server/dist-v4/modules/inference/infrastructure/mysql-trade-decision-risk-writer.js'
import { inferenceTransaction } from '../server/dist-v4/modules/inference/infrastructure/mysql-inference-transaction.js'
import { contentHash } from '../server/dist-v4/modules/inference/index.js'

const [destination] = process.argv.slice(2), root = new URL('../', import.meta.url)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600), prior = await loadMemoryAuditCompletionUpgrade(root), source = await loadEntryEventSource(root)
const name = 'dev_vue_workflow_schema_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'entry-event-reference/v1', passed: false, existingDatabaseWrites: 0, referenceDatabaseRemoved: false,
  fullBusinessChainVerified: false, syntheticParentRows: true }
let db, created = false, locked = false, pool
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  const options = { ...credential, database: 'dev_vue', timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }
  db = await mysql.createConnection(options)
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  const [[lock]] = await db.execute('SELECT GET_LOCK(?,0) acquired', ['aurum:inplace:dev_vue'])
  assert.equal(Number(lock.acquired), 1); locked = true
  const readSchema = async () => {
    const [names] = await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'")
    const rows = []
    for (const { name: table } of names) { assert.match(table, /^[a-z][a-z0-9_]*$/); const [[row]] = await db.query('SHOW CREATE TABLE `' + table + '`'); rows.push({ name: table, ddl: row['Create Table'] }) }
    return rows
  }
  const tables = await readSchema()
  assert.equal(inferenceRootSchemaState(tables).sha256, prior.finalSchemaHash)
  const [history] = await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  assert.equal(history.length, prior.steps.length)
  for (const row of history) { assert.equal(row.status, 'completed'); assert.equal(row.checksum, prior.steps.find(step => step.id === row.id)?.checksum) }
  await db.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  await db.query('USE `' + name + '`'); await db.query('SET SESSION foreign_key_checks=0')
  for (const table of tables) await db.query(table.ddl)
  await db.query('SET SESSION foreign_key_checks=1')
  const transition = await createSchemaTransitionReference(db)
  await transition.connection.query(source.statements[0])
  const [[definition]] = await db.query('SHOW CREATE TABLE inference_entry_event_claims_v4')
  const proof = { sourceSteps: 266, tableCount: 315, initialSchemaState: transition.initial, sources: source.sources,
    transitions: transition.transitions, definitions: { inference_entry_event_claims_v4: definition['Create Table'] } }
  report.schemaProof = proof
  const upgrade = composeEntryEventUpgrade(prior, source, proof)
  report.planHash = hash(upgrade.steps)
  await db.query('DROP TABLE inference_entry_event_claims_v4') // Owned empty reference table only.
  await db.query(`INSERT INTO database_upgrade_steps_v4 (id,checksum_sha256,status,started_at_utc,completed_at_utc)
    SELECT id,checksum_sha256,status,started_at_utc,completed_at_utc FROM dev_vue.database_upgrade_steps_v4`)
  let injected = false, ddl = 0
  const store = { ...mysqlColumnStore(db, true), tableHash: async () => inferenceRootSchemaState(await readSchema()).sha256,
    async execute(sql) { assert.equal(sql, source.statements[0]); ddl++; await db.query(sql); if (!injected) { injected = true; throw Error('injected_ddl_ack_loss') } } }
  await assert.rejects(coordinateInplaceSchema(store, upgrade, { apply: true }), /injected_ddl_ack_loss/)
  assert.ok((await coordinateInplaceSchema(store, upgrade, { apply: true })).structureComplete)
  report.ddlAckLossRecovered = true
  await coordinateInplaceSchema(store, upgrade, { apply: true }); assert.equal(ddl, 1); report.replayNoDDL = true

  const insert = async (table, values) => {
    assert.ok(['users', 'trading_accounts', 'strategies', 'trade_decisions', 'risk_decisions_v4'].includes(table))
    const [columns] = await db.execute('SELECT COLUMN_NAME name,DATA_TYPE type,COLUMN_TYPE definition,IS_NULLABLE nullable,COLUMN_DEFAULT fallback,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [name, table])
    const row = { ...values }
    for (const col of columns) {
      if (Object.hasOwn(row, col.name) || col.nullable === 'YES' || col.fallback !== null || /auto_increment|GENERATED/.test(col.extra)) continue
      row[col.name] = col.type === 'enum' ? /^enum\('([^']+)'/.exec(col.definition)[1]
        : col.type === 'json' ? '{}' : ['datetime', 'timestamp'].includes(col.type) ? '2026-09-13 00:00:00.000'
          : /int|decimal|float|double/.test(col.type) ? 1 : col.name.includes('sha256') ? 'a'.repeat(64) : 'fixture'
    }
    await db.execute(`INSERT INTO ${table} (${Object.keys(row).map(key => '`' + key + '`').join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row))
  }
  const scope = { userId: 7, accountId: '5', strategyId: '2' }, eventId = 'event:' + 'a'.repeat(64)
  const claims = [{ actionId: 'open', eventId, timeframe: 'M5', symbol: 'XAUUSD', side: 'buy' }]
  const ids = Array.from({ length: 5 }, () => randomUUID()), riskIds = ids.map(() => randomUUID())
  const result = { actions: [{ actionId: 'open', kind: 'market_order', parameters: { entry_event_id: eventId } }] }
  await db.query('SET SESSION foreign_key_checks=0')
  await insert('users', { id: 7 }); await insert('trading_accounts', { id: 5 }); await insert('strategies', { id: 2 })
  for (const [index, id] of ids.entries()) {
    await insert('trade_decisions', { id, trader_run_id: randomUUID(), user_id: 7, trading_account_id: 5, strategy_id: 2,
      content_sha256: contentHash(result), status: 'proposed', revision: 1 })
    await db.execute('INSERT INTO trade_decision_payloads (trade_decision_id,payload_json,payload_sha256,payload_bytes) VALUES (?,?,?,?)',
      [id, JSON.stringify(result), contentHash(result), Buffer.byteLength(JSON.stringify(result))])
    await insert('risk_decisions_v4', { id: riskIds[index], trade_decision_id: id, user_id: 7, trading_account_id: 5 })
  }
  await db.query('SET SESSION foreign_key_checks=1')
  pool = mysql.createPool({ ...options, database: name, connectionLimit: 3 })
  const claim = id => inferenceTransaction(pool, async connection => {
    await connection.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', ['5'])
    if (await entryEventsOccupied(connection, scope, claims)) return 'occupied'
    await reserveEntryEvents(connection, scope, id, claims)
    return 'reserved'
  })
  const results = await Promise.all([claim(ids[0]), claim(ids[1])])
  assert.deepEqual([...results].sort(), ['occupied', 'reserved']); report.concurrentSingleWinner = true
  const winner = results.indexOf('reserved')
  const review = (index, outcome) => inferenceTransaction(pool, async connection => {
    await connection.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', ['5'])
    return createMysqlTradeDecisionRiskWriter(connection).recordRiskReview({ decisionId: ids[index], ...scope,
      expectedRevision: 1, riskDecisionId: riskIds[index], outcome })
  })
  assert.ok(await review(winner, 'rejected')); assert.equal(await claim(ids[2]), 'reserved')
  assert.ok(await review(2, 'approved')); assert.equal(await claim(ids[3]), 'occupied')
  const [records] = await db.query('SELECT state,active_event_id FROM inference_entry_event_claims_v4 ORDER BY created_at_utc')
  assert.deepEqual(records.map(row => row.state).sort(), ['consumed', 'released'])
  assert.equal(records.find(row => row.state === 'released').active_event_id, null)
  report.riskRejectReleases = true; report.riskApprovalRetains = true; report.releasedReceiptPreserved = true
  await assert.rejects(inferenceTransaction(pool, async connection => {
    await reserveEntryEvents(connection, scope, ids[3], [{ ...claims[0], eventId: 'event:' + 'b'.repeat(64) }])
    throw Error('injected_before_commit')
  }), /injected_before_commit/)
  assert.equal(await entryEventsOccupied(db, scope, [{ ...claims[0], eventId: 'event:' + 'b'.repeat(64) }]), false)
  report.rollbackLeavesNoClaim = true
  const unknown = await mysql.createConnection({ ...options, database: name })
  const proxy = new Proxy(unknown, { get(target, key) {
    if (key === 'commit') return async () => { await target.commit(); throw Error('injected_commit_ack_loss') }
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(inferenceTransaction({ getConnection: async () => proxy }, connection => reserveEntryEvents(connection, scope, ids[4],
    [{ ...claims[0], eventId: 'event:' + 'c'.repeat(64) }])), error => error.code === 'inference_commit_unknown')
  assert.equal(await entryEventsOccupied(db, scope, [{ ...claims[0], eventId: 'event:' + 'c'.repeat(64) }]), true)
  report.unknownCommitRemainsOccupied = true
  assert.equal(await entryEventsOccupied(db, { ...scope, accountId: '6' }, claims), false)
  assert.equal(await entryEventsOccupied(db, { ...scope, strategyId: '3' }, claims), false)
  assert.equal(await entryEventsOccupied(db, { ...scope, userId: 8 }, claims), false)
  report.scopeIsolationVerified = true
  report.passed = true
} catch (error) { report.error = { code: error.code ?? error.name, message: String(error.message).slice(0, 300) }; process.exitCode = 1 }
finally {
  if (pool) await pool.end()
  if (db) {
    if (created) { assert.match(name, /^dev_vue_workflow_schema_ref_[a-f0-9]{32}$/); await db.query('USE dev_vue'); await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true }
    if (locked) await db.execute('SELECT RELEASE_LOCK(?)', ['aurum:inplace:dev_vue'])
    await db.end()
  }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, error: report.error, referenceDatabaseRemoved: report.referenceDatabaseRemoved,
    concurrentSingleWinner: report.concurrentSingleWinner, unknownCommitRemainsOccupied: report.unknownCommitRemainsOccupied, destination }))
}
