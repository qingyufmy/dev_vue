import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { loadBridgeInstallationUpgrade } from './lib/bridge-installation-upgrade.mjs'
import { loadCorrectedBridgeInstallationUpgrade } from './lib/bridge-installation-corrected-upgrade.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { inferenceRootSchemaState } from './lib/inference-root-schema-state.mjs'
import { readOriginalRows } from './lib/inplace-column-evidence.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const [archive, destination] = process.argv.slice(2), root = new URL('../', import.meta.url)
assert.ok(isAbsolute(archive ?? '') && isAbsolute(destination ?? '') && process.argv.length === 4)
const load = async path => JSON.parse(await readFile(path, 'utf8'))
const target = 'dev_vue', uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
const plan = await loadBridgeInstallationUpgrade(root), planHash = hash(plan.steps)
const corrected = await loadCorrectedBridgeInstallationUpgrade(root), correction = corrected.correction
const receiptBytes = await readFile(join(archive, 'receipt.json')), receipt = JSON.parse(receiptBytes)
assert.equal(receipt.kind, 'bridge-installation-dev-vue-local-backup/v1')
assert.equal(resolve(receipt.directory), resolve(archive))
assert.match(receipt.target, /^dev_vue_m1_source_20260914_\d{2}$/)
assert.equal(receipt.status, 'verified'); assert.equal(receipt.source, target); assert.equal(receipt.serverUuid, uuid)
assert.ok(receipt.sourceUnchanged && receipt.sqlScopeReviewed && receipt.decryptionIntegrityVerified
  && receipt.metadataParity.rowParity && receipt.metadataParity.columnMetadataParity && receipt.metadataParity.semanticDdlParity)
const encryptedHash = createHash('sha256')
let encryptedBytes = 0
for await (const chunk of createReadStream(join(archive, 'source.sql.enc'))) { encryptedHash.update(chunk); encryptedBytes += chunk.length }
assert.equal(encryptedHash.digest('hex'), receipt.artifact.ciphertext.sha256)
assert.equal(encryptedBytes, receipt.artifact.ciphertext.bytes)
const preparation = await load(join(archive, 'preparation.json'))
const { manifestHash, ...prepared } = preparation
assert.equal(hash(prepared), manifestHash); assert.equal(manifestHash, receipt.preparationManifestHash)
assert.equal(preparation.tools.planHash, planHash)
for (const tool of preparation.tools.files) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
const original = await load(join(archive, 'source-snapshot.json'))
assert.equal(hash(original), receipt.tablesSha256); assert.equal(original.length, 315)
assert.equal(inferenceRootSchemaState(original).sha256, plan.prior.finalSchemaHash)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'bridge-installation-corrected-schema-upgrade/v1', passed: false, target, serverUuid: uuid,
  planHash, correctedPlanHash: hash(corrected.steps), correctionChecksum: correction.checksum, correctionDdlAttempted: 0, backupReceiptSha256: sha256(receiptBytes), backupDirectory: archive, ddlAttempted: 0, businessRowWrites: 0 }
