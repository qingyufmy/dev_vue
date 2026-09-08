import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash, validateSpec } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { withAccountRootWriteFreeze } from './lib/account-root-write-freeze.mjs'
import { readAccountBackfillV2Identity } from './lib/mysql-account-backfill-v2.mjs'
import { readCurrentAccountWave } from './lib/current-account-wave-runtime.mjs'
import { verifyCurrentWaveState } from './lib/current-account-wave-state.mjs'
import { verifyCurrentAccountWaveReceipts } from './lib/current-account-wave-receipts.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { loadAccountRootMigration, prepareAccountRootMigrationProof, coordinateAccountRootMigration } from './lib/inplace-account-root-migration.mjs'
import { freezeAccountRootMigrationTools, persistAccountRootMigrationProof, mysqlAccountRootMigrationStore } from './lib/mysql-account-root-migration.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const toolsMatch = async tools => { for (const tool of tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256) }
const paths = ['docs/architecture/current-account-wave-preparation-20260908.json',
  'docs/architecture/current-account-wave-execution-plan-20260908.json', 'docs/architecture/current-account-wave-applied-20260908.json',
  'docs/architecture/current-local-backup-restoration-20260908.json', 'docs/architecture/account-root-write-freeze-probe-20260908-v4.json',
  'scripts/promote-current-account-root-local.mjs', 'scripts/lib/current-account-wave-receipts.mjs']
