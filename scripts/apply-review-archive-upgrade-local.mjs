import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { loadReviewArchiveUpgrade } from './lib/review-archive-upgrade.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { inferenceRootSchemaState } from './lib/inference-root-schema-state.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const [mode, destination] = process.argv.slice(2), root = new URL('../', import.meta.url)
assert.ok(['--restored', '--current'].includes(mode) && isAbsolute(destination ?? '') && process.argv.length === 4)
const side = mode === '--restored' ? 'restored' : 'current', target = side === 'restored' ? 'dev_vue_m1_source_20260910_02' : 'dev_vue'
const load = async path => JSON.parse(await readFile(path, 'utf8'))
const plan = await loadReviewArchiveUpgrade(root), planHash = hash(plan.steps)
const dataProof = await load(new URL(`docs/architecture/review-history-archive-${side}-${side === 'restored' ? 'v2' : 'v1'}-20260911.json`, root))
assert.ok(dataProof.passed && dataProof.target === target && dataProof.oldDataAndLedgerUnchanged)
const backup = await load(new URL('docs/architecture/inference-restored-baseline-20260910.json', root))
const receipt = await readFile(join(backup.archiveDirectory, 'receipt.json'))
assert.equal(sha256(receipt), (await load(new URL('docs/architecture/strategy-receipt-current-v1-20260911.json', root))).backupReceiptSha256); assert.equal(JSON.parse(receipt).status, 'verified')
if (side === 'current') {
  const rehearsal = await load(new URL('docs/architecture/review-archive-restored-v1-20260911.json', root))
  assert.ok(rehearsal.passed && rehearsal.ddlAckLossRecovered && rehearsal.replayNoDDL)
  assert.equal(rehearsal.planHash, planHash)
}
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-archive-schema-upgrade/v1', passed: false, target, planHash, ddlAttempted: 0, businessRowWrites: 0 }
let db
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  db = await mysql.createConnection({ ...credentials, database: target, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  await db.query("SET SESSION time_zone='+00:00'")
  await withInplaceUpgradeLock(db, target, async () => {
    const guard = async () => {
      const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
      assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
      const [[clients]] = await db.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
      assert.equal(Number(clients.n), 0)
      const [triggers] = await db.query('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')
      assert.equal(triggers.length, 0)
    }
    await guard(); assert.ok(await verifyInplaceJournal(db))
    const journal = mysqlColumnStore(db, true)
    const snapshot = async () => {
      await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      try { return (await readAccountRootSnapshot(db)).tables.map(row => ({ ...row, ddl: row.ddl.replace(/ AUTO_INCREMENT=\d+/g, '') })) }
      finally { await db.rollback() }
    }
    const baselinePath = new URL(`docs/architecture/review-archive-${side}-baseline-20260911.json`, root)
    let baseline
    try { baseline = await load(baselinePath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!baseline) {
      const tables = await snapshot(), history = await journal.history()
      assert.equal(hash(tables), dataProof.afterHash, 'receipt_original_data_changed')
      assert.equal(history.length, 256)
      baseline = { target, planHash, tables, history }
      const file = await open(baselinePath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(baseline, null, 2) + '\n') } finally { await file.close() }
    }
    assert.equal(baseline.target, target); assert.equal(baseline.planHash, planHash)
    const schema = async () => {
      const [names] = await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'")
      const tables = []
      for (const { name } of names) { assert.match(name, /^[a-z][a-z0-9_]*$/); const [[row]] = await db.query(`SHOW CREATE TABLE \`${name}\``); tables.push({ name, ddl: row['Create Table'] }) }
      return inferenceRootSchemaState(tables).sha256
    }
    let inject = side === 'restored'
    const store = { ...journal, async tableHash(key) { assert.equal(key, 'execution_workflow_schema'); await guard(); return schema() },
      async execute(sql) { await guard(); assert.ok(plan.added.some(step => step.sql === sql)); report.ddlAttempted++; await journal.execute(sql)
        if (inject) { inject = false; throw Error('injected_ddl_ack_loss') } } }
    try { await coordinateInplaceSchema(store, plan, { apply: true }) }
    catch (error) {
      if (error.message !== 'injected_ddl_ack_loss') throw error
      assert.equal((await journal.history()).find(row => row.id === plan.added[0].id)?.status, 'started')
      assert.equal(await schema(), plan.added[0].afterHash)
      await coordinateInplaceSchema(store, plan, { apply: true }); report.ddlAckLossRecovered = true
    }
    const attempts = report.ddlAttempted
    await coordinateInplaceSchema(store, plan, { apply: true }); assert.equal(report.ddlAttempted, attempts)
    const after = await snapshot()
    for (const row of baseline.tables) if (row.name !== 'database_upgrade_steps_v4') {
      const actual = after.find(item => item.name === row.name)
      assert.ok(actual); assert.equal(actual.rows, row.rows); assert.equal(actual.rowsSha256, row.rowsSha256)
      if (!Object.hasOwn(plan.definitions, row.name)) assert.equal(actual.ddl, row.ddl)
    }
    const history = await journal.history()
    assert.equal(history.length, 259); assert.ok(history.every(row => row.status === 'completed'))
    assert.deepEqual(history.filter(row => !plan.added.some(step => step.id === row.id)), baseline.history)
    assert.equal(await schema(), plan.finalSchemaHash)
    Object.assign(report, { passed: true, replayNoDDL: true, oldDataUnchanged: true, oldChecksumsUnchanged: true,
      steps: history.length, tableCount: after.length, afterSnapshotHash: hash(after), backupReceiptSha256: sha256(receipt) })
  })
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'receipt_upgrade_failed'
  report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (db) await db.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
