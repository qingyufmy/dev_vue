import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadLegacyCandleBuildMigration } from './lib/inplace-legacy-candle-build-migration.mjs'
import { verifyLegacyCandleReference } from './lib/legacy-candle-reference-checks.mjs'
import { mysqlAccountProjectionMigrationStore } from './lib/mysql-current-account-projection-migration.mjs'
import { freezeLegacyCandleBuildTools, prepareLegacyCandleBuildProof, persistLegacyCandleBuildProof, mysqlLegacyCandleBuildMigrationStore } from './lib/mysql-current-legacy-candle-build-migration.mjs'
import { coordinateLegacyCandleBuildMigration } from './lib/legacy-candle-build-coordinator.mjs'
import { coordinateAccountProjectionMigration } from './lib/account-projection-coordinator.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue'
const rootPath = fileURLToPath(new URL('docs/architecture/current-account-root-proof-20260908.json', root))
const terminalPath = fileURLToPath(new URL('docs/architecture/current-terminal-route-proof-20260908.json', root))
const observerPath = fileURLToPath(new URL('docs/architecture/current-observer-context-proof-20260908.json', root))
const priorPath = fileURLToPath(new URL('docs/architecture/current-account-projection-proof-20260908.json', root))
const referencePath = fileURLToPath(new URL('docs/architecture/current-legacy-candle-build-reference-20260908.json', root))
const parents = ['trading_accounts', 'market_candles', 'market_data_sources'].map(table => ({
  table, columnType: 'bigint unsigned', charset: null, collation: null, type: 'BIGINT UNSIGNED',
}))
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const verifyTools = async tools => { for (const tool of tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256) }
const bindingPaths = ['scripts/upgrade-current-legacy-candle-build-local.mjs', 'docs/architecture/current-account-root-proof-20260908.json',
  'docs/architecture/current-account-root-proof-20260908.json.current.json', 'docs/architecture/current-account-root-applied-20260908.json',
  'docs/architecture/current-terminal-route-proof-20260908.json', 'docs/architecture/current-terminal-route-proof-20260908.json.current.json',
  'scripts/lib/mysql-current-legacy-candle-build-migration.mjs', 'docs/architecture/current-legacy-candle-build-reference-20260908.json',
  'docs/architecture/current-observer-context-proof-20260908.json', 'docs/architecture/current-observer-context-proof-20260908.json.current.json',
  'docs/architecture/current-account-projection-proof-20260908.json', 'docs/architecture/current-account-projection-proof-20260908.json.current.json']
