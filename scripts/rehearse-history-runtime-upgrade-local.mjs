import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadHistoryRuntimeUpgrade, historyRuntimePlanHash } from './lib/history-runtime-upgrade.mjs'
import { coordinateHistoryRuntimeUpgrade } from './lib/history-runtime-coordinator.mjs'
import { mysqlHistoryRuntimeStore, readHistoryRuntimeTable } from './lib/mysql-history-runtime-store.mjs'
import { assertInstrumentCollectionConnection, readInstrumentCollectionTable } from './lib/mysql-instrument-collection-store.mjs'
import { mysqlColumnStore, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './lib/legacy-candle-promotion.mjs'
import { readRiskStructureTable } from './lib/mysql-risk-structure-state.mjs'
import { riskStructureTables } from './lib/risk-structure-source.mjs'
import { verifyRiskPriorHistory } from './lib/risk-prior-history.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { readRiskReceiptTable } from './lib/mysql-risk-policy-receipt-store.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--prepare', '--inject-create-loss', '--inject-alter-loss', '--resume'].includes(mode) && process.argv.length === 4 && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url)
const baselinePath = 'D:/dev_codex/.backup-risk-20260909-01/history-runtime-restored-baseline.json'
const identity = { database: 'dev_vue_m1_source_20260909_01', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const doc = name => new URL('docs/architecture/' + name + '.json', root)
const output = await open(destination, 'wx', 0o600)
let connection, ddlAttempted = 0, ddlAcknowledged = 0
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  const reference = await json(doc('history-runtime-reference-20260909'))
  const instrumentReference = await json(doc('instrument-schema-reference-20260909'))
  const priorReplay = await json(doc('instrument-upgrade-replay-20260909'))
  const priorReference = await json(doc('risk-structure-reference-application-v3-20260909'))
  const receiptReference = await json(doc('risk-policy-receipt-and-release-reference-v2-20260909'))
  assert.equal(priorReplay.passed, true); assert.deepEqual(priorReplay.identity, identity)
  assert.equal(priorReplay.history.length, 176)
  const plan = await loadHistoryRuntimeUpgrade(root, reference)
  const toolPaths = ['scripts/rehearse-history-runtime-upgrade-local.mjs', 'scripts/run-history-runtime-upgrade-rehearsal-local.py',
    'scripts/lib/history-runtime-upgrade.mjs', 'scripts/lib/history-runtime-coordinator.mjs', 'scripts/lib/mysql-history-runtime-store.mjs',
    'scripts/lib/mysql-history-provenance-store.mjs', 'scripts/lib/mysql-inplace-column-store.mjs',
    'scripts/lib/mysql-account-root-snapshot.mjs', 'scripts/lib/legacy-candle-promotion.mjs',
    'scripts/lib/risk-prior-history.mjs', 'server/db/migrations/inplace/046_terminal_history_order_provenance.sql',
    'server/db/migrations/inplace/047_trade_history_runtime_tables.sql']
  const tools = await Promise.all(toolPaths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
  connection = await mysql.createConnection({ ...credential, database: identity.database, timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  const result = await withInplaceUpgradeLock(connection, identity.database, async () => {
    await assertInstrumentCollectionConnection(connection, identity)
    const journal = mysqlColumnStore(connection, true)
    const verifyPrior = async history => {
      assert.deepEqual(history, priorReplay.history)
      const originalIds = new Set(plan.prior.prior.prior.prior.steps.map(step => step.id))
      await verifyRiskPriorHistory(connection, plan.prior.prior.prior.prior, history.filter(row => originalIds.has(row.id)))
      const definitions = new Map(priorReference.definitions.map(row => [row.canonicalDdl.match(/^CREATE TABLE `([^`]+)`/)[1], row]))
      for (const table of riskStructureTables) {
        const actual = await readRiskStructureTable(connection, table)
        assert.equal(actual?.hash, tableDefinitionHash(definitions.get(table).canonicalDdl))
        assert.equal(actual.rows, 0)
      }
      const receipt = await readRiskReceiptTable(connection)
      assert.equal(receipt?.hash, tableDefinitionHash(receiptReference.canonicalDdl))
      assert.equal(receipt.rows, 0)
      const instrument = await readInstrumentCollectionTable(connection)
      assert.equal(instrument?.hash, tableDefinitionHash(instrumentReference.canonicalDdl))
      assert.equal(instrument.rows, 0)
      return { status: 'completed' }
    }
    let baseline
    if (mode === '--prepare') {
      for (const table of Object.keys(plan.finalTableHashes)) assert.equal(await readHistoryRuntimeTable(connection, table), null)
      const history = await journal.history(); await verifyPrior(history)
      const snapshot = legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables)
      assert.equal(hash(snapshot.filter(row => row.name !== 'instrument_collection_requests_v4')), priorReplay.protectedSnapshotHash)
      baseline = { kind: 'history-runtime-baseline/v1', identity, priorHistory: history, protectedSnapshot: snapshot,
        priorReplayHash: hash(priorReplay), referenceHash: hash(reference), tools, planHash: historyRuntimePlanHash(plan) }
      const file = await open(baselinePath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(baseline, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    } else baseline = await json(baselinePath)
    assert.equal(baseline.priorReplayHash, hash(priorReplay)); assert.equal(baseline.referenceHash, hash(reference))
    assert.deepEqual(baseline.tools, tools); assert.equal(baseline.planHash, historyRuntimePlanHash(plan))
    const store = await mysqlHistoryRuntimeStore(connection, plan, root, { reference, baseline, verifyPrior })
    const tracked = { ...store, execute: async step => {
      ddlAttempted++; await store.execute(step); ddlAcknowledged++
      if ((mode === '--inject-create-loss' && step.operation === 'CREATE')
        || (mode === '--inject-alter-loss' && step.operation === 'ALTER')) throw Error('injected lost acknowledgement')
    } }
    let state
    if (mode === '--inject-create-loss' || mode === '--inject-alter-loss') {
      assert.notEqual((await coordinateHistoryRuntimeUpgrade(store, plan)).status, 'completed')
      await assert.rejects(coordinateHistoryRuntimeUpgrade(tracked, plan, { apply: true }), /ddl_unknown/)
      assert.ok(ddlAcknowledged >= 1)
      state = await coordinateHistoryRuntimeUpgrade(store, plan)
      assert.equal(state.status, 'reconcile')
    } else state = await coordinateHistoryRuntimeUpgrade(tracked, plan, { apply: mode === '--resume' })
    return { result: state, baselineHash: hash(baseline), history: await journal.history(), tools,
      tableStates: Object.fromEntries(await Promise.all(Object.keys(plan.finalTableHashes).map(async table => [table, await store.tableState(table)]))), protectedSnapshotHash: hash(baseline.protectedSnapshot) }
  })
  await output.writeFile(JSON.stringify({ kind: 'history-runtime-upgrade-rehearsal/v1', passed: true, identity, mode, ...result,
    ddlAttempted, ddlAcknowledged, currentDatabaseWrites: 0, observedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, mode, result: result.result, historyCount: result.history.length, ddlAttempted, ddlAcknowledged }))
} catch (error) {
  const report = { passed: false, mode, ddlAttempted, ddlAcknowledged, code: 'history_runtime_rehearsal_failed',
    reason: /^(history_runtime_|history_provenance_|risk_|inplace_)[a-z_]+$/.test(error.message ?? '') ? error.message : undefined,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) }
  await output.writeFile(JSON.stringify(report) + '\n'); console.log(JSON.stringify(report)); process.exitCode = 1
} finally { if (connection) connection.destroy(); await output.sync(); await output.close() }
