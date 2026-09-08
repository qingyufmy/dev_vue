import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash, canonical, validateSpec, streamIdentity } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { withAccountSourceFreeze } from './lib/account-source-freeze.mjs'
import { readAccountBackfillV2Identity, MysqlAccountBackfillV2Repository } from './lib/mysql-account-backfill-v2.mjs'
import { readCurrentAccountWave } from './lib/current-account-wave-runtime.mjs'
import { verifyCurrentWaveState } from './lib/current-account-wave-state.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './lib/v4-backfill-runner.mjs'
import { sourceEvidencePayload } from './lib/v4-source-row-evidence.mjs'

let control, reader, pool, phase = 'arguments'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
try {
  const [mode, destination] = process.argv.slice(2)
  assert.ok(['--apply', '--inspect'].includes(mode) && isAbsolute(destination ?? '') && process.argv.length === 4)
  const plan = await json('docs/architecture/current-account-wave-execution-plan-20260908.json')
  assert.equal(hash(plan.frozen), plan.manifestHash)
  const source = await json('docs/architecture/current-account-wave-preparation-20260908.json')
  assert.equal(hash(source.frozen), source.manifestHash); assert.equal(plan.frozen.preparationManifestHash, source.manifestHash)
  const backup = await readFile(plan.frozen.backup.path)
  assert.equal(sha256(backup), plan.frozen.backup.sha256)
  for (const tool of [...source.frozen.tools, ...plan.frozen.tools, ...JSON.parse(backup).tools]) assert.equal(sha256(await readFile(tool.path)), tool.sha256)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.port, 13316); assert.equal(credentials.user, 'root')
  const options = { host: credentials.host, port: credentials.port, user: 'root', password: credentials.password, database: 'dev_vue',
    timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 }
  control = await mysql.createConnection(options); reader = await mysql.createConnection(options); pool = mysql.createPool({ ...options, connectionLimit: 2 })
  const snapshot = async work => {
    await reader.query("SET SESSION time_zone='+00:00'"); await reader.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try { return await work() } finally { await reader.rollback() }
  }
  const result = await withInplaceUpgradeLock(control, 'dev_vue', () => withAccountSourceFreeze(control, 'dev_vue', async freeze => {
    phase = 'source-and-schema'
    const current = await snapshot(async () => {
      assert.deepEqual(await readAccountBackfillV2Identity(reader), plan.frozen.targetIdentity)
      return readCurrentAccountWave(reader)
    })
    assert.equal(current.inputSha256, source.frozen.inputSha256)
    const prepared = [current.account, current.interval]
    const specs = prepared.map((stream, index) => {
      const run = plan.frozen.runs[index]
      assert.equal(stream.transformHash, run.transformHash); assert.equal(stream.sourceRows, run.sourceRows)
      assert.deepEqual(stream.stream, run.stream)
      assert.deepEqual(stream.batches.map(batch => ({ batchId: batch.batchId, sequence: batch.sequence, rows: batch.rows.length })), run.batches)
      const spec = { runId: run.runId, admission: { approved: true, blockers: [] }, bindings: {
        logicalSourceId: 'dev_vue', sourceDatabase: 'dev_vue', mirrorDatabase: plan.frozen.backup.mirrorDatabase, targetDatabase: 'dev_vue',
        targetServerUuid: plan.frozen.targetIdentity.serverUuid, storageMode: 'inplace-account-v2', schemaHash: plan.frozen.targetIdentity.schemaHash,
        snapshotHash: plan.frozen.sourceSnapshotHash, manifestHash: plan.manifestHash, transformHash: stream.transformHash, streams: [stream.stream],
      } }
      validateSpec(spec); return spec
    })
    const ids = specs.map(spec => spec.runId)
    phase = 'existing-state'
    const before = await snapshot(() => verifyCurrentWaveState(reader, source.frozen, ids, prepared))
    const repository = new MysqlAccountBackfillV2Repository({ getConnection: async () => { await freeze.assertHeld(); return pool.getConnection() } })
    const batches = []
    if (mode === '--apply') for (let index = 0; index < prepared.length; index++) {
      const stream = prepared[index], spec = specs[index]
      phase = `prepare-run-${index}`; await prepareBackfillRun(repository, spec)
      for (const batch of stream.batches) {
        phase = `recover-${index}-${batch.sequence}`
        const existing = await recoverBackfillBatch(repository, spec, batch)
        assert.ok(['committed', 'not_committed'].includes(existing.status))
        phase = `write-${index}-${batch.sequence}`
        const saved = existing.status === 'committed' ? existing : await executeBackfillBatch(repository, spec, batch, stream.writer)
        assert.equal(saved.status, 'committed')
        batches.push({ runId: spec.runId, batchId: batch.batchId, sequence: batch.sequence, rows: batch.rows.length, replayed: existing.status === 'committed' })
      }
    }
    phase = 'final-state'
    const after = await snapshot(() => verifyCurrentWaveState(reader, source.frozen, ids, prepared, mode === '--apply'))
    if (mode === '--apply') {
      phase = 'receipt-reconciliation'
      for (let index = 0; index < prepared.length; index++) {
        const stream = prepared[index], spec = specs[index], sid = streamIdentity(stream.stream)
        const [[run]] = await reader.execute('SELECT bindings_sha256 fingerprint,bindings_json bindings FROM data_migration_runs WHERE id=?', [spec.runId])
        assert.equal(run.fingerprint, hash(spec.bindings)); assert.equal(canonical(JSON.parse(run.bindings)), canonical(spec.bindings))
        for (const batch of stream.batches) for (const row of batch.rows) {
          const [[saved]] = await reader.execute('SELECT batch_id batch,source_bytes_sha256 sourceHash,transformed_sha256 transformedHash,targets_json targets FROM data_migration_row_receipts WHERE run_id=? AND stream_id=? AND source_pk_sha256=?', [spec.runId, sid, hash(row.pk)])
          assert.equal(saved.batch, batch.batchId); assert.equal(saved.sourceHash, row.sourceHash); assert.equal(saved.transformedHash, row.transformedHash)
          assert.equal(canonical(JSON.parse(saved.targets)), canonical(row.targets))
          const [[evidence]] = await reader.execute('SELECT source_bytes_sha256 sourceHash,source_payload_json payload FROM data_migration_source_rows WHERE run_id=? AND stream_id=? AND source_pk_sha256=?', [spec.runId, sid, hash(row.pk)])
          assert.equal(evidence.sourceHash, row.sourceHash); assert.equal(canonical(JSON.parse(evidence.payload)), canonical(sourceEvidencePayload(sid, row)))
          for (const mapping of row.idMaps) {
            const [[savedMap]] = await reader.execute('SELECT source_pk_json sourcePk,target_json target,created_run_id runId FROM data_migration_id_maps WHERE logical_source_id=? AND entity_kind=? AND source_table=? AND source_pk_sha256=?',
              ['dev_vue', mapping.entityKind, mapping.sourceTable, hash(mapping.sourcePk)])
            assert.equal(savedMap.runId, spec.runId)
            assert.equal(canonical(JSON.parse(savedMap.sourcePk)), canonical(mapping.sourcePk))
            assert.equal(canonical(JSON.parse(savedMap.target)), canonical(mapping.target))
          }
        }
        for (const table of ['data_migration_row_receipts', 'data_migration_source_rows']) {
          const [[count]] = await reader.execute(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`, [spec.runId]); assert.equal(Number(count.n), stream.sourceRows)
        }
        const [[mapCount]] = await reader.execute('SELECT COUNT(*) n FROM data_migration_id_maps WHERE created_run_id=?', [spec.runId])
        assert.equal(Number(mapCount.n), stream.batches.flatMap(batch => batch.rows).reduce((sum, row) => sum + row.idMaps.length, 0))
        const [[checkpoint]] = await reader.execute('SELECT sequence_number sequenceNumber,processed_rows processedRows,cursor_json cursorValue FROM data_migration_checkpoints WHERE run_id=? AND stream_id=?', [spec.runId, sid])
        assert.equal(Number(checkpoint.sequenceNumber), stream.batches.length); assert.equal(Number(checkpoint.processedRows), stream.sourceRows)
        assert.equal(canonical(JSON.parse(checkpoint.cursorValue)), canonical(stream.batches.at(-1).endCursor))
        const [[batchCount]] = await reader.execute('SELECT COUNT(*) n FROM data_migration_batches WHERE run_id=?', [spec.runId])
        assert.equal(Number(batchCount.n), stream.batches.length)
        const [[checkpointCount]] = await reader.execute('SELECT COUNT(*) n FROM data_migration_checkpoints WHERE run_id=?', [spec.runId])
        assert.equal(Number(checkpointCount.n), 1)
      }
    }
    await freeze.assertHeld()
    const paths = ['scripts/execute-current-account-wave-local.mjs', 'scripts/lib/current-account-wave-runtime.mjs', 'scripts/lib/current-account-wave-state.mjs']
    const tools = await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(path)) })))
    return { kind: 'current-account-wave-result/v1', observedAt: new Date().toISOString(), mode, manifestHash: plan.manifestHash,
      target: 'dev_vue', before, after, batches, tools, complete: mode === '--apply', schemaPromoted: false,
      scope: 'Four build tables and six migration ledger tables only; protected original rows and prior ledger rows reconciled. No root table promotion or runtime activation.' }
  }))
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(result))
} catch (error) {
  const code = /^(?:backfill_[a-z_]+|ER_[A-Z_]+)$/.test(error?.code ?? '') ? error.code : 'current_account_wave_failed'
  console.error(JSON.stringify({ failed: true, code, phase })); process.exitCode = 1
} finally { if (reader) reader.destroy(); if (control) control.destroy(); if (pool) await pool.end() }