let connection, referenceConnection, output, reference, referenceCreated = false, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare', '--inspect', '--apply'].includes(mode) && process.argv.length === 5)
  assert.ok(isAbsolute(proofPath ?? '') && isAbsolute(destination ?? '') && ![proofPath, proofPath + '.current.json', rootPath].includes(destination))
  output = await open(destination, 'wx', 0o600)
  const rootBinding = await json(rootPath + '.current.json')
  assert.equal(hash(rootBinding.frozen), rootBinding.manifestHash)
  assert.equal(sha256(await readFile(rootPath)), rootBinding.frozen.proofFileSha256)
  await verifyTools(rootBinding.frozen.tools)
  const priorBinding = await json(priorPath + '.current.json')
  assert.equal(hash(priorBinding.frozen), priorBinding.manifestHash)
  assert.equal(sha256(await readFile(priorPath)), priorBinding.frozen.proofFileSha256)
  await verifyTools(priorBinding.frozen.tools)
  const rootApplied = await json(bindingPaths[3])
  assert.equal(rootApplied.target, target); assert.equal(rootApplied.result.status, 'applied')
  if (mode !== '--prepare') {
    const binding = await json(proofPath + '.current.json')
    assert.equal(hash(binding.frozen), binding.manifestHash)
    assert.equal(binding.frozen.kind, 'current-legacy-candle-build-binding/v1')
    assert.equal(binding.frozen.proofFileSha256, sha256(await readFile(proofPath)))
    assert.deepEqual(binding.frozen.tools.map(tool => tool.path), bindingPaths)
    await verifyTools(binding.frozen.tools)
  }
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.port, 13316); assert.equal(credentials.user, 'root')
  const connect = database => mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  connection = await connect(target)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION lock_wait_timeout=5')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@version version,CONNECTION_ID() id')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const noOtherClients = async () => {
    const [[row]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=? AND ID<>?', [target, identity.id])
    assert.equal(Number(row.n), 0, 'current_legacy_candle_build_other_clients')
  }
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    await noOtherClients()
    const plan = await loadLegacyCandleBuildMigration(root)
    if (mode === '--prepare') {
      phase = 'prepare-current-root'
      const priorStore = await mysqlAccountProjectionMigrationStore(connection, plan.prior, root, priorPath, observerPath, terminalPath, rootPath)
      assert.ok((await coordinateAccountProjectionMigration(priorStore, plan.prior)).steps.every(step => step.status === 'completed'))
      const rootStore = priorStore.priorStore.priorStore.rootStore
      const before = await rootStore.snapshot(), historyBefore = await rootStore.history()
      const priorProof = await json(priorPath), priorAdditions = new Set(priorProof.definitions.map(item => item.table))
      assert.deepEqual(before.filter(table => !priorAdditions.has(table.name)), priorProof.priorSnapshot)
      assert.ok(before.filter(table => priorAdditions.has(table.name)).every(table => table.rows === 0))
      const parentDefinitions = []
      for (const parent of parents) {
        const [[column]] = await connection.execute('SELECT COLUMN_TYPE columnType,CHARACTER_SET_NAME charset,COLLATION_NAME collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [parent.table, 'id'])
        assert.deepEqual(column, { columnType: parent.columnType, charset: parent.charset, collation: parent.collation })
        parentDefinitions.push({ table: parent.table, id: column })
      }
      phase = 'canonical-reference'
      reference = 'dev_vue_candle_reference_' + randomBytes(12).toString('hex')
      referenceCreated = true
      await connection.query(`CREATE DATABASE \`${reference}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      referenceConnection = await connect(reference)
      for (const parent of parents) await referenceConnection.query(`CREATE TABLE \`${parent.table}\` (id ${parent.type} NOT NULL,PRIMARY KEY(id)) ENGINE=InnoDB`)
      const definitions = []
      for (const step of plan.additions) {
        await referenceConnection.query(step.sql)
        const [[row]] = await referenceConnection.query(`SHOW CREATE TABLE \`${step.table}\``)
        definitions.push({ table: step.table, sourceSqlHash: hash(step.sql), ddl: row['Create Table'], schemaHash: tableDefinitionHash(row['Create Table']) })
        const [[count]] = await referenceConnection.query(`SELECT COUNT(*) n FROM \`${step.table}\``); assert.equal(Number(count.n), 0)
      }
      phase = 'reference-constraints'
      const promotion = await verifyLegacyCandleReference(referenceConnection, reference)
      const constraintChecks = promotion.checks
      assert.equal(constraintChecks.length, 20); assert.ok(constraintChecks.every(check => check.passed))
      const expectedReferenceTables = ['trading_accounts', 'market_data_sources', 'market_candles_legacy_v3', 'market_candles', 'legacy_candle_backfill_v4', 'legacy_candle_mappings_v4'].sort()
      const [referenceTables] = await referenceConnection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
      assert.deepEqual(referenceTables.map(row => row.name).sort(), expectedReferenceTables)
      for (const table of expectedReferenceTables) {
        const [[count]] = await referenceConnection.query(`SELECT COUNT(*) n FROM \`${table}\``); assert.equal(Number(count.n), 0)
      }
      referenceConnection.destroy(); referenceConnection = undefined
      await connection.query(`DROP DATABASE \`${reference}\``); referenceCreated = false
      const [remaining] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [reference]); assert.equal(remaining.length, 0)
      assert.deepEqual(await rootStore.snapshot(), before); assert.deepEqual(await rootStore.history(), historyBefore)
      await noOtherClients()
      const referenceBody = { kind: 'legacy-candle-build-reference/v1', identity: await rootStore.identity(), priorProofHash: priorProof.proofHash,
        registryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))), sourceSnapshotHash: hash(before), sourceHistoryHash: hash(historyBefore),
        reference, referenceRemoved: true, sourceWritten: false, mysqlVersion: identity.version, parentDefinitions, definitions, constraintChecks,
        promotionForeignKeys: promotion.foreignKeys, promotedDefinitions: promotion.promotedDefinitions,
        captureToolHash: sha256(await readFile(new URL('scripts/upgrade-current-legacy-candle-build-local.mjs', root))),
        constraintToolHash: sha256(await readFile(new URL('scripts/lib/legacy-candle-reference-checks.mjs', root))) }
      const currentReference = { ...referenceBody, proofHash: hash(referenceBody) }
      await persistLegacyCandleBuildProof(referencePath, currentReference)
      const proof = prepareLegacyCandleBuildProof(plan, await rootStore.identity(), priorProof, before, currentReference, await freezeLegacyCandleBuildTools(root))
      await persistLegacyCandleBuildProof(proofPath, proof)
      const frozen = { kind: 'current-legacy-candle-build-binding/v1', proofFileSha256: sha256(await readFile(proofPath)),
        reference: { database: reference, removed: true, mysqlVersion: identity.version, parentDefinitions }, sourceHistoryHash: hash(historyBefore),
        tools: await Promise.all(bindingPaths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) }))) }
      await persistLegacyCandleBuildProof(proofPath + '.current.json', { frozen, manifestHash: hash(frozen) })
    }
    phase = 'coordinate'
    const store = await mysqlLegacyCandleBuildMigrationStore(connection, plan, root, proofPath, priorPath, observerPath, terminalPath, rootPath)
    for (const name of ['begin', 'execute', 'complete']) {
      const original = store[name]
      store[name] = async step => { await noOtherClients(); return original(step) }
    }
    const result = await coordinateLegacyCandleBuildMigration(store, plan, { apply: mode === '--apply' })
    phase = 'verify-result'
    const proof = await json(proofPath), binding = await json(proofPath + '.current.json')
    const snapshot = await store.priorStore.priorStore.priorStore.rootStore.snapshot(), added = new Set(plan.additions.map(step => step.table))
    assert.deepEqual(snapshot.filter(table => !added.has(table.name)), proof.priorSnapshot)
    const priorIds = new Set(plan.prior.steps.map(step => step.id))
    assert.equal(hash((await store.history()).filter(row => priorIds.has(row.id))), binding.frozen.sourceHistoryHash)
    const addedTables = snapshot.filter(table => added.has(table.name)).map(({ name, rows, schemaSha256 }) => ({ name, rows, schemaSha256 }))
    assert.ok(addedTables.every(table => table.rows === 0)); await noOtherClients()
    return { kind: 'current-legacy-candle-build-result/v1', observedAt: new Date().toISOString(), target, mode, result,
      completedSteps: (await store.history()).filter(row => row.status === 'completed').length, targetSteps: plan.steps.length,
      proofHash: proof.proofHash, protectedTables: proof.priorSnapshot.length, addedTables, runtimeActivated: false,
      scope: 'Append-only empty candle build/ledger/mapping tables; exact prior rows and history reconciled. Client check is observational, not a database-wide write lock.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync(); console.log(JSON.stringify(receipt))
} catch (error) {
  const code = /^legacy_candle_build_(?:store_)?[a-z_]+$/.test(error.message ?? '') ? error.message
    : /^ER_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'current_legacy_candle_build_failed'
  const failure = { failed: true, phase, code, referenceMayRemain: referenceCreated, ...(referenceCreated ? { reference } : {}) }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (referenceConnection) referenceConnection.destroy(); if (connection) connection.destroy(); if (output) await output.close() }
