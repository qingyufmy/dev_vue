import { createReviewHistoryCaseBatch, reviewProjectionTables } from './lib/review-history-case-batch.mjs'
import { projectArchivedReviewCase } from './lib/review-history-case-projection.mjs'
import { readReviewHistoryArchive } from './lib/review-history-archive-reader.mjs'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { hash, BackfillError } from './lib/v4-backfill-contract.mjs'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { readReviewHistoryBundle } from './lib/review-history-bundle.mjs'
import { assertMysqlExecutionWorkflowSchemaReady } from '../server/dist-v4/modules/execution/composition.js'

const [mode, destination] = process.argv.slice(2), root = new URL('../', import.meta.url)
assert.ok(process.argv.length === 4 && ['--restored', '--current'].includes(mode) && isAbsolute(destination ?? ''))
const side = mode === '--restored' ? 'restored' : 'current', target = side === 'restored' ? 'dev_vue_m1_source_20260910_02' : 'dev_vue'
const load = async path => JSON.parse(await readFile(path, 'utf8'))
const proof = await load(new URL('docs/architecture/review-history-bundles-v3-20260911.json', root))
assert.ok(proof.passed && proof.allSourceRowsCovered && proof.chunkRoundtripVerified)
const manifestHash = hash(proof.bundles.map(({ table, id, sourceHash }) => ({ table, id, sourceHash })))
const archiveRunId = '1c2e3dd7-afa6-f810-96a4-f5f97febc668'
const hex = hash({ purpose: 'review-history-case-projection/v1', manifestHash }).slice(0, 32)
const runId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
const bindings = { logicalSourceId: 'dev_vue', target, manifestHash, purpose: 'review-history-case-projection/v1' }
if (side === 'current') {
  const rehearsal = await load(new URL('docs/architecture/review-history-cases-restored-v1-20260911.json', root))
  assert.ok(rehearsal.passed && rehearsal.rollbackVerified && rehearsal.replayNoAdditionalRows && rehearsal.oldDataAndLedgerUnchanged)
  assert.equal(rehearsal.manifestHash, manifestHash)
}
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-history-case-projection/v1', passed: false, target, runId, manifestHash, cases: 0, versions: 0, userStates: 0 }
const input = []; for await (const chunk of process.stdin) input.push(chunk)
const credential = JSON.parse(Buffer.concat(input).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const pool = mysql.createPool({ ...credential, database: target, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 2 })
const ledger = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches', 'data_migration_row_receipts', 'data_migration_source_rows', 'data_migration_id_maps']
let db, locked = false
try {
  db = await pool.getConnection(); await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  await assertMysqlExecutionWorkflowSchemaReady({ async getConnection() {
    const connection = await pool.getConnection(); await connection.query("SET SESSION time_zone='+00:00'"); return connection
  } })
  const [[lock]] = await db.execute('SELECT GET_LOCK(?,0) acquired', [`aurum:inplace:${target}`]); assert.equal(Number(lock.acquired), 1); locked = true
  const [triggers] = await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()'); assert.equal(triggers.length, 0)
  const prior = await load(new URL(`docs/architecture/review-archive-${side}-v1-20260911.json`, root)); assert.ok(prior.passed)
  const backup = await load(new URL('docs/architecture/inference-restored-baseline-20260910.json', root))
  const receipt = await readFile(join(backup.archiveDirectory, 'receipt.json'))
  assert.equal(createHash('sha256').update(receipt).digest('hex'), prior.backupReceiptSha256)
  let metadata
  const snapshot = async () => {
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try { const result = await readAccountRootSnapshot(db); metadata = result.metadata; return result.tables.map(row => ({ ...row, ddl: row.ddl.replace(/ AUTO_INCREMENT=\d+/g, '') })) }
    finally { await db.rollback() }
  }
  const observed = await snapshot(), baselinePath = new URL(`docs/architecture/review-history-cases-${side}-baseline-20260911.json`, root)
  let before
  try { const saved = await load(baselinePath); assert.equal(saved.manifestHash, manifestHash); before = saved.tables } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!before) {
    assert.equal(hash(observed), prior.afterSnapshotHash, 'review_archive_baseline_changed'); before = observed
    const file = await open(baselinePath, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ manifestHash, target, tables: before }) + '\n') } finally { await file.close() }
  }
  const repository = new MysqlBackfillRepository(pool)
  const work = async (tx, batch, fail = false) => {
    const run = await tx.findRun(runId)
    if (run) assert.equal(run.bindingsHash, hash(bindings))
    else await tx.insertRun(runId, bindings, hash(bindings))
    if (!await tx.findCheckpoint(runId, batch.streamId)) await tx.insertCheckpoint(runId, batch.streamId)
    const result = await batch.execute(tx)
    if (fail) throw new BackfillError('review_archive_injected_rollback')
    return result
  }
  const cursors = new Map(), sequences = new Map()
  for (const expected of proof.bundles) {
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    let bundle, accountId
    try {
      bundle = await readReviewHistoryArchive(db, { runId: archiveRunId, sourceTable: expected.table, sourceId: expected.id, expectedBundleHash: expected.sourceHash })
      const original = bundle.rows[expected.table][0]
      const sourcePkHash = hash([{ type: 'integer', value: original.trading_account_id }])
      const [maps] = await db.execute("SELECT target_json FROM data_migration_id_maps WHERE logical_source_id='dev_vue' AND entity_kind='trading_account' AND source_table='trading_accounts' AND source_pk_sha256=?", [sourcePkHash])
      assert.equal(maps.length, 1)
      const mapping = typeof maps[0].target_json === 'string' ? JSON.parse(maps[0].target_json) : maps[0].target_json
      assert.equal(mapping.table, 'trading_accounts'); accountId = mapping.pk[0].value
    } finally { await db.rollback() }
    const source = { id: expected.id, table: expected.table, archiveRunId, bundleHash: expected.sourceHash }
    const projection = projectArchivedReviewCase(bundle, { archiveRunId, accountId })
    const entry = { source, sourceHash: hash(source), projection }
    const sequence = (sequences.get(expected.table) ?? 0) + 1
    const batch = createReviewHistoryCaseBatch(entry, { runId, logicalSourceId: 'dev_vue', bindings, sequence,
      startCursor: cursors.get(expected.table) ?? null })
    if (side === 'restored' && report.cases === 0) {
      const initial = await snapshot()
      await assert.rejects(repository.transaction(tx => work(tx, batch, true)), { code: 'review_archive_injected_rollback' })
      assert.equal(hash(await snapshot()), hash(initial)); report.rollbackVerified = true
    }
    await repository.transaction(tx => work(tx, batch))
    assert.ok((await repository.transaction(tx => work(tx, batch))).replayed)
    cursors.set(expected.table, [{ type: 'integer', value: expected.id }]); sequences.set(expected.table, sequence)
    report.cases++; report.versions += projection.versions.length; report.userStates += projection.userStates.length
  }
  const after = await snapshot()
  assert.equal(hash(before.filter(row => !ledger.includes(row.name) && !reviewProjectionTables.includes(row.name))), hash(after.filter(row => !ledger.includes(row.name) && !reviewProjectionTables.includes(row.name))))
  assert.deepEqual(before.map(row => [row.name, row.ddl]), after.map(row => [row.name, row.ddl]))
  for (const table of ledger) {
    const meta = metadata.get(table), column = table === 'data_migration_runs' ? 'id' : table === 'data_migration_id_maps' ? 'created_run_id' : 'run_id'
    const digest = createHash('sha256'), q = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return '`' + name + '`' }
    const stream = db.connection.query({ sql: `SELECT ${meta.columns.map(q).join(',')} FROM ${table} WHERE ${q(column)}<>? ORDER BY ${meta.primary.map(q).join(',')}`, values: [runId], rowsAsArray: true }).stream({ highWaterMark: 16 })
    let rows = 0
    for await (const row of stream) { digest.update(JSON.stringify(row)); digest.update('\n'); rows++ }
    const old = before.find(row => row.name === table); assert.equal(rows, old.rows); assert.equal(digest.digest('hex'), old.rowsSha256)
  }
  assert.equal(report.cases, 183); assert.equal(report.versions, 34); assert.equal(report.userStates, 33)
  assert.deepEqual(reviewProjectionTables.map(name => after.find(row => row.name === name).rows), [183, 183, 34, 34, 33])
  Object.assign(report, { passed: true, replayNoAdditionalRows: true, oldDataAndLedgerUnchanged: true, caseTargetsVerified: true, afterHash: hash(after) })
} catch (error) { report.errorCode = error?.code ?? error?.name; report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3); process.exitCode = 1 }
finally {
  if (db) { if (locked) await db.execute('SELECT RELEASE_LOCK(?)', [`aurum:inplace:${target}`]); db.release() }
  await pool.end(); report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close(); console.log(JSON.stringify(report))
}
