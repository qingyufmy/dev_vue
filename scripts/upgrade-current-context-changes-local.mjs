import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { persistAccountRootMigrationProof } from './lib/mysql-account-root-migration.mjs'
import { loadTradingContextChanges } from './lib/inplace-trading-context-changes.mjs'
import { coordinateContextChanges } from './lib/context-changes-coordinator.mjs'
import { coordinateLegacyCandlePromotion } from './lib/inplace-legacy-candle-promotion.mjs'
import { mysqlLegacyCandlePromotionStore } from './lib/mysql-current-legacy-candle-promotion.mjs'
import { freezeContextChangesTools, prepareContextChangesProof, mysqlContextChangesStore } from './lib/mysql-current-context-changes.mjs'

const root = new URL('../', import.meta.url), database = 'dev_vue'
const path = name => fileURLToPath(new URL('docs/architecture/' + name, root))
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let connection, output, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare', '--inspect', '--apply'].includes(mode) && process.argv.length === 5
    && isAbsolute(proofPath) && isAbsolute(destination) && proofPath !== destination)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.user === 'root' && credential.port === 13316)
  connection = await mysql.createConnection({ host: credential.host, port: credential.port, user: 'root', password: credential.password,
    database, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION lock_wait_timeout=5')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@version version,CONNECTION_ID() id')
  assert.equal(identity.db, database); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const noOtherClients = async () => {
    const [[row]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=? AND ID<>?', [database, identity.id])
    assert.equal(Number(row.n), 0, 'context_changes_other_clients')
  }
  const report = await withInplaceUpgradeLock(connection, database, async () => {
    await noOtherClients()
    const plan = await loadTradingContextChanges(root)
    const priorPaths = { proof: path('current-legacy-candle-promotion-proof-20260908.json'), build: path('current-legacy-candle-build-proof-20260908.json'),
      projection: path('current-account-projection-proof-20260908.json'), observer: path('current-observer-context-proof-20260908.json'),
      terminal: path('current-terminal-route-proof-20260908.json'), account: path('current-account-root-proof-20260908.json') }
    if (mode === '--prepare') {
      phase = 'prepare'
      const prior = await mysqlLegacyCandlePromotionStore(connection, plan.prior, root, priorPaths)
      assert.equal((await coordinateLegacyCandlePromotion(prior, plan.prior)).status, 'completed')
      const snapshot = await prior.snapshot(), history = await prior.history(), priorProof = await prior.proof()
      assert.deepEqual(snapshot, priorProof.after)
      const [[parent]] = await connection.execute('SELECT COLUMN_TYPE columnType,COLUMN_KEY columnKey,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', ['users', 'id'])
      assert.deepEqual(parent, { columnType: 'int', columnKey: 'PRI', nullable: 'NO' })
      const reference = await json(path('current-context-receipt-schema-reference-20260908.json'))
      assert.equal(reference.identity.version, identity.version)
      const proof = prepareContextChangesProof(plan, await prior.identity(), priorProof, snapshot, reference,
        await freezeContextChangesTools(root), history)
      assert.deepEqual(await prior.snapshot(), snapshot); assert.deepEqual(await prior.history(), history)
      await noOtherClients()
      await persistAccountRootMigrationProof(proofPath, proof)
    }
    phase = 'coordinate'
    const store = await mysqlContextChangesStore(connection, plan, root, proofPath, priorPaths)
    let journalWrites = 0
    for (const name of ['begin', 'execute', 'complete']) {
      const original = store[name]
      store[name] = async step => {
        await noOtherClients()
        const result = await original(step)
        if (name !== 'execute') journalWrites++
        return result
      }
    }
    const result = await coordinateContextChanges(store, plan, { apply: mode === '--apply' })
    phase = 'verify-result'
    const proof = await store.proof(), snapshot = await store.snapshot()
    assert.deepEqual(snapshot.filter(row => row.name !== plan.additions[0].table), proof.priorSnapshot)
    const history = await store.history(), priorIds = new Set(plan.prior.steps.map(row => row.id))
    assert.equal(hash(history.filter(row => priorIds.has(row.id))), proof.priorHistoryHash)
    const table = await store.tableState(plan.additions[0])
    assert.ok(table === null || (table.matches && table.rows === 0))
    await noOtherClients()
    return { kind: 'current-context-changes-result/v1', observedAt: new Date().toISOString(), identity: await store.identity(),
      mode, result, journalWrites, proofHash: proof.proofHash, registrySteps: plan.steps.length,
      completedSteps: history.filter(row => row.status === 'completed').length, tools: proof.tools.length,
      tableCount: snapshot.length, priorSnapshotHash: hash(proof.priorSnapshot), priorHistoryHash: proof.priorHistoryHash, table,
      currentDevVueWritten: result.ddlCount > 0 || journalWrites > 0, runtimeActivated: false,
      scope: 'Current database append-only empty receipt table; prior rows and history reconciled. Other-client observation is not a database-wide write lock. No runtime activation.' }
  })
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ result: report.result, completedSteps: report.completedSteps, tableCount: report.tableCount, journalWrites: report.journalWrites }))
} catch (error) {
  const cause = error?.cause ?? error
  const failure = { failed: true, phase, code: /^(context_changes_|legacy_candle_|account_root_|inplace_)[a-z_]+$/.test(error?.message ?? '') ? error.message : 'current_context_changes_failed',
    databaseError: /^ER_[A-Z_]+$/.test(cause?.code ?? '') ? cause.code : undefined }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (connection) connection.destroy(); if (output) await output.close().catch(() => {}) }