let connection, observer, output, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare', '--inspect', '--apply'].includes(mode) && process.argv.length === 5)
  assert.ok(isAbsolute(proofPath ?? '') && isAbsolute(destination ?? '') && proofPath !== destination && proofPath + '.current.json' !== destination)
  output = await open(destination, 'wx', 0o600)
  const source = await json(paths[0]), wave = await json(paths[1]), applied = await json(paths[2]), backup = await json(paths[3]), probe = await json(paths[4])
  assert.equal(hash(source.frozen), source.manifestHash); assert.equal(hash(wave.frozen), wave.manifestHash)
  assert.equal(wave.frozen.preparationManifestHash, source.manifestHash)
  assert.equal(applied.manifestHash, wave.manifestHash); assert.equal(applied.complete, true); assert.equal(applied.target, target)
  assert.equal(sha256(await readFile(wave.frozen.backup.path)), wave.frozen.backup.sha256)
  assert.equal(backup.status, 'verified'); assert.equal(backup.source, target)
  assert.equal(backup.preparationManifestHash, source.manifestHash)
  assert.equal(probe.temporaryDatabaseRemoved, true); assert.equal(probe.checks.length, 7)
  await toolsMatch([...source.frozen.tools, ...wave.frozen.tools, ...applied.tools, ...backup.tools, ...probe.tools])
  if (mode !== '--prepare') {
    const binding = await json(proofPath + '.current.json')
    assert.equal(hash(binding.frozen), binding.manifestHash)
    assert.equal(binding.frozen.kind, 'current-account-root-binding/v1')
    assert.equal(binding.frozen.waveManifestHash, wave.manifestHash)
    assert.equal(binding.frozen.proofFileSha256, sha256(await readFile(proofPath)))
    assert.deepEqual(binding.frozen.tools.map(tool => tool.path), paths)
    await toolsMatch(binding.frozen.tools)
  }
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.port, 13316); assert.equal(credentials.user, 'root')
  const connect = () => mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectTimeout: 5000 })
  connection = await connect(); observer = await connect()
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadAccountRootMigration(root)
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    const [names] = await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
    let expectedNames = names.map(row => row.name)
    phase = 'write-freeze'
    return withAccountRootWriteFreeze(connection, observer, target, expectedNames, async held => {
      if (mode === '--prepare') {
        phase = 'current-schema'
        assert.deepEqual(await readAccountBackfillV2Identity(connection), wave.frozen.targetIdentity)
        phase = 'current-source'
        const current = await readCurrentAccountWave(connection)
        assert.equal(current.inputSha256, source.frozen.inputSha256)
        const prepared = [current.account, current.interval]
        const specs = prepared.map((stream, index) => {
          const run = wave.frozen.runs[index]
          assert.equal(stream.transformHash, run.transformHash); assert.equal(stream.sourceRows, run.sourceRows)
          assert.deepEqual(stream.stream, run.stream)
          assert.deepEqual(stream.batches.map(batch => ({ batchId: batch.batchId, sequence: batch.sequence, rows: batch.rows.length })), run.batches)
          const spec = { runId: run.runId, admission: { approved: true, blockers: [] }, bindings: {
            logicalSourceId: target, sourceDatabase: target, mirrorDatabase: wave.frozen.backup.mirrorDatabase, targetDatabase: target,
            targetServerUuid: wave.frozen.targetIdentity.serverUuid, storageMode: 'inplace-account-v2', schemaHash: wave.frozen.targetIdentity.schemaHash,
            snapshotHash: wave.frozen.sourceSnapshotHash, manifestHash: wave.manifestHash, transformHash: stream.transformHash, streams: [stream.stream],
          } }
          validateSpec(spec); return spec
        })
        phase = 'current-state'
        const state = await verifyCurrentWaveState(connection, source.frozen, specs.map(spec => spec.runId), prepared, true)
        assert.deepEqual(state, applied.after)
        phase = 'current-receipts'
        await verifyCurrentAccountWaveReceipts(connection, prepared, specs)
        phase = 'snapshot'
        const snapshot = await readAccountRootSnapshot(connection)
        await held.assertHeld(expectedNames)
        const proof = prepareAccountRootMigrationProof(plan, { database: target, serverUuid: wave.frozen.targetIdentity.serverUuid },
          snapshot.tables, await freezeAccountRootMigrationTools(root))
        await persistAccountRootMigrationProof(proofPath, proof)
        const tools = await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
        const frozen = { kind: 'current-account-root-binding/v1', waveManifestHash: wave.manifestHash,
          proofFileSha256: sha256(await readFile(proofPath)), state, tools }
        await persistAccountRootMigrationProof(proofPath + '.current.json', { frozen, manifestHash: hash(frozen) })
      }
      phase = 'coordinate'
      const store = await mysqlAccountRootMigrationStore(connection, plan, root, proofPath)
      const proof = await store.proof()
      assert.deepEqual(proof.identity, { database: target, serverUuid: wave.frozen.targetIdentity.serverUuid })
      const shape = names => JSON.stringify([...names].sort())
      assert.ok([proof.before, proof.after].some(rows => shape(rows.map(row => row.name)) === shape(expectedNames)))
      for (const name of ['history', 'snapshot', 'verifyPrior', 'begin', 'complete']) {
        const original = store[name]
        store[name] = async (...args) => { await held.assertHeld(expectedNames); return original(...args) }
      }
      const execute = store.execute
      store.execute = async sql => {
        await held.assertHeld(expectedNames)
        await execute(sql)
        expectedNames = proof.after.map(row => row.name)
        await held.assertHeld(expectedNames)
      }
      const result = await coordinateAccountRootMigration(store, plan, { apply: mode === '--apply' })
      await held.assertHeld(expectedNames)
      return { kind: 'current-account-root-migration-result/v1', observedAt: new Date().toISOString(), target, mode,
        result, proofHash: proof.proofHash, registrySteps: plan.steps.length, waveManifestHash: wave.manifestHash,
        runtimeActivated: false, scope: 'Current database root promotion only; legacy rows preserved. Later migrations and runtime integration remain pending.' }
    })
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify(receipt))
} catch (error) {
  const code = /^account_root_(?:freeze|migration|store)_[a-z_]+$/.test(error.message ?? '') ? error.message
    : /^ER_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'current_account_root_failed'
  if (output) { await output.writeFile(JSON.stringify({ failed: true, phase, code }) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify({ failed: true, phase, code })); process.exitCode = 1
} finally { if (connection) connection.destroy(); if (observer) observer.destroy(); if (output) await output.close() }
