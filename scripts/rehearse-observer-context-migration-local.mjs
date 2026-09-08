import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadObserverContextMigration } from './lib/inplace-observer-context-migration.mjs'
import { coordinateTerminalRouteMigration } from './lib/terminal-route-coordinator.mjs'
import { mysqlTerminalRouteMigrationStore } from './lib/mysql-terminal-route-migration.mjs'
import { freezeObserverContextTools, prepareObserverContextProof, persistObserverContextProof, mysqlObserverContextMigrationStore } from './lib/mysql-observer-context-migration.mjs'
import { coordinateObserverContextMigration } from './lib/observer-context-coordinator.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
const rootProofPath = new URL('docs/architecture/account-root-registered-plan-20260908.json', root)
const priorProofPath = new URL('docs/architecture/terminal-route-registered-plan-20260908.json', root)
const referencePath = new URL('docs/architecture/observer-context-reference-20260908.json', root)
let connection, output, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare-restored-only', '--read-only-restored', '--apply-restored-only', '--apply-lost-ddl-restored-only'].includes(mode)
    && process.argv.length === 5 && isAbsolute(proofPath) && isAbsolute(destination) && proofPath !== destination)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[row]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@version version')
  assert.equal(row.db, target); assert.equal(row.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    const plan = await loadObserverContextMigration(root)
    // URL is resolved to a native absolute path before reaching the adapter.
    const { fileURLToPath } = await import('node:url')
    const rootPath = fileURLToPath(rootProofPath), priorPath = fileURLToPath(priorProofPath)
    if (mode === '--prepare-restored-only') {
      phase = 'prepare-preconditions'
      const priorStore = await mysqlTerminalRouteMigrationStore(connection, plan.prior, root, priorPath, rootPath)
      const rootStore = priorStore.rootStore
      assert.ok((await coordinateTerminalRouteMigration(priorStore, plan.prior)).steps.every(step => step.status === 'completed'))
      const priorProof = JSON.parse(await readFile(priorPath, 'utf8'))
      const reference = JSON.parse(await readFile(referencePath, 'utf8'))
      const { proofHash, ...body } = reference
      assert.equal(proofHash, hash(body)); assert.equal(reference.kind, 'observer-context-reference/v1')
      assert.equal(reference.referenceRemoved, true); assert.equal(reference.sourceWritten, false)
      assert.deepEqual(reference.identity, await rootStore.identity()); assert.equal(reference.mysqlVersion, row.version)
      assert.equal(reference.priorProofHash, priorProof.proofHash)
      assert.equal(reference.registryHash, hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))))
      assert.equal(reference.captureToolHash, sha256(await readFile(new URL('scripts/capture-observer-context-reference-local.mjs', root))))
      assert.equal(reference.constraintToolHash, sha256(await readFile(new URL('scripts/lib/observer-context-reference-checks.mjs', root))))
      assert.equal(reference.constraintChecks.length, 18); assert.ok(reference.constraintChecks.every(check => check.passed === true))
      const snapshot = await rootStore.snapshot()
      assert.equal(hash(snapshot), reference.sourceSnapshotHash); assert.equal(hash(await rootStore.history()), reference.sourceHistoryHash)
      const proof = prepareObserverContextProof(plan, await rootStore.identity(), priorProof, snapshot, reference, await freezeObserverContextTools(root))
      await persistObserverContextProof(proofPath, proof)
    }
    phase = 'coordinate'
    const store = await mysqlObserverContextMigrationStore(connection, plan, root, proofPath, priorPath, rootPath)
    let result
    if (mode === '--apply-lost-ddl-restored-only') {
      let ddlCount = 0
      const execute = store.execute
      store.execute = async step => { await execute(step); ddlCount++; throw Error('injected_lost_ddl_response') }
      await assert.rejects(coordinateObserverContextMigration(store, plan, { apply: true }), /observer_context_ddl_unknown/)
      assert.equal(ddlCount, 1); result = { status: 'ddl-unknown-injected', ddlCount }
    } else result = await coordinateObserverContextMigration(store, plan, { apply: mode === '--apply-restored-only' })
    phase = 'result-verification'
    const proof = JSON.parse(await readFile(proofPath, 'utf8'))
    const reference = JSON.parse(await readFile(referencePath, 'utf8'))
    const additionNames = new Set(plan.additions.map(step => step.table)), priorIds = new Set(plan.prior.steps.map(step => step.id))
    const snapshot = await store.priorStore.rootStore.snapshot()
    const protectedSnapshot = snapshot.filter(table => !additionNames.has(table.name))
    assert.deepEqual(protectedSnapshot, proof.priorSnapshot)
    assert.equal(hash((await store.history()).filter(step => priorIds.has(step.id))), reference.sourceHistoryHash)
    const addedTables = snapshot.filter(table => additionNames.has(table.name)).map(({ name, rows, schemaSha256 }) => ({ name, rows, schemaSha256 }))
    assert.ok(addedTables.every(table => table.rows === 0))
    return { kind: 'observer-context-registered-rehearsal/v1', observedAt: new Date().toISOString(), target, mode, result,
      registrySteps: plan.steps.length, proofHash: proof.proofHash, protectedTableCount: protectedSnapshot.length,
      protectedSnapshotHash: hash(protectedSnapshot), priorHistoryHash: reference.sourceHistoryHash, addedTables,
      currentDevVueWritten: false, scope: 'Restored database only; registered additions and history retained. No business facts synthesized.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify(receipt))
} catch (error) {
  const code = /^observer_context_(?:store_)?[a-z_]+$/.test(error?.message ?? '') ? error.message : 'observer_context_rehearsal_failed'
  const failure = { failed: true, code, phase, target }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
