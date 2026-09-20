import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mysqlRiskStructureStore } from './lib/mysql-risk-structure-store.mjs'
import { coordinateRiskStructure } from './lib/risk-structure-coordinator.mjs'
import { open, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadRiskPolicyReceiptUpgrade, coordinateRiskPolicyReceiptUpgrade, riskReceiptPlanHash } from './lib/risk-policy-receipt-upgrade.mjs'
import { mysqlRiskPolicyReceiptStore, assertRiskReceiptConnection, readRiskReceiptTable } from './lib/mysql-risk-policy-receipt-store.mjs'
import { mysqlColumnStore, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './lib/legacy-candle-promotion.mjs'
import { readRiskStructureTable } from './lib/mysql-risk-structure-state.mjs'
import { riskStructureTables } from './lib/risk-structure-source.mjs'
import { verifyRiskPriorHistory } from './lib/risk-prior-history.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--prepare', '--apply'].includes(mode) && process.argv.length === 4 && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url)
const baselinePath = 'D:/dev_codex/.backup-risk-20260909-01/risk-receipt-current-baseline.json'
const identity = { database: 'dev_vue', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const doc = name => new URL('docs/architecture/' + name + '.json', root)
const output = await open(destination, 'wx', 0o600)
let connection, ddlAttempted = 0, ddlAcknowledged = 0
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  const reference = await json(doc('risk-policy-receipt-and-release-reference-v2-20260909'))
  const priorReplay = await json(doc('risk-rehearsal-application-v3-replay-20260909'))
  const priorReference = await json(doc('risk-structure-reference-application-v3-20260909'))
  assert.equal(priorReplay.passed, true); assert.equal(priorReplay.identity.serverUuid, identity.serverUuid)
  assert.equal(priorReplay.referenceHash, hash(priorReference))
  const plan = await loadRiskPolicyReceiptUpgrade(root, reference)
  const tools = await Promise.all(['scripts/apply-risk-policy-upgrade-local.mjs', 'scripts/run-risk-policy-upgrade-current-local.py',
    'scripts/lib/risk-policy-receipt-upgrade.mjs', 'scripts/lib/single-table-upgrade-coordinator.mjs', 'scripts/lib/mysql-risk-policy-receipt-store.mjs',
    'server/db/migrations/inplace/044_risk_policy_write_receipts.sql'].map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
  const rehearsalBaseline = await json('D:/dev_codex/.backup-risk-20260909-01/risk-receipt-restored-baseline.json')
  assert.equal(rehearsalBaseline.referenceHash, hash(reference)); assert.equal(rehearsalBaseline.planHash, riskReceiptPlanHash(plan))
  for (const item of rehearsalBaseline.tools) assert.equal(sha256(await readFile(new URL(item.path, root))), item.sha256)
  const rehearsalReports = await Promise.all(['create-loss','resume','replay'].map(name => json(doc('risk-receipt-upgrade-' + name + '-20260909'))))
  for (const [index, report] of rehearsalReports.entries()) {
    assert.equal(report.passed, true); assert.equal(report.kind, 'risk-receipt-upgrade-rehearsal/v1')
    assert.equal(report.baselineHash, hash(rehearsalBaseline)); assert.deepEqual(report.tools, rehearsalBaseline.tools)
    assert.deepEqual(report.identity, rehearsalBaseline.identity); assert.equal(report.currentDatabaseWrites, 0)
    assert.equal(report.ddlAcknowledged, index === 0 ? 1 : 0)
    assert.equal(report.result.status, index === 0 ? 'reconcile' : 'completed')
    assert.equal(report.history.length, 175); assert.deepEqual(report.history.slice(0,174), rehearsalBaseline.priorHistory)
    assert.equal(report.history[174].checksum, plan.step.checksum); assert.equal(report.history[174].id, plan.step.id)
    assert.equal(report.history[174].status, index === 0 ? 'started' : 'completed')
    assert.equal(report.protectedSnapshotHash, hash(rehearsalBaseline.protectedSnapshot))
  }
  assert.deepEqual(rehearsalReports[1].history, rehearsalReports[2].history)
  const rehearsalHash = hash(rehearsalReports)
  connection = await mysql.createConnection({ ...credential, database: identity.database, timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  const result = await withInplaceUpgradeLock(connection, identity.database, async () => {
    await assertRiskReceiptConnection(connection, identity)
    const journal = mysqlColumnStore(connection, true)
    const verifyPrior = async history => {
      if (baseline) assert.deepEqual(history, baseline.priorHistory)
      const originalIds = new Set(plan.prior.prior.steps.map(step => step.id))
      await verifyRiskPriorHistory(connection, plan.prior.prior, history.filter(row => originalIds.has(row.id)))
      const definitions = new Map(priorReference.definitions.map(row => [row.canonicalDdl.match(/^CREATE TABLE `([^`]+)`/)[1], row]))
      for (const table of riskStructureTables) {
        const actual = await readRiskStructureTable(connection, table)
        assert.equal(actual?.hash, tableDefinitionHash(definitions.get(table).canonicalDdl))
        assert.equal(actual.rows, 0)
      }
      return { status: 'completed' }
    }
    let baseline
    if (mode === '--prepare') {
      assert.equal(await readRiskReceiptTable(connection), null)
      const base = 'D:/dev_codex/.backup-risk-20260909-01/application-v1/'
      const d = name => fileURLToPath(doc(name))
      const priorStore = await mysqlRiskStructureStore(connection, plan.prior, root, {
        proofPath: base + 'risk-structure-proof.json', restorePath: base + 'risk-structure-restore.json',
        referencePath: d('risk-structure-reference-application-v3-20260909'), priorProofPath: d('current-context-changes-proof-20260908'),
        priorPaths: { proof: d('current-legacy-candle-promotion-proof-20260908'), build: d('current-legacy-candle-build-proof-20260908'),
          projection: d('current-account-projection-proof-20260908'), observer: d('current-observer-context-proof-20260908'),
          terminal: d('current-terminal-route-proof-20260908'), account: d('current-account-root-proof-20260908') } })
      assert.equal((await coordinateRiskStructure(priorStore, plan.prior)).status, 'completed')
      const history = await journal.history(); await verifyPrior(history)
      const snapshot = legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables)

      baseline = { kind: 'risk-receipt-baseline/v1', identity, priorHistory: history, protectedSnapshot: snapshot,
        rehearsalHash, priorReplayHash: hash(priorReplay), referenceHash: hash(reference), tools, planHash: riskReceiptPlanHash(plan) }
      await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } else baseline = await json(baselinePath)
    assert.equal(baseline.rehearsalHash, rehearsalHash)
    assert.equal(baseline.priorReplayHash, hash(priorReplay)); assert.equal(baseline.referenceHash, hash(reference))
    assert.deepEqual(baseline.tools, tools); assert.equal(baseline.planHash, riskReceiptPlanHash(plan))
    const store = await mysqlRiskPolicyReceiptStore(connection, plan, root, { reference, baseline, verifyPrior })
    const tracked = { ...store, execute: async step => {
      ddlAttempted++; await store.execute(step); ddlAcknowledged++
    } }
    const state = await coordinateRiskPolicyReceiptUpgrade(tracked, plan, { apply: mode === '--apply' })
    if (mode === '--apply') assert.deepEqual(await coordinateRiskPolicyReceiptUpgrade(tracked, plan, { apply: true }), { status: 'completed', ddlCount: 0 })
    return { result: state, baselineHash: hash(baseline), history: await journal.history(), tools,
      tableState: await store.tableState(), protectedSnapshotHash: hash(baseline.protectedSnapshot) }
  })
  await output.writeFile(JSON.stringify({ kind: 'risk-receipt-current-upgrade/v1', passed: true, identity, mode, ...result,
    ddlAttempted, ddlAcknowledged, observedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, mode, result: result.result, historyCount: result.history.length, ddlAttempted, ddlAcknowledged }))
} catch (error) {
  const report = { passed: false, mode, ddlAttempted, ddlAcknowledged, code: 'risk_receipt_current_upgrade_failed',
    reason: /^(risk_|inplace_)[a-z_]+$/.test(error.message ?? '') ? error.message : undefined,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) }
  await output.writeFile(JSON.stringify(report) + '\n'); console.log(JSON.stringify(report)); process.exitCode = 1
} finally { if (connection) connection.destroy(); await output.sync(); await output.close() }
