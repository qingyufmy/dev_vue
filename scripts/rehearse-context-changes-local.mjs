import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { persistAccountRootMigrationProof } from './lib/mysql-account-root-migration.mjs'
import { loadTradingContextChanges } from './lib/inplace-trading-context-changes.mjs'
import { coordinateContextChanges } from './lib/context-changes-coordinator.mjs'
import { coordinateLegacyCandlePromotion } from './lib/inplace-legacy-candle-promotion.mjs'
import { mysqlLegacyCandlePromotionStore } from './lib/mysql-legacy-candle-promotion.mjs'
import { freezeContextChangesTools, prepareContextChangesProof, mysqlContextChangesStore } from './lib/mysql-context-changes.mjs'

const root = new URL('../', import.meta.url), database = 'dev_vue_m1_source_20260907_02'
const path = name => fileURLToPath(new URL('docs/architecture/' + name, root))
let connection
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare-restored', '--inspect-restored', '--apply-lost-ddl-restored', '--apply-restored'].includes(mode)
    && process.argv.length === 5 && isAbsolute(proofPath) && isAbsolute(destination) && proofPath !== destination)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString())
  assert.ok(credential.host === '127.0.0.1' && credential.user === 'root' && Number.isInteger(credential.port) && credential.port > 1024 && credential.port < 65536)
  connection = await mysql.createConnection({ host: credential.host, port: credential.port, user: credential.user, password: credential.password,
    database, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, database); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const report = await withInplaceUpgradeLock(connection, database, async () => {
    const plan = await loadTradingContextChanges(root)
    const priorPaths = { proof: path('legacy-candle-promotion-plan-20260908.json'), build: path('legacy-candle-build-registered-plan-20260908.json'),
      projection: path('account-projection-registered-plan-20260908.json'), observer: path('observer-context-registered-plan-20260908.json'),
      terminal: path('terminal-route-registered-plan-20260908.json'), account: path('account-root-registered-plan-20260908.json') }
    if (mode === '--prepare-restored') {
      const prior = await mysqlLegacyCandlePromotionStore(connection, plan.prior, root, priorPaths)
      assert.equal((await coordinateLegacyCandlePromotion(prior, plan.prior)).status, 'completed')
      const reference = JSON.parse(await readFile(path('context-receipt-schema-reference-20260908-v2.json'), 'utf8'))
      const proof = prepareContextChangesProof(plan, await prior.identity(), await prior.proof(), await prior.snapshot(), reference, await freezeContextChangesTools(root), await prior.history())
      await persistAccountRootMigrationProof(proofPath, proof)
    }
    const store = await mysqlContextChangesStore(connection, plan, root, proofPath, priorPaths)
    let result
    if (mode === '--apply-lost-ddl-restored') {
      const execute = store.execute; let ddlCount = 0
      store.execute = async step => { await execute(step); ddlCount++; throw Error('injected-ddl-ack-loss') }
      await assert.rejects(coordinateContextChanges(store, plan, { apply: true }), /context_changes_ddl_unknown/)
      assert.equal(ddlCount, 1); result = { status: 'ddl-unknown-injected', ddlCount }
    } else result = await coordinateContextChanges(store, plan, { apply: mode === '--apply-restored' })
    const proof = await store.proof(), snapshot = await store.snapshot()
    assert.equal(hash(snapshot.filter(row => row.name !== plan.additions[0].table)), hash(proof.priorSnapshot))
    return { kind: 'context-changes-rehearsal/v1', observedAt: new Date().toISOString(), identity: await store.identity(),
      mode, result, proofHash: proof.proofHash, registrySteps: plan.steps.length, tools: proof.tools.length,
      tableCount: snapshot.length, priorSnapshotHash: hash(proof.priorSnapshot), priorHistoryHash: proof.priorHistoryHash, table: await store.tableState(plan.additions[0]),
      currentDevVueWritten: false, scope: 'Restored database only; no application activation, context writes or current dev_vue upgrade.' }
  })
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ result: report.result, tableCount: report.tableCount, tools: report.tools }))
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: /^(context_changes_|legacy_candle_|account_root_|inplace_)[a-z_]+$/.test(error?.message ?? '') ? error.message : 'context_changes_rehearsal_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end() }
