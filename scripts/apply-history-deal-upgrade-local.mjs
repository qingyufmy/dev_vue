import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { verifyHistoryDealRehearsal } from './lib/history-deal-rehearsal-gate.mjs'
import { assertMysqlTradeHistoryCollectorSchemaReady } from '../server/dist-v4/modules/trade-history/infrastructure/mysql-schema-readiness.js'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadHistoryDealProvenanceUpgrade } from './lib/history-deal-provenance-upgrade.mjs'
import { coordinateHistoryRuntimeUpgrade, inspectHistoryRuntimeUpgrade } from './lib/history-runtime-coordinator.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnHistory } from './lib/dev-vue-column-upgrade.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { assertHistoryRuntimeParents, readHistoryRuntimeTable } from './lib/mysql-history-runtime-store.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--prepare', '--apply', '--replay'].includes(mode)
  && isAbsolute(destination ?? '') && process.argv.length === 4)
const root = new URL('../', import.meta.url), json = async path => JSON.parse(await readFile(path, 'utf8'))
const restored = await json(new URL('docs/architecture/core-refactor-restored-baseline-20260910.json', root))
assert.equal(restored.target, 'dev_vue_m1_source_20260910_01')
assert.equal(restored.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
const receiptBytes = await readFile(join(restored.archiveDirectory, 'receipt.json'))
assert.equal(sha256(receiptBytes), restored.receiptSha256)
assert.equal(JSON.parse(receiptBytes).status, 'verified')
const baselinePath = join(restored.archiveDirectory, 'history-deal-current-baseline-v1.json')
const loaded = await loadHistoryDealProvenanceUpgrade(root), step = loaded.added[0]
const plan = { steps: loaded.steps, added: loaded.added, prior: { steps: loaded.prior.steps },
  finalTableHashes: { [step.table]: step.afterHash }, referenceHash: loaded.referenceHash }
const rehearsalBaseline = await json(join(restored.archiveDirectory, 'history-deal-upgrade-baseline-v1.json'))
const rehearsals = await Promise.all(['prepare-v2', 'start-loss', 'ddl-loss', 'complete-loss', 'replay'].map(name =>
  json(new URL(`docs/architecture/history-deal-restored-${name}-20260910.json`, root))))
const rehearsal = verifyHistoryDealRehearsal(plan, rehearsalBaseline, rehearsals)
for (const item of rehearsalBaseline.tools) assert.equal(sha256(await readFile(new URL(item.path, root))), item.sha256)
const target = 'dev_vue'
assert.equal(restored.source, target)
assert.ok(restored.dataParity && restored.columnMetadataParity && restored.semanticDdlParity)
assert.equal(rehearsalBaseline.restoredReceiptSha256, restored.receiptSha256)
const backupSnapshot = await json(join(restored.archiveDirectory, 'source-snapshot.json'))
assert.equal(hash(backupSnapshot), restored.sourceSnapshotHash)
// Backup also carries column metadata; compare the common complete row/DDL projection.
const normalizeSnapshot = tables => tables.map(({ name, rows, rowsSha256, ddl }) => ({ name, rows, rowsSha256, ddl }))
const originalProtected = rows => rows.filter(t => !['database_upgrade_steps_v4', 'terminal_history_collection_receipts_v4'].includes(t.name))
const backupDataHash = hash(originalProtected(normalizeSnapshot(backupSnapshot)))
const priorReplay = await json(new URL('docs/architecture/history-collection-current-replay-20260910.json', root))
assert.ok(priorReplay.passed && priorReplay.target === target && priorReplay.serverUuid === restored.serverUuid && priorReplay.ddlAttempted === 0)
assert.equal(priorReplay.afterState, 'completed'); assert.equal(priorReplay.history.length, 189)
assert.equal(priorReplay.protectedSnapshotHash, backupDataHash)
const priorStep = loaded.prior.added[0]
assert.equal(priorReplay.planHash, hash({ steps: loaded.prior.steps, added: loaded.prior.added, prior: { steps: loaded.prior.prior.steps },
  finalTableHashes: { [priorStep.table]: priorStep.afterHash }, referenceHash: loaded.prior.referenceHash }))
for (const item of priorReplay.tools) assert.equal(sha256(await readFile(new URL(item.path, root))), item.sha256)
const toolPaths = ['scripts/apply-history-deal-upgrade-local.mjs', 'scripts/run-history-deal-current-local.py',
  'scripts/lib/history-deal-rehearsal-gate.mjs',
  'server/dist-v4/modules/trade-history/infrastructure/mysql-schema-readiness.js',
  'server/dist-v4/modules/trade-history/infrastructure/history-deal-schema.js',
  'server/dist-v4/modules/trade-history/infrastructure/history-collection-schema.js',
  'server/dist-v4/modules/trade-history/infrastructure/history-runtime-schema.js',
  'scripts/lib/history-collection-receipt-upgrade.mjs', 'scripts/lib/history-deal-provenance-upgrade.mjs', 'scripts/lib/history-runtime-coordinator.mjs', 'scripts/lib/mysql-inplace-column-store.mjs',
  'scripts/lib/dev-vue-column-upgrade.mjs', 'scripts/lib/mysql-account-root-snapshot.mjs', 'scripts/lib/mysql-history-runtime-store.mjs',
  'scripts/lib/inplace-foundation-upgrade.mjs', step.source]
const tools = await Promise.all(toolPaths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
const binding = { priorReplayHash: hash(priorReplay), rehearsalEvidenceHash: rehearsal.evidenceHash, planHash: hash(plan), tools, restoredReceiptSha256: restored.receiptSha256 }
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'history-deal-current-upgrade/v1', passed: false, mode, target,
  serverUuid: restored.serverUuid, businessWritesPerformed: false, ddlAttempted: 0, ddlAcknowledged: 0, ...binding }
let connection
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  connection = await mysql.createConnection({ ...credential, database: target, timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  await withInplaceUpgradeLock(connection, target, async () => {
    const guard = async () => {
      const [[r]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone timezone,@@innodb_force_recovery recovery')
      assert.equal(r.db, target); assert.equal(r.uuid, restored.serverUuid); assert.equal(r.timezone, '+00:00'); assert.equal(Number(r.recovery), 0)
      const [[lock]] = await connection.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId', [`aurum:inplace:${target}`])
      assert.equal(String(lock.owner), String(lock.currentId))
    }
    const snapshot = async () => {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      try { return (await readAccountRootSnapshot(connection)).tables } finally { await connection.rollback() }
    }
    await guard(); assert.ok(await verifyInplaceJournal(connection)); await assertHistoryRuntimeParents(connection)
    const journal = mysqlColumnStore(connection, true)
    const tableState = async (table = step.table) => {
      assert.ok([step.table, 'terminal_history_collection_receipts_v4'].includes(table))
      const [rows] = await connection.execute('SELECT TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
      if (!rows.length) return null
      assert.ok(rows.length === 1 && rows[0].kind === 'BASE TABLE' && rows[0].engine === 'InnoDB')
      const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${table}\``)
      const [[count]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``)
      const [triggers] = await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [table])
      assert.equal(triggers.length, 0)
      return { hash: tableDefinitionHash(definition['Create Table']), rows: Number(count.n) }
    }
    let baseline
    if (mode === '--prepare') {
      assert.equal(await tableState(), null)
      const history = await journal.history(), entries = validateColumnHistory(history, loaded.prior.steps)
      assert.ok(loaded.prior.steps.every(s => entries.get(s.id)?.status === 'completed'))
      const before = await snapshot()
      assert.equal(hash(originalProtected(before)), backupDataHash, 'current_data_changed_since_verified_backup')
      assert.deepEqual(history, priorReplay.history)
      assert.equal(before.length, 256)
      assert.deepEqual(await tableState('terminal_history_collection_receipts_v4'), priorReplay.tableState)
      assert.equal(before.find(t => t.name === 'database_upgrade_steps_v4').ddl, backupSnapshot.find(t => t.name === 'database_upgrade_steps_v4').ddl)
      baseline = { kind: 'history-deal-current-baseline/v1', ...binding, target, history, snapshot: before }
      const file = await open(baselinePath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(baseline, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    } else baseline = await json(baselinePath)
    assert.equal(baseline.kind, 'history-deal-current-baseline/v1'); assert.equal(baseline.target, target)
    assert.equal(baseline.rehearsalEvidenceHash, rehearsal.evidenceHash)
    assert.equal(baseline.planHash, binding.planHash); assert.deepEqual(baseline.tools, tools)
    assert.equal(baseline.restoredReceiptSha256, restored.receiptSha256)
    assert.equal(hash(originalProtected(baseline.snapshot)), backupDataHash)
    assert.equal(baseline.priorReplayHash, hash(priorReplay))
    assert.deepEqual(baseline.history, priorReplay.history)
    const protectedTables = rows => rows.filter(t => ![step.table, 'database_upgrade_steps_v4'].includes(t.name))
    const store = {
      async verifyPlan(candidate) {
        await guard(); assert.equal(hash(candidate), hash(plan)); assert.ok(await verifyInplaceJournal(connection))
        for (const [name, expected] of Object.entries(loaded.prior.finalTableHashes)) assert.equal((name === 'terminal_history_collection_receipts_v4' ? await tableState(name) : await readHistoryRuntimeTable(connection, name))?.hash, expected)
      },
      history: () => journal.history(),
      async verifyPrior(history) { assert.deepEqual(history, baseline.history) },
      async verifyProtected() {
        const current = await snapshot()
        assert.equal(hash(protectedTables(current)), hash(protectedTables(baseline.snapshot)), 'protected_tables_changed')
        assert.equal(current.find(t => t.name === 'database_upgrade_steps_v4')?.ddl, baseline.snapshot.find(t => t.name === 'database_upgrade_steps_v4')?.ddl)
      },
      tableState,
      async begin(s) { await guard(); assert.equal(s.id, step.id); await journal.begin(s) },
      async execute(s) {
        await guard(); assert.equal(s.checksum, step.checksum); report.ddlAttempted++
        await connection.query(s.sql); report.ddlAcknowledged++
      },
      async complete(s) { await guard(); await journal.complete(s) },
    }
    const beforeState = await inspectHistoryRuntimeUpgrade(store, plan)
    report.beforeState = beforeState.status
    if (mode === '--replay') assert.equal(beforeState.status, 'completed')
    report.result = await coordinateHistoryRuntimeUpgrade(store, plan, { apply: mode === '--apply' || mode === '--replay' })
    const state = await inspectHistoryRuntimeUpgrade(store, plan)
    report.afterState = state.status
    assert.equal(state.status, mode === '--prepare' ? 'pending' : 'completed')
    if (mode === '--replay') assert.equal(report.ddlAttempted, 0)
    const final = await snapshot()
    report.history = await journal.history()
    report.protectedSnapshotHash = hash(protectedTables(final))
    report.protectedTableCount = protectedTables(final).length
    report.tableState = await tableState()
  })
  if (mode !== '--prepare') {
    const adapter = { getConnection: async () => new Proxy(connection, { get(target, property) {
      if (property === 'release') return () => {}
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } }) }
    await assertMysqlTradeHistoryCollectorSchemaReady(adapter)
    report.collectorSchemaReady = true
  }
  report.passed = true
} catch (error) {
  report.error = { code: 'history_deal_current_failed', reason: /^[a-z][a-z0-9_]{2,100}$/.test(error.message ?? '') ? error.message : undefined,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) }
  process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close()
  console.log(JSON.stringify({ passed: report.passed, mode, beforeState: report.beforeState, afterState: report.afterState,
    ddlAttempted: report.ddlAttempted, ddlAcknowledged: report.ddlAcknowledged, error: report.error }))
}
