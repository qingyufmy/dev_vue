import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, open } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash, BackfillError } from './lib/v4-backfill-contract.mjs'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { memoryTables, readMemorySources, projectMemoryTransition, createMemoryTransitionBatch } from './lib/strategy-memory-transition.mjs'
import { runLocalBackupProcess, discardLocalBackupOutput } from './lib/local-backup-process.mjs'
import { assertMysqlExecutionWorkflowSchemaReady } from '../server/dist-v4/modules/execution/composition.js'
import { createMysqlRuntimeStrategyMemoryReader } from '../server/dist-v4/modules/reviews/composition.js'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--restored', '--current'].includes(mode) && isAbsolute(destination ?? '') && process.argv.length === 4)
const side = mode.slice(2), target = side === 'current' ? 'dev_vue' : 'dev_vue_m1_source_20260910_02'
const directory = 'D:/dev_codex/.backup-core-20260910-01', root = new URL('../', import.meta.url)
const load = async path => JSON.parse(await readFile(path, 'utf8'))
await runLocalBackupProcess({ command: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  args: ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/private-local-backup-directory.ps1'), '-Mode', 'Verify', '-Path', directory], consume: discardLocalBackupOutput, timeoutMs: 15000 })
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'strategy-memory-data-transition/v1', passed: false, target, currentBusinessRowsInserted: 0, runtimeEnabled: false }
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
const pool = mysql.createPool({ ...credentials, database: target, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 2 })
const ledger = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches', 'data_migration_row_receipts', 'data_migration_source_rows', 'data_migration_id_maps']
let db, locked = false
try {
  db = await pool.getConnection(); await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  await assertMysqlExecutionWorkflowSchemaReady({ async getConnection() { const c = await pool.getConnection(); await c.query("SET SESSION time_zone='+00:00'"); return c } })
  const [[claim]] = await db.execute('SELECT GET_LOCK(?,0) acquired', [`aurum:inplace:${target}`]); assert.equal(Number(claim.acquired), 1); locked = true
  const [triggers] = await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()'); assert.equal(triggers.length, 0)
  let metadata
  const snapshot = async () => {
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try { const result = await readAccountRootSnapshot(db); metadata = result.metadata; return result.tables.map(row => ({ ...row, ddl: row.ddl.replace(/ AUTO_INCREMENT=\d+/g, '') })) }
    finally { await db.rollback() }
  }
  const prior = await load(new URL(`docs/architecture/strategy-receipt-${side}-v1-20260911.json`, root))
  assert.ok(prior.passed && prior.oldDataUnchanged && prior.target === target)
  const backup = await load(new URL('docs/architecture/inference-restored-baseline-20260910.json', root))
  const receipt = await readFile(join(backup.archiveDirectory, 'receipt.json'))
  assert.equal(createHash('sha256').update(receipt).digest('hex'), prior.backupReceiptSha256)
  const source = await readMemorySources(db)
  const [users] = await db.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
  const roleCandidate = await load(join(directory, 'strategy-subscription-transition-v1.json'))
  const entries = projectMemoryTransition(source, roleCandidate.strategyEntries, new Set(users.map(row => row.id)))
  assert.equal(entries.length, 2); assert.equal(entries.reduce((sum, entry) => sum + entry.source.revisions.length, 0), 20)
  const candidate = { entries, rolesHash: hash(roleCandidate), usersHash: hash(users.map(row => ({ ...row }))), sourceHash: hash(source) }
  const candidateHash = hash(candidate), candidatePath = join(directory, 'strategy-memory-transition-v1.json')
  let saved
  try { saved = await load(candidatePath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (saved) assert.equal(hash(saved), candidateHash)
  else {
    assert.equal(side, 'restored')
    const file = await open(candidatePath, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(candidate, null, 2) + '\n') } finally { await file.close() }
  }
  if (side === 'current') {
    const rehearsal = await load(new URL('docs/architecture/strategy-memory-restored-v2-20260911.json', root))
    const original = await load(new URL('docs/architecture/strategy-memory-restored-v1-20260911.json', root))
    assert.ok(rehearsal.passed && original.rollbackVerified && rehearsal.replayNoAdditionalRows && rehearsal.runtimeReaderVerifiedDisabled)
    assert.equal(original.candidateHash, candidateHash)
    assert.equal(rehearsal.candidateHash, candidateHash)
  }
  const h = hash(['memory-transition/v1', candidateHash]), runId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
  const baselinePath = join(directory, `strategy-memory-${side}-before-v1.json`)
  const observed = await snapshot()
  let before
  try { const baseline = await load(baselinePath); assert.equal(baseline.candidateHash, candidateHash); before = baseline.tables } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!before) {
    assert.equal(hash(observed), prior.afterSnapshotHash, 'memory_baseline_changed')
    before = observed
    const file = await open(baselinePath, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ target, candidateHash, tables: before }) + '\n') } finally { await file.close() }
  }
  for (const name of memoryTables) assert.equal(before.find(row => row.name === name).rows, 0)
  const [[existing]] = await db.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [runId])
  const resumed = Number(existing.n) === 1
  if (!resumed) assert.equal(hash(observed), hash(before))
  const bindings = { logicalSourceId: 'dev_vue', target, candidateHash, purpose: 'role-memory-history/v1' }
  const batch = createMemoryTransitionBatch(entries, { runId, logicalSourceId: 'dev_vue', bindings, sequence: 1, startCursor: null })
  const repository = new MysqlBackfillRepository(pool)
  const work = async (tx, fail = false) => {
    const run = await tx.findRun(runId)
    if (run) assert.equal(run.bindingsHash, hash(bindings))
    else { await tx.insertRun(runId, bindings, hash(bindings)); await tx.insertCheckpoint(runId, batch.streamId) }
    const result = await batch.execute(tx)
    if (fail) throw new BackfillError('memory_injected_rollback')
    return result
  }
  report.stage = 'transaction'
  if (side === 'restored' && !resumed) {
    await assert.rejects(repository.transaction(tx => work(tx, true)), { code: 'memory_injected_rollback' })
    assert.equal(hash(await snapshot()), hash(before)); report.rollbackVerified = true
  }
  report.writeAttempted = !resumed
  if (side === 'current' && !resumed) report.currentBusinessRowsInserted = null
  await repository.transaction(tx => work(tx))
  if (side === 'current' && !resumed) report.currentBusinessRowsInserted = 44
  const after = await snapshot()
  assert.ok((await repository.transaction(tx => work(tx))).replayed)
  assert.equal(hash(await snapshot()), hash(after))
  const unchanged = rows => rows.filter(row => !memoryTables.includes(row.name) && !ledger.includes(row.name))
  assert.equal(hash(unchanged(before)), hash(unchanged(after)))
  assert.deepEqual(before.map(row => [row.name, row.ddl]), after.map(row => [row.name, row.ddl]))
  const counts = memoryTables.map(name => after.find(row => row.name === name).rows)
  assert.deepEqual(counts, [4, 40])
  // Reconcile every pre-existing ledger row, not merely the unaffected business tables.
  for (const table of ledger) {
    const meta = metadata.get(table), column = table === 'data_migration_runs' ? 'id' : table === 'data_migration_id_maps' ? 'created_run_id' : 'run_id'
    const digest = createHash('sha256'), q = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
    const stream = db.connection.query({ sql: `SELECT ${meta.columns.map(q).join(',')} FROM ${table} WHERE ${q(column)}<>? ORDER BY ${meta.primary.map(q).join(',')}`, values: [runId], rowsAsArray: true }).stream({ highWaterMark: 16 })
    let rows = 0
    for await (const row of stream) { digest.update(JSON.stringify(row)); digest.update('\n'); rows++ }
    const old = before.find(row => row.name === table)
    assert.equal(rows, old.rows); assert.equal(digest.digest('hex'), old.rowsSha256)
  }
  if (side === 'restored') {
    // Exercise the real reader behind a temporarily active strategy; the memory
    // itself must remain disabled. All strategy changes are rolled back.
    await db.beginTransaction()
    try {
      const reader = createMysqlRuntimeStrategyMemoryReader(db)
      for (const entry of entries) for (const projection of entry.projections) {
        const role = roleCandidate.strategyEntries.find(row => row.source.id === entry.source.id).roles[projection.kind]
        assert.equal(role.strategy.status, 'draft')
        await db.execute("UPDATE strategies SET status='active',active_version_id=? WHERE id=? AND status='draft'", [role.version.id, role.strategy.id])
        const memory = await reader.read({ userId: Number(role.version.created_by_user_id), strategyId: role.strategy.id, strategyKind: projection.kind })
        assert.equal(memory.state, 'disabled'); assert.equal(memory.mode, 'shadow'); assert.equal(memory.status, 'revalidating')
        assert.equal(memory.contentText, null); assert.equal(memory.revisionId, projection.library.current_revision_id)
        assert.equal(memory.contentHash, entry.source.library.content_hash)
      }
    } finally { await db.rollback() }
    assert.equal(hash(await snapshot()), hash(after))
    report.runtimeReaderVerifiedDisabled = true
  }
  Object.assign(report, { passed: true, candidateHash, runId, libraries: 4, revisions: 40, sourceLibraries: 2, sourceRevisions: 20,
    replayNoAdditionalRows: true, oldDataAndLedgerUnchanged: true, beforeHash: hash(before), afterHash: hash(after), resumed })
} catch (error) {
  report.errorCode = error?.code ?? error?.name
  report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4)
  process.exitCode = 1
} finally {
  if (db) { if (locked) await db.execute('SELECT RELEASE_LOCK(?)', [`aurum:inplace:${target}`]); db.release() }
  await pool.end(); report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
