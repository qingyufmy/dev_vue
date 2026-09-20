import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadRiskStructureMigration } from './lib/inplace-risk-structure.mjs'
import { mysqlContextChangesStore } from './lib/mysql-current-context-changes.mjs'
import { coordinateContextChanges } from './lib/context-changes-coordinator.mjs'
import { withInplaceUpgradeLock, mysqlColumnStore } from './lib/mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './lib/legacy-candle-promotion.mjs'
import { validateColumnHistory } from './lib/dev-vue-column-upgrade.mjs'
import { verifyRiskRestoredSnapshot } from './lib/risk-backup-parity.mjs'
import { readRiskStructureTable } from './lib/mysql-risk-structure-state.mjs'
import { riskStructureTables } from './lib/risk-structure-source.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { verifyRiskPriorHistory } from './lib/risk-prior-history.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--inspect-restored-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url), base = 'D:/dev_codex/.backup-risk-20260909-01/'
const target = 'dev_vue_m1_source_20260909_01', uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
const output = await open(destination, 'wx', 0o600)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const doc = name => fileURLToPath(new URL('docs/architecture/' + name, root))
let source, restored, journalReview
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.user === 'root' && credential.port === 13316)
  const receiptBytes = await readFile(base + 'receipt.json'), receipt = JSON.parse(receiptBytes)
  const publicReceipt = await json(doc('risk-local-backup-verified-20260909.json'))
  assert.equal(sha256(receiptBytes), publicReceipt.privateReceiptSha256)
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.target, target)
  assert.equal(receipt.serverUuid, uuid); assert.equal(receipt.sourceUnchanged, true)
  const sourceBackup = await json(base + 'source-snapshot.json')
  const restoredBackup = await json(base + 'restored-snapshot.json')
  assert.equal(hash(sourceBackup), receipt.tablesSha256)
  verifyRiskRestoredSnapshot(sourceBackup, restoredBackup)
  const connect = async database => {
    const connection = await mysql.createConnection({ ...credential, database, timezone: 'Z', dateStrings: true,
      jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.equal(identity.db, database); assert.equal(identity.uuid, uuid)
    await connection.query("SET SESSION time_zone='+00:00'")
    return connection
  }
  const plan = await loadRiskStructureMigration(root)
  source = await connect('dev_vue')
  const sourceHistory = await mysqlColumnStore(source, true).history()
  journalReview = { rows: sourceHistory.length,
    unknown: sourceHistory.filter(row => !plan.prior.steps.some(step => step.id === row.id)).map(row => row.id) }
  console.log(JSON.stringify({ stage: 'source-journal-reviewed', ...journalReview }))
  validateColumnHistory(sourceHistory, plan.prior.steps)
  console.log(JSON.stringify({ stage: 'verify-current-166-step-proof' }))
  const sourceResult = await withInplaceUpgradeLock(source, 'dev_vue', async () => {
    const paths = { proof: doc('current-legacy-candle-promotion-proof-20260908.json'), build: doc('current-legacy-candle-build-proof-20260908.json'),
      projection: doc('current-account-projection-proof-20260908.json'), observer: doc('current-observer-context-proof-20260908.json'),
      terminal: doc('current-terminal-route-proof-20260908.json'), account: doc('current-account-root-proof-20260908.json') }
    const store = await mysqlContextChangesStore(source, plan.prior.context, root, doc('current-context-changes-proof-20260908.json'), paths)
    const checked = await verifyRiskPriorHistory(source, plan.prior, sourceHistory)
    const result = await coordinateContextChanges({ ...store, history: async () => checked.contextHistory }, plan.prior.context)
    assert.equal(result.status, 'completed')
    const snapshot = await store.snapshot()
    assert.deepEqual(snapshot, legacyCandlePromotionSnapshot(sourceBackup))
    return { result, snapshot, history: await store.history(), priorProofHash: hash(await store.proof()) }
  })
  await source.end(); source = null
  console.log(JSON.stringify({ stage: 'verify-restored-baseline' }))
  restored = await connect(target)
  const report = await withInplaceUpgradeLock(restored, target, async () => {
    const history = await mysqlColumnStore(restored, true).history()
    validateColumnHistory(history, plan.prior.steps)
    assert.deepEqual(history, sourceResult.history)
    const snapshot = legacyCandlePromotionSnapshot((await readAccountRootSnapshot(restored)).tables)
    assert.deepEqual(snapshot, legacyCandlePromotionSnapshot(restoredBackup))
    for (const table of riskStructureTables) assert.equal(await readRiskStructureTable(restored, table), null)
    return { kind: 'risk-restored-baseline/v1', passed: true, observedAt: new Date().toISOString(),
      sourceIdentity: { database: 'dev_vue', serverUuid: uuid }, restoredIdentity: { database: target, serverUuid: uuid },
      sourceSnapshotHash: hash(sourceResult.snapshot), restoredSnapshotHash: hash(snapshot),
      sourceHistoryHash: hash(sourceResult.history), restoredHistoryHash: hash(history),
      priorProofHash: sourceResult.priorProofHash, registrySteps: plan.prior.steps.length, backupReceiptHash: sha256(receiptBytes),
      currentDevVueWrites: 0, restoredWrites: 0, riskTargetsAbsent: true,
      scope: 'Current context verifier and recorded observer seed passed; restored data and schema match verified backup and identical 166-step history. No risk DDL applied.' }
  })
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, registrySteps: report.registrySteps, riskTargetsAbsent: true }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, code: 'risk_restored_baseline_failed',
    journalReview, trace: typeof error?.stack === 'string' ? error.stack.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 5) : [],
    reason: /^(context_changes_|inplace_|legacy_candle_|account_root_)[a-z_]+$/.test(error?.message ?? '') ? error.message : undefined }) + '\n')
  console.log(JSON.stringify({ passed: false, code: 'risk_restored_baseline_failed' }))
  process.exitCode = 1
} finally {
  if (source) source.destroy()
  if (restored) restored.destroy()
  await output.sync(); await output.close()
}
