import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { BackfillError, hash } from './lib/v4-backfill-contract.mjs'
import { projectStrategySubscriptionTransition } from './lib/strategy-subscription-transition.mjs'
import { readStrategyTransitionInputs } from './lib/strategy-transition-inputs.mjs'
import { createStrategySourceBatch } from './lib/strategy-source-batch.mjs'
import { createCanonicalSubscriptionSourceBatch } from './lib/subscription-canonical-source-batch.mjs'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { runLocalBackupProcess, discardLocalBackupOutput } from './lib/local-backup-process.mjs'
import { assertMysqlExecutionWorkflowSchemaReady } from '../server/dist-v4/modules/execution/composition.js'
import { loadParentDispatchUpgrade } from './lib/parent-dispatch-upgrade.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--prepare', '--restored-only', '--apply-current'].includes(mode) && isAbsolute(destination ?? '') && process.argv.length === 4)
const directory = 'D:/dev_codex/.backup-core-20260910-01'
const candidatePath = join(directory, 'strategy-subscription-transition-v1.json')
const root = new URL('../', import.meta.url), load = async path => JSON.parse(await readFile(path, 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
await runLocalBackupProcess({ command: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  args: ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/private-local-backup-directory.ps1'), '-Mode', 'Verify', '-Path', directory],
  consume: discardLocalBackupOutput, timeoutMs: 15000 })
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
const target = mode === '--restored-only' ? 'dev_vue_m1_source_20260910_02' : 'dev_vue'
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'strategy-subscription-data-transition/v1', mode, target, passed: false, currentDevVueWrites: 0, runtimeEnabled: false }
const pool = mysql.createPool({ ...credentials, database: target, timezone: 'Z', dateStrings: true, jsonStrings: true,
  supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectionLimit: 2 })
const targets = ['strategies', 'strategy_versions', 'strategy_subscriptions', 'subscription_schedules', 'subscription_execution_preferences']
const ledgers = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches', 'data_migration_row_receipts', 'data_migration_source_rows', 'data_migration_id_maps']
const normalizeTables = tables => tables.map(row => ({ ...row, ddl: row.ddl.replace(/ AUTO_INCREMENT=\d+/g, '') }))
let connection, locked = false
try {
  connection = await pool.getConnection()
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  await assertMysqlExecutionWorkflowSchemaReady({ async getConnection() {
    const db = await pool.getConnection()
    try { await db.query("SET SESSION time_zone='+00:00'"); return db }
    catch (error) { db.release(); throw error }
  } })
  const [[claim]] = await connection.execute('SELECT GET_LOCK(?,0) acquired', [`aurum:inplace:${target}`])
  assert.equal(Number(claim.acquired), 1); locked = true
  const [triggers] = await connection.query('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')
  assert.equal(triggers.length, 0, 'transition_unexpected_trigger')
  const snapshot = async () => {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try { return normalizeTables((await readAccountRootSnapshot(connection)).tables) }
    finally { await connection.rollback() }
  }
  const inputs = await readStrategyTransitionInputs(connection)
  const inventory = await load(new URL('docs/architecture/strategy-canonical-inventory-v4-20260911.json', root))
  assert.ok(inventory.inspected)
  assert.equal(inputs.historyHash, inventory.historyHash)
  for (const [rows, candidates] of [[inputs.strategies, inventory.strategyCandidates], [inputs.subscriptions, inventory.subscriptionCandidates]]) {
    assert.equal(rows.length, candidates.length)
    for (const row of rows) assert.equal(hash(row), candidates.find(item => item.sourceId === row.id)?.sourceHash)
  }
  report.stage = 'freeze_inputs'
  if (mode === '--prepare') {
    const maxima = {}
    for (const table of targets.slice(0, 3)) {
      const [[row]] = await connection.query(`SELECT CAST(COALESCE(MAX(id),0) AS CHAR) maximum FROM ${table}`)
      maxima[table] = row.maximum
    }
    const roleCandidates = await Promise.all(inputs.strategies.map(row => load(join(directory, `strategy-${row.id}-v${row.version}-role-candidate-v1.json`))))
    const projection = projectStrategySubscriptionTransition({ ...inputs, maxima, roleCandidates })
    const before = await snapshot()
    const candidate = { ...projection, inputsHash: hash(inputs), historyHash: inputs.historyHash, serverUuid: identity.uuid,
      targetBefore: before.filter(row => targets.includes(row.name)), maxima }
    // Construct the real writers before freezing; validates full field shapes and identities.
    const probeOptions = { runId: '11111111-1111-1111-1111-111111111111', logicalSourceId: 'dev_vue', bindings: { logicalSourceId: 'dev_vue' }, sequence: 1, startCursor: null }
    createStrategySourceBatch(candidate.strategyEntries, probeOptions)
    createCanonicalSubscriptionSourceBatch(candidate.subscriptionEntries, probeOptions)
    const file = await open(candidatePath, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(candidate, null, 2) + '\n') } finally { await file.close() }
    Object.assign(report, { candidateHash: hash(candidate), candidatePath, admissions: candidate.admissions,
      subscriptionAdmissions: candidate.subscriptionAdmissions, sourceRows: inputs.strategies.length + inputs.subscriptions.length })
  } else {
    const candidate = await load(candidatePath)
    const candidateHash = hash(candidate), digest = hash({ purpose: candidate.kind, candidateHash })
    const runId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
    assert.equal(hash(inputs), candidate.inputsHash, 'transition_inputs_changed')
    assert.equal(candidate.serverUuid, identity.uuid)
    const side = mode === '--apply-current' ? 'current' : 'restored'
    if (mode === '--apply-current') {
      const rehearsal = await load(new URL('docs/architecture/strategy-subscription-transition-restored-v3-20260911.json', root))
      assert.ok(rehearsal.passed && rehearsal.failedBatchRolledBack && rehearsal.replayedAfterCommitUnknown && rehearsal.fullForeignKeysRetained)
      assert.equal(rehearsal.candidateHash, hash(candidate), 'transition_rehearsed_candidate_changed')
      const resumed = await load(new URL('docs/architecture/strategy-subscription-transition-restored-v4-20260911.json', root))
      assert.ok(resumed.passed && resumed.resumedCommittedRun && resumed.oldMigrationLedgerUnchanged && resumed.replayNoAdditionalRows)
      assert.equal(resumed.candidateHash, hash(candidate))
    }
    const baseline = await load(new URL(`docs/architecture/parent-dispatch-${side}-baseline-20260911.json`, root))
    assert.equal(baseline.target, target)
    const proof = await load(new URL('docs/architecture/inference-restored-baseline-20260910.json', root))
    const receiptBytes = await readFile(join(proof.archiveDirectory, 'receipt.json'))
    assert.equal(sha(receiptBytes), baseline.receiptSha256)
    const receipt = JSON.parse(receiptBytes)
    assert.ok(receipt.status === 'verified' && receipt.parity.matched && receipt.sourceUnchanged)
    const prior = await load(new URL(`docs/architecture/parent-dispatch-${side}-v1-20260911.json`, root))
    assert.ok(prior.passed && prior.target === target && prior.receiptSha256 === baseline.receiptSha256)
    const observed = await snapshot()
    const [[run]] = await connection.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [runId])
    const alreadyCommitted = Number(run.n) === 1
    let before = observed, savedBaseline
    const baselinePath = join(directory, `strategy-subscription-${side}-before-v1.json`)
    try { savedBaseline = await load(baselinePath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (savedBaseline) {
      assert.equal(savedBaseline.target, target); assert.equal(savedBaseline.runId, runId); assert.equal(savedBaseline.candidateHash, candidateHash)
      before = savedBaseline.tables
    } else if (alreadyCommitted) {
      // Compatibility with the first successful restored rehearsal, which saved
      // its baseline hash publicly and the 239-step source snapshot separately.
      assert.equal(mode, '--restored-only')
      const priorTransition = await load(new URL('docs/architecture/strategy-subscription-transition-restored-v3-20260911.json', root))
      assert.ok(priorTransition.passed && priorTransition.runId === runId && priorTransition.candidateHash === candidateHash)
      before = observed.map(row => normalizeTables(baseline.tables).find(old => old.name === row.name && row.name !== 'database_upgrade_steps_v4') ?? row)
      assert.equal(hash(before), priorTransition.beforeHash)
    }
    if (!alreadyCommitted) assert.equal(hash(observed), hash(before), 'transition_precommit_baseline_changed')
    const plan = await loadParentDispatchUpgrade(root)
    assert.equal(observed.length, Object.keys(plan.finalTableHashes).length)
    for (const table of observed) assert.equal(tableDefinitionHash(table.ddl), plan.finalTableHashes[table.name], 'transition_schema_changed')
    const original = rows => rows.filter(row => !['database_upgrade_steps_v4', 'partial_close_parent_dispatches_v4'].includes(row.name))
    report.baselineDifferences = original(before).filter(row => hash(row) !== hash(original(normalizeTables(baseline.tables)).find(old => old.name === row.name)))
      .map(row => ({ table: row.name, rows: row.rows, previousRows: baseline.tables.find(old => old.name === row.name).rows,
        ddlChanged: row.ddl !== normalizeTables(baseline.tables).find(old => old.name === row.name).ddl }))
    assert.equal(hash(original(before)), hash(original(normalizeTables(baseline.tables))), 'transition_restored_baseline_changed')
    assert.equal(hash(before.filter(row => targets.includes(row.name))), hash(candidate.targetBefore), 'transition_target_changed')
    const bindings = { logicalSourceId: 'dev_vue', purpose: candidate.kind, database: target, candidateHash, inputsHash: candidate.inputsHash,
      serverUuid: identity.uuid, historyHash: candidate.historyHash }
    const options = { runId, logicalSourceId: 'dev_vue', bindings, sequence: 1, startCursor: null }
    const batches = [createStrategySourceBatch(candidate.strategyEntries, options), createCanonicalSubscriptionSourceBatch(candidate.subscriptionEntries, options)]
    const repository = new MysqlBackfillRepository(pool)
    const work = async (tx, inject = false) => {
      assert.equal(hash(await readStrategyTransitionInputs(tx.connection, { lock: true })), candidate.inputsHash, 'transition_locked_inputs_changed')
      const existing = await tx.findRun(runId)
      if (existing) assert.equal(existing.bindingsHash, hash(bindings))
      else { await tx.insertRun(runId, bindings, hash(bindings)); for (const batch of batches) await tx.insertCheckpoint(runId, batch.streamId) }
      const results = []
      for (const batch of batches) results.push(await batch.execute(tx))
      if (inject) throw new BackfillError('transition_injected_rollback')
      return results
    }
    if (!savedBaseline) {
      const privateBaseline = await open(baselinePath, 'wx', 0o600)
      try { await privateBaseline.writeFile(JSON.stringify({ target, runId, candidateHash, tables: before }) + '\n') }
      finally { await privateBaseline.close() }
    }
    if (mode === '--restored-only' && !alreadyCommitted) {
      report.stage = 'rollback_rehearsal'
      await assert.rejects(repository.transaction(tx => work(tx, true)), { code: 'transition_injected_rollback' })
      assert.equal(hash(await snapshot()), hash(before), 'transition_rollback_changed_rows')
      report.failedBatchRolledBack = true
    }
    let loseAck = true
    const uncertain = new MysqlBackfillRepository({ async getConnection() {
      const db = await pool.getConnection()
      return new Proxy(db, { get(target, key) {
        if (key === 'commit') return async () => { await target.commit(); if (loseAck) { loseAck = false; throw Error('injected_ack_loss') } }
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
      } })
    } })
    report.stage = 'commit_and_replay'
    if (alreadyCommitted) {
      assert.ok((await repository.transaction(tx => work(tx))).every(row => row.replayed))
      report.resumedCommittedRun = true
    } else if (mode === '--restored-only') await assert.rejects(uncertain.transaction(tx => work(tx)), { code: 'backfill_commit_unknown' })
    else {
      report.writeAttempted = true
      report.currentDevVueWrites = null
      await repository.transaction(tx => work(tx))
      report.currentDevVueWrites = 27
    }
    const after = await snapshot(), replay = await repository.transaction(tx => work(tx))
    assert.ok(replay.every(row => row.replayed))
    assert.equal(hash(await snapshot()), hash(after), 'transition_replay_changed_rows')
    const untouched = rows => rows.filter(row => !targets.includes(row.name) && !ledgers.includes(row.name))
    assert.equal(hash(untouched(before)), hash(untouched(after)), 'transition_unrelated_data_changed')
    assert.equal(hash(before.map(row => [row.name, row.ddl])), hash(after.map(row => [row.name, row.ddl])))
    const deltas = Object.fromEntries(targets.map(name => [name, after.find(row => row.name === name).rows - before.find(row => row.name === name).rows]))
    assert.deepEqual(Object.values(deltas), [6, 6, 5, 5, 5])
    // Existing migration receipts/maps are data too. Verify every pre-existing
    // ledger row, excluding only this run's newly committed records.
    report.ledgerDeltas = {}
    const metadata = (await readAccountRootSnapshot(connection)).metadata
    for (const table of ledgers) {
      const column = table === 'data_migration_runs' ? 'id' : table === 'data_migration_id_maps' ? 'created_run_id' : 'run_id'
      const meta = metadata.get(table), digest = createHash('sha256')
      assert.ok(meta.columns.includes(column), 'transition_ledger_owner_column')
      const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
      const stream = connection.connection.query({ sql: `SELECT ${meta.columns.map(quote).join(',')} FROM ${table} WHERE ${quote(column)}<>? ORDER BY ${meta.primary.map(quote).join(',')}`,
        values: [runId], rowsAsArray: true }).stream({ highWaterMark: 16 })
      let rows = 0
      for await (const row of stream) { digest.update(JSON.stringify(row)); digest.update('\n'); rows++ }
      const old = before.find(row => row.name === table)
      assert.equal(rows, old.rows); assert.equal(digest.digest('hex'), old.rowsSha256, 'transition_old_ledger_changed')
      report.ledgerDeltas[table] = after.find(row => row.name === table).rows - old.rows
    }
    assert.deepEqual(Object.values(report.ledgerDeltas), [1, 2, 2, 8, 8, 17])
    Object.assign(report, { runId, candidateHash, targetDeltas: deltas, oldBusinessTablesUnchanged: true,
      replayedAfterCommitUnknown: mode === '--restored-only' && !alreadyCommitted, replayNoAdditionalRows: true, oldMigrationLedgerUnchanged: true,
      backupReceiptSha256: baseline.receiptSha256, fullForeignKeysRetained: true, beforeHash: hash(before), afterHash: hash(after),
      admissions: candidate.admissions, subscriptionAdmissions: candidate.subscriptionAdmissions })
  }
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'transition_failed'
  // Assertion identifiers only; never emit source rows, SQL or prompt contents.
  if (typeof error?.message === 'string' && /^[a-z][a-z0-9_]+$/.test(error.message)) report.reason = error.message
  report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4)
  process.exitCode = 1
} finally {
  if (connection && locked) await connection.execute('SELECT RELEASE_LOCK(?) released', [`aurum:inplace:${target}`])
  if (connection) connection.release()
  await pool.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
