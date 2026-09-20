import assert from 'node:assert/strict'
import { open, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadInstrumentCollectionUpgrade, coordinateInstrumentCollectionUpgrade, instrumentCollectionPlanHash } from './lib/instrument-collection-upgrade.mjs'
import { mysqlInstrumentCollectionStore, assertInstrumentCollectionConnection, readInstrumentCollectionTable } from './lib/mysql-instrument-collection-store.mjs'
import { mysqlColumnStore, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './lib/legacy-candle-promotion.mjs'
import { readRiskStructureTable } from './lib/mysql-risk-structure-state.mjs'
import { riskStructureTables } from './lib/risk-structure-source.mjs'
import { verifyRiskPriorHistory } from './lib/risk-prior-history.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { readRiskReceiptTable } from './lib/mysql-risk-policy-receipt-store.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--prepare', '--apply'].includes(mode) && process.argv.length === 4 && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url)
const baselinePath = 'D:/dev_codex/.backup-risk-20260909-01/instrument-current-baseline.json'
const identity = { database: 'dev_vue', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const doc = name => new URL('docs/architecture/' + name + '.json', root)
const output = await open(destination, 'wx', 0o600)
let connection, ddlAttempted = 0, ddlAcknowledged = 0
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  const reference = await json(doc('instrument-schema-reference-20260909'))
  const priorReplay = await json(doc('risk-receipt-current-upgrade-20260909'))
  const priorReference = await json(doc('risk-structure-reference-application-v3-20260909'))
  const receiptReference = await json(doc('risk-policy-receipt-and-release-reference-v2-20260909'))
  assert.equal(priorReplay.passed, true); assert.deepEqual(priorReplay.identity, identity)
  assert.equal(priorReplay.history.length, 175)
  const plan = await loadInstrumentCollectionUpgrade(root, reference)
  const rehearsalBaseline = await json('D:/dev_codex/.backup-risk-20260909-01/instrument-restored-baseline.json')
  assert.equal(rehearsalBaseline.referenceHash, hash(reference))
  assert.equal(rehearsalBaseline.planHash, instrumentCollectionPlanHash(plan))
  for (const item of rehearsalBaseline.tools) assert.equal(sha256(await readFile(new URL(item.path, root))), item.sha256)
  const rehearsals = await Promise.all(['create-loss', 'resume', 'replay'].map(name => json(doc('instrument-upgrade-' + name + '-20260909'))))
  for (const [index, report] of rehearsals.entries()) {
    assert.equal(report.passed, true); assert.equal(report.kind, 'instrument-upgrade-rehearsal/v1')
    assert.deepEqual(report.identity, rehearsalBaseline.identity)
    assert.equal(report.baselineHash, hash(rehearsalBaseline)); assert.deepEqual(report.tools, rehearsalBaseline.tools)
    assert.equal(report.currentDatabaseWrites, 0)
    assert.equal(report.result.status, index === 0 ? 'reconcile' : 'completed')
    assert.equal(report.ddlAcknowledged, index === 0 ? 1 : 0)
    assert.equal(report.history.length, 176)
    assert.deepEqual(report.history.slice(0, 175), rehearsalBaseline.priorHistory)
    assert.equal(report.history[175].checksum, plan.step.checksum)
    assert.equal(report.history[175].status, index === 0 ? 'started' : 'completed')
    assert.equal(report.protectedSnapshotHash, hash(rehearsalBaseline.protectedSnapshot))
  }
  assert.deepEqual(rehearsals[1].history, rehearsals[2].history)
  const tools = await Promise.all(['scripts/apply-instrument-upgrade-local.mjs', 'scripts/run-instrument-upgrade-current-local.py',
    'scripts/lib/instrument-collection-upgrade.mjs', 'scripts/lib/inplace-instrument-collection-schema.mjs', 'scripts/lib/single-table-upgrade-coordinator.mjs', 'scripts/lib/mysql-instrument-collection-store.mjs',
    'server/db/migrations/inplace/045_instrument_collection_requests.sql'].map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
  connection = await mysql.createConnection({ ...credential, database: identity.database, timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  const result = await withInplaceUpgradeLock(connection, identity.database, async () => {
    await assertInstrumentCollectionConnection(connection, identity)
    const journal = mysqlColumnStore(connection, true)
    const verifyPrior = async history => {
      assert.deepEqual(history, priorReplay.history)
      const originalIds = new Set(plan.prior.prior.prior.steps.map(step => step.id))
      await verifyRiskPriorHistory(connection, plan.prior.prior.prior, history.filter(row => originalIds.has(row.id)))
      const definitions = new Map(priorReference.definitions.map(row => [row.canonicalDdl.match(/^CREATE TABLE `([^`]+)`/)[1], row]))
      for (const table of riskStructureTables) {
        const actual = await readRiskStructureTable(connection, table)
        assert.equal(actual?.hash, tableDefinitionHash(definitions.get(table).canonicalDdl))
        assert.ok(actual.rows >= 0)
      }
      const receipt = await readRiskReceiptTable(connection)
      assert.equal(receipt?.hash, tableDefinitionHash(receiptReference.canonicalDdl))
      assert.ok(receipt.rows >= 0)
      return { status: 'completed' }
    }
    let baseline
    if (mode === '--prepare') {
      assert.equal(await readInstrumentCollectionTable(connection), null)
      const history = await journal.history(); await verifyPrior(history)
      const snapshot = legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables)

      baseline = { kind: 'instrument-collection-baseline/v1', identity, priorHistory: history, protectedSnapshot: snapshot,
        priorReplayHash: hash(priorReplay), referenceHash: hash(reference), tools, planHash: instrumentCollectionPlanHash(plan) }
      await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } else baseline = await json(baselinePath)
    assert.equal(baseline.priorReplayHash, hash(priorReplay)); assert.equal(baseline.referenceHash, hash(reference))
    assert.deepEqual(baseline.tools, tools); assert.equal(baseline.planHash, instrumentCollectionPlanHash(plan))
    const store = await mysqlInstrumentCollectionStore(connection, plan, root, { reference, baseline, verifyPrior })
    const tracked = { ...store, execute: async step => {
      ddlAttempted++; await store.execute(step); ddlAcknowledged++
    } }
    const state = await coordinateInstrumentCollectionUpgrade(tracked, plan, { apply: mode === '--apply' })
    return { result: state, baselineHash: hash(baseline), history: await journal.history(), tools,
      tableState: await store.tableState(), protectedSnapshotHash: hash(baseline.protectedSnapshot) }
  })
  await output.writeFile(JSON.stringify({ kind: 'instrument-upgrade-current/v1', passed: true, identity, mode, ...result,
    ddlAttempted, ddlAcknowledged,  observedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, mode, result: result.result, historyCount: result.history.length, ddlAttempted, ddlAcknowledged }))
} catch (error) {
  const report = { passed: false, mode, ddlAttempted, ddlAcknowledged, code: 'instrument_current_upgrade_failed',
    reason: /^(risk_|inplace_)[a-z_]+$/.test(error.message ?? '') ? error.message : undefined,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) }
  await output.writeFile(JSON.stringify(report) + '\n'); console.log(JSON.stringify(report)); process.exitCode = 1
} finally { if (connection) connection.destroy(); await output.sync(); await output.close() }