let db, stage = 'connect'
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  db = await mysql.createConnection({ ...credentials, database: target, timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 5000 })
  await db.query("SET SESSION time_zone='+00:00'")
  await db.query('SET SESSION lock_wait_timeout=10')
  await withInplaceUpgradeLock(db, target, async () => {
    const guard = async () => {
      const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery,CONNECTION_ID() id')
      assert.equal(identity.db, target); assert.equal(identity.uuid, uuid); assert.equal(Number(identity.recovery), 0)
      const [[lock]] = await db.execute('SELECT IS_USED_LOCK(?) owner', ['aurum:inplace:dev_vue'])
      assert.equal(String(lock.owner), String(identity.id))
      const [[clients]] = await db.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
      assert.equal(Number(clients.n), 0, 'other_database_clients')
      const [triggers] = await db.query('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')
      assert.equal(triggers.length, 0)
    }
    const schema = async () => {
      const [names] = await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'")
      const tables = []
      for (const { name } of names) {
        assert.match(name, /^[a-z][a-z0-9_]*$/)
        const [[row]] = await db.query(`SHOW CREATE TABLE \`${name}\``)
        tables.push({ name, ddl: row['Create Table'] })
      }
      return { tables, sha256: inferenceRootSchemaState(tables).sha256 }
    }
    // Hash exactly the pre-upgrade columns, including refresh sessions whose two
    // new nullable columns would otherwise change the row serialization hash.
    const verifyOriginalData = async () => {
      const expected = original.filter(row => row.name !== 'database_upgrade_steps_v4')
      await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      try {
        const rows = await readOriginalRows(db, expected.map(row => ({ name: row.name,
          columns: row.columns.map(column => column.name), primary: row.columns.filter(column => column.columnKey === 'PRI').map(column => column.name) })))
        assert.deepEqual(rows, expected.map(row => ({ name: row.name, rows: row.rows, sha256: row.rowsSha256 })))
      } finally { await db.rollback() }
    }
    stage = 'verify-backup-current-parity'
    await guard(); assert.ok(await verifyInplaceJournal(db)); await verifyOriginalData()
    const journal = mysqlColumnStore(db, true)
    const baselinePath = join(archive, 'bridge-installation-upgrade-baseline.json')
    let baseline
    try { baseline = await load(baselinePath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!baseline) {
      assert.equal((await schema()).sha256, plan.prior.finalSchemaHash)
      const history = await journal.history()
      assert.equal(history.length, 267); assert.ok(history.every(row => row.status === 'completed'))
      const [journalRows] = await readOriginalRows(db, original.filter(row => row.name === 'database_upgrade_steps_v4').map(row => ({ name: row.name,
        columns: row.columns.map(column => column.name), primary: ['id'] })))
      assert.equal(journalRows.sha256, original.find(row => row.name === 'database_upgrade_steps_v4').rowsSha256)
      baseline = { target, planHash, correctedPlanHash: hash(corrected.steps), correctionChecksum: correction.checksum, correctionDdlAttempted: 0, backupReceiptSha256: report.backupReceiptSha256, history }
      const file = await open(baselinePath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(baseline, null, 2) + '\n') } finally { await file.close() }
    }
    assert.equal(baseline.target, target); assert.equal(baseline.planHash, planHash)
    assert.equal(baseline.backupReceiptSha256, report.backupReceiptSha256)
    stage = 'recover-080-default-collation'
    const correctionHistory = await journal.history()
    assert.deepEqual(correctionHistory.filter(row => row.id !== correction.id && !plan.added.some(step => step.id === row.id)), baseline.history)
    let correctionRow = correctionHistory.find(row => row.id === correction.id)
    if (correctionRow) {
      assert.equal(correctionRow.checksum, correction.checksum)
      assert.ok(['started', 'completed'].includes(correctionRow.status))
    }
    const current = await schema()
    const limits = current.tables.find(row => row.name === 'bridge_installation_request_limits')
    assert.ok(limits)
    const tableHash = tableDefinitionHash(limits.ddl)
    if (correctionRow?.status !== 'completed') {
      assert.equal(correctionHistory.length, correctionRow ? 269 : 268)
      const first = correctionHistory.find(row => row.id === plan.added[0].id)
      assert.equal(first?.checksum, plan.added[0].checksum); assert.equal(first?.status, 'started')
      assert.equal(current.tables.length, 316)
      const [[empty]] = await db.query('SELECT COUNT(*) n FROM bridge_installation_request_limits')
      assert.equal(Number(empty.n), 0)
      assert.ok(tableHash === correction.actualBeforeTableHash || (correctionRow && tableHash === correction.expectedAfterTableHash))
      const normalized = current.tables.map(row => row.name === limits.name ? { ...row, ddl: plan.definitions.bridge_installation_request_limits } : row)
      assert.equal(inferenceRootSchemaState(normalized).sha256, plan.added[0].afterHash)
      await guard()
      if (!correctionRow) { await journal.begin(correction); correctionRow = { status: 'started' } }
      if (tableHash === correction.actualBeforeTableHash) {
        report.correctionDdlAttempted++
        await journal.execute(correction.sql)
      }
      const correctedSchema = await schema()
      assert.equal(correctedSchema.sha256, plan.added[0].afterHash)
      await guard(); await journal.complete(correction)
    } else assert.equal(tableHash, correction.expectedAfterTableHash)
    // Only this exact, checksum-verified completed correction is hidden from
    // the frozen 271-step coordinator. No unknown journal rows are ignored.
    const store = { ...journal,
      async history() {
        const rows = await journal.history(), receiptRow = rows.find(row => row.id === correction.id)
        assert.equal(receiptRow?.checksum, correction.checksum); assert.equal(receiptRow?.status, 'completed')
        return rows.filter(row => row.id !== correction.id)
      },
      async tableHash(key) { assert.equal(key, 'execution_workflow_schema'); await guard(); return (await schema()).sha256 },
      async begin(step) { await guard(); assert.ok(plan.added.some(row => row.id === step.id && row.checksum === step.checksum)); await journal.begin(step) },
      async execute(sql) { await guard(); assert.ok(plan.added.some(step => step.sql === sql)); report.ddlAttempted++; await journal.execute(sql) },
      async complete(step) { await guard(); await journal.complete(step) } }
    stage = 'apply-080'
    await coordinateInplaceSchema(store, plan, { apply: true })
    const attempts = report.ddlAttempted
    await coordinateInplaceSchema(store, plan, { apply: true }); assert.equal(report.ddlAttempted, attempts)
    stage = 'verify-original-data-and-schema'
    await guard(); await verifyOriginalData()
    const history = await journal.history(), after = await schema()
    assert.equal(history.length, 272); assert.ok(history.every(row => row.status === 'completed'))
    assert.deepEqual(history.filter(row => row.id !== correction.id && !plan.added.some(step => step.id === row.id)), baseline.history)
    assert.equal(after.sha256, plan.finalSchemaHash); assert.equal(after.tables.length, 318)
    const [[extensions]] = await db.query('SELECT COUNT(*) n FROM bridge_refresh_sessions WHERE installation_authorization_id IS NOT NULL OR installation_request_key IS NOT NULL')
    assert.equal(Number(extensions.n), 0)
    for (const name of ['bridge_installation_request_limits', 'bridge_installation_authorizations', 'bridge_installation_requests']) {
      const [[row]] = await db.query(`SELECT COUNT(*) n FROM \`${name}\``); assert.equal(Number(row.n), 0)
    }
    Object.assign(report, { passed: true, replayNoDDL: true, oldDataUnchanged: true, oldChecksumsUnchanged: true,
      steps: history.length, originalPlanChecksumsPreserved: true, correctionCompleted: true, tableCount: after.tables.length, finalSchemaHash: after.sha256, originalBusinessTablesCompared: 314,
      newTablesEmpty: true, oldSessionExtensionsNull: true })
  })
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'bridge_installation_upgrade_failed'
  report.failureStage = stage
  report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (db) await db.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
