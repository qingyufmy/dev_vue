import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadEntryEventUpgrade } from './lib/entry-event-upgrade.mjs'
import { loadBridgeInstallationSource } from './lib/bridge-installation-upgrade-source.mjs'
import { composeBridgeInstallationUpgrade } from './lib/bridge-installation-upgrade.mjs'
import { createSchemaTransitionReference } from './lib/schema-transition-reference.mjs'
import { inferenceRootSchemaState } from './lib/inference-root-schema-state.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore } from './lib/mysql-inplace-column-store.mjs'
import { loadMigrationPlan } from './lib/v4-migration-plan.mjs'
import { loadMigrationCorrections } from './lib/v4-migration-corrections.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { runBridgeInstallationReferenceCases } from './lib/bridge-installation-reference-cases.mjs'
import { MysqlBridgeInstallationRepository } from '../bridge/.test-artifacts/installation-reference/modules/bridge/infrastructure/mysql-bridge-installation-repository.js'

const [destination] = process.argv.slice(2), root = new URL('../', import.meta.url)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'bridge-installation-reference/v1', passed: false, existingDatabaseWrites: 0,
  referenceDatabaseRemoved: false, fullBusinessChainVerified: false, syntheticParentRows: true, sourceBusinessDataCompared: false }
const owned = new Map(), ownedPattern = /^dev_vue_workflow_schema_ref_[a-f0-9]{32}$/
let admin, sourceDb, pool, locked = false, stage = 'configuration'
const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return '`' + name + '`' }
const schema = async db => {
  const [names] = await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")
  const result = []
  for (const { name } of names) { const [[row]] = await db.query('SHOW CREATE TABLE ' + quote(name)); result.push({ name, ddl: row['Create Table'] }) }
  return result
}
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  const options = { ...credential, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }
  const prior = await loadEntryEventUpgrade(root), migration = await loadBridgeInstallationSource(root)
  admin = await mysql.createConnection(options)
  const [[host]] = await admin.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery,VERSION() version')
  assert.equal(host.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(host.recovery), 0)
  report.serverUuid = host.uuid; report.mysqlVersion = host.version
  sourceDb = await mysql.createConnection({ ...options, database: 'dev_vue' })
  await sourceDb.query("SET SESSION time_zone='+00:00'")
  await sourceDb.query('SET SESSION TRANSACTION READ ONLY')
  const [[readOnly]] = await sourceDb.query('SELECT @@session.transaction_read_only readonlyMode')
  assert.equal(Number(readOnly.readonlyMode), 1); report.sourceReadOnlySession = true
  const [[lock]] = await sourceDb.execute('SELECT GET_LOCK(?,0) acquired', ['aurum:inplace:dev_vue'])
  assert.equal(Number(lock.acquired), 1); locked = true
  stage = 'source_admission'
  const baseline = await schema(sourceDb), sourceState = inferenceRootSchemaState(baseline)
  assert.equal(sourceState.sha256, prior.finalSchemaHash, 'unexpected_source_schema')
  const [history] = await sourceDb.query('SELECT id,checksum_sha256 checksum,status,started_at_utc,completed_at_utc FROM database_upgrade_steps_v4 ORDER BY id')
  assert.equal(history.length, 267)
  for (const row of history) { assert.equal(row.status, 'completed'); assert.equal(row.checksum, prior.steps.find(step => step.id === row.id)?.checksum) }
  report.sourceSchemaHash = sourceState.sha256; report.sourceJournalHash = hash(history)
  const createOwned = async (tables = [], withJournal = false) => {
    const name = 'dev_vue_workflow_schema_ref_' + randomUUID().replaceAll('-', '')
    assert.match(name, ownedPattern)
    const [existing] = await admin.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [name])
    assert.equal(existing.length, 0)
    owned.set(name, null)
    await admin.query('CREATE DATABASE ' + quote(name) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    const db = await mysql.createConnection({ ...options, database: name })
    owned.set(name, db)
    await db.query("SET SESSION time_zone='+00:00'")
    const [[identity]] = await db.query('SELECT DATABASE() db')
    assert.equal(identity.db, name)
    await db.query('SET SESSION foreign_key_checks=0')
    for (const table of tables) { assert.ok(table.ddl.startsWith('CREATE TABLE ' + quote(table.name) + ' (')); await db.query(table.ddl) }
    await db.query('SET SESSION foreign_key_checks=1')
    if (withJournal) for (const row of history) await db.execute('INSERT INTO database_upgrade_steps_v4 (id,checksum_sha256,status,started_at_utc,completed_at_utc) VALUES (?,?,?,?,?)',
      [row.id, row.checksum, row.status, row.started_at_utc, row.completed_at_utc])
    return { name, db }
  }
  stage = 'transition_proof'
  const reference = await createOwned(baseline)
  const recorder = await createSchemaTransitionReference(reference.db)
  for (const sql of migration.statements) await recorder.connection.query(sql)
  const target = await schema(reference.db)
  const changedNames = ['bridge_installation_request_limits', 'bridge_installation_authorizations', 'bridge_installation_requests', 'bridge_refresh_sessions']
  const proof = { sourceSteps: 267, tableCount: target.length, initialSchemaState: recorder.initial, sources: migration.sources,
    transitions: recorder.transitions, definitions: Object.fromEntries(target.filter(row => changedNames.includes(row.name)).map(row => [row.name, row.ddl])) }
  report.schemaProof = proof
  const upgrade = composeBridgeInstallationUpgrade(prior, migration, proof)
  report.planHash = hash(upgrade.steps)
  stage = 'ddl_recovery'
  const rehearsal = await createOwned(baseline, true)
  const referenceLock = 'aurum:biref:' + rehearsal.name.slice(-32)
  const [[refLock]] = await rehearsal.db.execute('SELECT GET_LOCK(?,0) acquired', [referenceLock])
  assert.equal(Number(refLock.acquired), 1)
  let ddl = 0
  const lost = new Set()
  const store = { ...mysqlColumnStore(rehearsal.db, true),
    tableHash: async () => inferenceRootSchemaState(await schema(rehearsal.db)).sha256,
    async execute(sql) {
      assert.ok(migration.statements.includes(sql)); ddl++
      await rehearsal.db.query(sql)
      if (!lost.has(sql)) { lost.add(sql); throw Error('injected_ddl_ack_loss') }
    } }
  for (let i = 0; i < 4; i++) await assert.rejects(coordinateInplaceSchema(store, upgrade, { apply: true }), /injected_ddl_ack_loss/)
  assert.ok((await coordinateInplaceSchema(store, upgrade, { apply: true })).structureComplete)
  assert.equal(ddl, 4); report.ddlAckLossCases = lost.size; report.ddlAckLossRecovered = lost.size === 4
  await coordinateInplaceSchema(store, upgrade, { apply: true }); assert.equal(ddl, 4); report.replayNoDDL = true
  const migratedHistory = await store.history()
  assert.equal(migratedHistory.length, 271); assert.ok(migratedHistory.every(row => row.status === 'completed'))
  assert.deepEqual(migratedHistory.slice().filter(row => !upgrade.added.some(step => step.id === row.id)).map(({ id, checksum, status }) => ({ id, checksum, status })), history.map(({ id, checksum, status }) => ({ id, checksum, status })))
  report.oldChecksumsUnchanged = true
  const competitor = await mysql.createConnection({ ...options, database: rehearsal.name })
  try {
    const [[claim]] = await competitor.execute('SELECT GET_LOCK(?,0) acquired', [referenceLock])
    assert.equal(Number(claim.acquired), 0); report.concurrentDdlSingleOwner = true
  } finally { await competitor.end() }
  await rehearsal.db.execute('SELECT RELEASE_LOCK(?)', [referenceLock])
  stage = 'empty_bootstrap'
  const bootstrap = await createOwned()
  const bootstrapPlan = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  const corrections = await loadMigrationCorrections({ rootDirectory: fileURLToPath(root) }, bootstrapPlan)
  report.bootstrapCorrections = corrections.map(({ id, checksum, originalChecksum, originalStatementChecksum, sqlChecksum }) => ({ id, checksum, originalChecksum, originalStatementChecksum, sqlChecksum }))
  report.bootstrapMigrationSources = bootstrapPlan.map(({ id, checksum }) => ({ id, checksum }))
  for (const entry of bootstrapPlan) {
    for (const [index, sql] of entry.statements.entries()) {
      const correction = corrections.find(row => row.migrationId === entry.id && row.statementNumber === index + 1)
      await bootstrap.db.query(correction?.sql ?? sql)
    }
  }
  const bootstrapTables = await schema(bootstrap.db)
  for (const name of changedNames.slice(0, 3)) assert.equal(tableDefinitionHash(bootstrapTables.find(row => row.name === name).ddl), upgrade.finalTableHashes[name])
  const extension = async db => {
    const [columns] = await db.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='bridge_refresh_sessions' AND COLUMN_NAME IN ('installation_authorization_id','installation_request_key') ORDER BY ORDINAL_POSITION")
    const [index] = await db.query("SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='bridge_refresh_sessions' AND INDEX_NAME='uk_bridge_installation_profile_request' ORDER BY SEQ_IN_INDEX")
    const [fk] = await db.query("SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='bridge_refresh_sessions' AND CONSTRAINT_NAME='fk_bridge_profile_installation'")
    assert.equal(columns.length, 2); assert.equal(index.length, 2); assert.equal(fk.length, 1)
    return { columns, index, fk }
  }
  assert.deepEqual(await extension(bootstrap.db), await extension(reference.db)); report.bootstrapExtensionMatches = true
  stage = 'repository_concurrency'
  pool = mysql.createPool({ ...options, database: rehearsal.name, connectionLimit: 6 })
  report.repositoryCases = await runBridgeInstallationReferenceCases(pool, MysqlBridgeInstallationRepository)
  report.concurrentSingleWinner = report.repositoryCases.passed === true && report.repositoryCases.doubleApprovalSingleWinner === true
    && report.repositoryCases.crossUserInstallationSingleWinner === true
  assert.equal(report.concurrentSingleWinner, true)
  stage = 'source_recheck'
  assert.equal(inferenceRootSchemaState(await schema(sourceDb)).sha256, sourceState.sha256); report.sourceSchemaUnchanged = true
  const [afterHistory] = await sourceDb.query('SELECT id,checksum_sha256 checksum,status,started_at_utc,completed_at_utc FROM database_upgrade_steps_v4 ORDER BY id')
  assert.deepEqual(afterHistory, history); report.sourceJournalUnchanged = true
  report.passed = true
} catch (error) {
  report.error = { stage, code: error.code ?? error.name, message: String(error.message).slice(0, 300) }; process.exitCode = 1
} finally {
  const cleanupFailure = (action, error) => {
    report.passed = false; process.exitCode = 1
    ;(report.cleanupErrors ??= []).push({ action, code: error.code ?? error.name })
  }
  if (pool) try { await pool.end() } catch (error) { cleanupFailure('close_reference_pool', error) }
  for (const [name, db] of owned) {
    if (db) try { await db.end() } catch (error) { cleanupFailure('close_' + name, error) }
    try {
      assert.match(name, ownedPattern)
      const [exists] = await admin.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [name])
      if (exists.length) await admin.query('DROP DATABASE ' + quote(name))
    } catch (error) { cleanupFailure('drop_' + name, error) }
  }
  if (admin) try {
    const [remaining] = await admin.query('SELECT SCHEMA_NAME name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (' + (owned.size ? [...owned].map(() => '?').join(',') : "''") + ')', [...owned.keys()])
    report.referenceDatabaseRemoved = remaining.length === 0
  } catch (error) { cleanupFailure('verify_reference_cleanup', error) }
  if (sourceDb) {
    if (locked) try { await sourceDb.execute('SELECT RELEASE_LOCK(?)', ['aurum:inplace:dev_vue']) } catch (error) { cleanupFailure('release_source_lock', error) }
    try { await sourceDb.end() } catch (error) { cleanupFailure('close_readonly_source', error) }
  }
  if (admin) try { await admin.end() } catch (error) { cleanupFailure('close_admin', error) }
  report.referenceDatabaseCount = owned.size
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, error: report.error, referenceDatabaseRemoved: report.referenceDatabaseRemoved,
    ddlAckLossCases: report.ddlAckLossCases, concurrentSingleWinner: report.concurrentSingleWinner, destination }))
}
