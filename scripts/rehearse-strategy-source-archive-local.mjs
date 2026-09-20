import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { BackfillError, hash } from './lib/v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields } from './lib/v4-strategy-source-review.mjs'
import { createStrategySourceArchiveBatch } from './lib/strategy-source-archive-batch.mjs'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { loadStrategyBackfillSchema, inspectStrategyBackfillSchema } from './lib/strategy-backfill-schema-preflight.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--restored-only' && isAbsolute(destination ?? '') && process.argv.length === 4)
const root = new URL('../', import.meta.url), sha = value => createHash('sha256').update(value).digest('hex')
const load = async path => JSON.parse(await readFile(path, 'utf8'))
const baseline = await load(new URL('docs/architecture/core-refactor-restored-baseline-20260910.json', root))
assert.equal(baseline.target, 'dev_vue_m1_source_20260910_01')
assert.equal(baseline.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
const receiptBytes = await readFile(join(baseline.archiveDirectory, 'receipt.json'))
assert.equal(sha(receiptBytes), baseline.receiptSha256)
const receipt = JSON.parse(receiptBytes)
assert.ok(receipt.status === 'verified' && receipt.sourceUnchanged && receipt.parity.matched)
const restored = await load(join(baseline.archiveDirectory, 'restored-snapshot.json'))
const expected = restored.map(({ name, rows, rowsSha256, ddl }) => ({ name, rows, rowsSha256, ddl }))
const inventory = await load(new URL('docs/architecture/strategy-upgrade-source-inventory-v13-20260910.json', root))
assert.ok(inventory.inspected && inventory.schemaPreflight.schemaReady)
const digest = hash({ purpose: 'strategy-source-preservation/v1', baseline: baseline.sourceSnapshotHash, inputs: inventory.inputHash })
const runId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
const tools = []
for (const path of ['scripts/rehearse-strategy-source-archive-local.mjs', 'scripts/run-strategy-source-archive-local.py', 'scripts/lib/strategy-source-archive-batch.mjs',
  'scripts/lib/frozen-source-batch.mjs', 'scripts/lib/v4-backfill-mysql-repository.mjs', 'scripts/lib/strategy-backfill-schema-preflight.mjs']) {
  tools.push({ path, sha256: sha(await readFile(new URL(path, root))) })
}
const bindings = { logicalSourceId: 'dev_vue', purpose: 'source_preservation_only', database: baseline.target,
  serverUuid: baseline.serverUuid, restoredSnapshotHash: hash(expected), sourceInputsHash: inventory.inputHash, tools }
const ledger = new Map([['data_migration_runs', 'id'], ...['data_migration_checkpoints', 'data_migration_batches', 'data_migration_row_receipts', 'data_migration_source_rows'].map(name => [name, 'run_id'])])
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'restored-strategy-source-preservation/v1', passed: false, target: baseline.target, runId,
  currentDevVueWrites: 0, runtimeEnabled: false, roleConversionCompleted: false, tools }
const pool = mysql.createPool({ ...credentials, database: baseline.target, timezone: 'Z', dateStrings: true, jsonStrings: true,
  supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectionLimit: 2 })
let connection
try {
  connection = await pool.getConnection()
  await connection.query("SET SESSION time_zone='+00:00'")
  const schema = await inspectStrategyBackfillSchema(connection, await loadStrategyBackfillSchema(root), baseline.target)
  assert.ok(schema.schemaReady)
  const snapshot = async () => {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      const result = await readAccountRootSnapshot(connection), filtered = structuredClone(result.tables)
      for (const [name, column] of ledger) {
        const meta = result.metadata.get(name), digest = createHash('sha256')
        const quote = value => { assert.match(value, /^[a-z][a-z0-9_]*$/); return `\`${value}\`` }
        const stream = connection.connection.query({ sql: `SELECT ${meta.columns.map(quote).join(',')} FROM ${quote(name)} WHERE ${quote(column)}<>? ORDER BY ${meta.primary.map(quote).join(',')}`,
          values: [runId], rowsAsArray: true }).stream({ highWaterMark: 16 })
        let rows = 0
        for await (const row of stream) { digest.update(JSON.stringify(row)); digest.update('\n'); rows++ }
        Object.assign(filtered.find(table => table.name === name), { rows, rowsSha256: digest.digest('hex') })
      }
      assert.equal(hash(filtered), hash(expected), 'restored_baseline_changed_outside_this_run')
      return result.tables
    } finally { await connection.rollback() }
  }
  report.stage = 'baseline_snapshot'
  const before = await snapshot(), batches = []
  for (const [table, fields, candidates] of [['auto_prompt_types', legacyStrategyFields, inventory.strategyCandidates], ['strategy_subscriptions', legacySubscriptionFields, inventory.subscriptionCandidates]]) {
    const [rows] = await connection.query(`SELECT ${fields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM \`${table}\` ORDER BY id LIMIT 101`)
    assert.equal(rows.length, candidates.length)
    const entries = rows.map(row => ({ source: { ...row }, sourceHash: hash({ ...row }) }))
    for (const entry of entries) assert.equal(entry.sourceHash, candidates.find(value => value.sourceId === entry.source.id)?.sourceHash)
    batches.push(createStrategySourceArchiveBatch(table, entries, { runId, logicalSourceId: 'dev_vue', bindings, sequence: 1, startCursor: null }))
  }
  const repository = new MysqlBackfillRepository(pool)
  const work = async (tx, inject = false) => {
    const existing = await tx.findRun(runId)
    if (existing) assert.equal(existing.bindingsHash, hash(bindings))
    else { await tx.insertRun(runId, bindings, hash(bindings)); for (const batch of batches) await tx.insertCheckpoint(runId, batch.streamId) }
    const results = []
    for (const batch of batches) {
      results.push(await batch.execute(tx))
      if (inject) throw new BackfillError('archive_injected_rollback')
    }
    return results
  }
  report.stage = 'rollback_rehearsal'
  await assert.rejects(repository.transaction(tx => work(tx, true)), { code: 'archive_injected_rollback' })
  assert.equal(hash(await snapshot()), hash(before))
  report.failedBatchRolledBack = true
  let loseAck = true
  const uncertain = new MysqlBackfillRepository({ async getConnection() {
    const db = await pool.getConnection()
    return new Proxy(db, { get(target, key) {
      if (key === 'commit') return async () => { await target.commit(); if (loseAck) { loseAck = false; throw Error('injected_ack_loss') } }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
  } })
  report.stage = 'commit_and_replay'
  await assert.rejects(uncertain.transaction(tx => work(tx)), { code: 'backfill_commit_unknown' })
  const after = await snapshot()
  const replay = await repository.transaction(tx => work(tx))
  assert.ok(replay.every(result => result.replayed))
  assert.equal(hash(await snapshot()), hash(after))
  report.replayedAfterCommitUnknown = true
  report.sourceRows = batches.reduce((total, batch) => total + batch.rows, 0)
  report.ledgerCounts = {}
  for (const [table, column] of ledger) {
    const [[row]] = await connection.execute(`SELECT COUNT(*) n FROM \`${table}\` WHERE \`${column}\`=?`, [runId])
    report.ledgerCounts[table] = Number(row.n)
  }
  assert.deepEqual(Object.values(report.ledgerCounts), [1, 2, 2, 8, 8])
  report.businessTablesUnchanged = true
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'archive_rehearsal_failed'; process.exitCode = 1
} finally {
  if (connection) connection.release()
  await pool.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, stage: report.stage, sourceRows: report.sourceRows, errorCode: report.errorCode, currentDevVueWrites: 0 }))
}
