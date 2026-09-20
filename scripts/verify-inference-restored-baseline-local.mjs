import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadInferenceBuildUpgrade } from './lib/inference-build-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnHistory } from './lib/dev-vue-column-upgrade.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { verifyRiskRestoredSnapshot } from './lib/risk-backup-parity.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--prepare' && isAbsolute(destination ?? '') && process.argv.length === 4)
const root = new URL('../', import.meta.url)
const archiveDirectory = 'D:\\dev_codex\\.backup-core-20260910-02'
const target = 'dev_vue_m1_source_20260910_02'
const uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'inference-restored-baseline/v1', passed: false, source: 'dev_vue', target,
  serverUuid: uuid, archiveDirectory, currentDevVueWrites: 0, restoredDatabaseWrites: 0 }
let connection
try {
  const receiptBytes = await readFile(join(archiveDirectory, 'receipt.json'))
  const receipt = JSON.parse(receiptBytes)
  assert.ok(receipt.status === 'verified' && receipt.source === 'dev_vue' && receipt.target === target
    && receipt.serverUuid === uuid && receipt.sourceUnchanged && receipt.currentDevVueWrites === 0)
  const source = JSON.parse(await readFile(join(archiveDirectory, 'source-snapshot.json')))
  const restored = JSON.parse(await readFile(join(archiveDirectory, 'restored-snapshot.json')))
  assert.equal(hash(source), receipt.tablesSha256)
  assert.deepEqual(verifyRiskRestoredSnapshot(source, restored), receipt.metadataParity)
  const plan = await loadInferenceBuildUpgrade(root)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  const observations = []
  for (const database of ['dev_vue', target]) {
    connection = await mysql.createConnection({ ...credentials, database, timezone: 'Z', dateStrings: true,
      jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
    assert.equal(identity.db, database); assert.equal(identity.uuid, uuid); assert.equal(Number(identity.recovery), 0)
    assert.ok(await verifyInplaceJournal(connection))
    const history = await mysqlColumnStore(connection, true).history()
    const entries = validateColumnHistory(history, plan.prior.steps)
    assert.equal(history.length, 191)
    assert.ok(plan.prior.steps.every(step => entries.get(step.id)?.status === 'completed'))
    const current = (await readAccountRootSnapshot(connection)).tables
    const expected = database === 'dev_vue' ? source : restored
    assert.equal(current.length, 258)
    assert.deepEqual(current.map(t => t.name), expected.map(t => t.name))
    for (const [index, table] of current.entries()) {
      assert.equal(table.rows, expected[index].rows)
      assert.equal(table.rowsSha256, expected[index].rowsSha256)
      assert.equal(tableDefinitionHash(table.ddl), tableDefinitionHash(expected[index].ddl))
    }
    for (const name of Object.keys(plan.finalTableHashes)) assert.ok(!current.some(t => t.name === name))
    for (const required of plan.parentRequirements) {
      const [columns] = await connection.execute('SELECT COLUMN_TYPE type,COLLATION_NAME collation,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [required.table, required.column])
      assert.equal(columns.length, 1)
      assert.deepEqual(columns[0], { type: required.type, collation: required.collation, nullable: required.nullable })
    }
    observations.push({ database, history, tableCount: current.length,
      rows: current.reduce((sum, table) => sum + BigInt(table.rows), 0n).toString(), snapshotHash: hash(current) })
    await connection.rollback(); await connection.end(); connection = undefined
  }
  assert.deepEqual(observations[0].history, observations[1].history)
  Object.assign(report, { passed: true, receiptSha256: sha256(receiptBytes), sourceSnapshotHash: hash(source),
    restoredSnapshotHash: hash(restored), observations, completedSteps: 191, startedSteps: 0,
    parentColumnsVerified: plan.parentRequirements.length, buildTablesAbsent: Object.keys(plan.finalTableHashes).length,
    candidateSteps: plan.steps.length, planHash: hash({ steps: plan.steps, transitions: plan.transitions }),
    referenceHash: plan.referenceHash, inventoryHash: plan.inventoryHash,
    metadataParity: receipt.metadataParity, dataParity: true })
} catch (error) {
  report.error = { code: error.code ?? 'inference_restored_baseline_failed', kind: error.name,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) }
  process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close()
  console.log(JSON.stringify({ passed: report.passed, target, completedSteps: report.completedSteps,
    candidateSteps: report.candidateSteps, parentColumnsVerified: report.parentColumnsVerified, error: report.error }))
}
