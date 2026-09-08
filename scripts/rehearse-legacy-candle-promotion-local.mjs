import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { persistAccountRootMigrationProof } from './lib/mysql-account-root-migration.mjs'
import { loadLegacyCandlePromotion, coordinateLegacyCandlePromotion } from './lib/inplace-legacy-candle-promotion.mjs'
import { mysqlLegacyCandleBuildMigrationStore } from './lib/mysql-legacy-candle-build-migration.mjs'
import { coordinateLegacyCandleBuildMigration } from './lib/legacy-candle-build-coordinator.mjs'
import { freezeLegacyCandlePromotionTools, prepareVerifiedCandlePromotionProof, mysqlLegacyCandlePromotionStore } from './lib/mysql-legacy-candle-promotion.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
const path = name => fileURLToPath(new URL('docs/architecture/' + name, root))
let connection, output, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare-restored-only', '--read-only-restored', '--apply-lost-ddl-restored-only', '--apply-restored-only'].includes(mode)
    && process.argv.length === 5 && isAbsolute(proofPath) && isAbsolute(destination) && proofPath !== destination)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.user === 'root' && Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    const plan = await loadLegacyCandlePromotion(root)
    const paths = { proof: proofPath, build: path('legacy-candle-build-registered-plan-20260908.json'),
      projection: path('account-projection-registered-plan-20260908.json'), observer: path('observer-context-registered-plan-20260908.json'),
      terminal: path('terminal-route-registered-plan-20260908.json'), account: path('account-root-registered-plan-20260908.json') }
    const backfill = JSON.parse(await readFile(path('legacy-candle-backfill-plan-20260908.json'), 'utf8'))
    const verified = JSON.parse(await readFile(path('legacy-candle-backfill-repeat-20260908.json'), 'utf8'))
    if (mode === '--prepare-restored-only') {
      phase = 'prepare'
      const priorStore = await mysqlLegacyCandleBuildMigrationStore(connection, plan.prior, root, paths.build, paths.projection, paths.observer, paths.terminal, paths.account)
      assert.ok((await coordinateLegacyCandleBuildMigration(priorStore, plan.prior)).steps.every(row => row.status === 'completed'))
      const rootStore = priorStore.priorStore.priorStore.priorStore.rootStore
      const tables = (await readAccountRootSnapshot(connection)).tables
      const proof = prepareVerifiedCandlePromotionProof(plan, await rootStore.identity(), tables, backfill, verified,
        hash(await priorStore.history()), await freezeLegacyCandlePromotionTools(root))
      await persistAccountRootMigrationProof(proofPath, proof)
    }
    phase = 'promotion'
    const store = await mysqlLegacyCandlePromotionStore(connection, plan, root, paths)
    let result
    if (mode === '--apply-lost-ddl-restored-only') {
      const execute = store.execute; let ddlCount = 0
      store.execute = async sql => { await execute(sql); ddlCount++; throw Error('injected_ddl_ack_lost') }
      await assert.rejects(coordinateLegacyCandlePromotion(store, plan, { apply: true }), /legacy_candle_promotion_ddl_unknown/)
      assert.equal(ddlCount, 1)
      result = { status: 'ddl-unknown-injected', ddlCount }
    } else result = await coordinateLegacyCandlePromotion(store, plan, { apply: mode === '--apply-restored-only' })
    phase = 'verify-result'
    const proof = await store.proof(), snapshot = await store.snapshot()
    const promoted = result.status !== 'pending'
    assert.deepEqual(snapshot, promoted ? proof.after : proof.before)
    const ids = new Set(plan.prior.steps.map(row => row.id))
    assert.equal(hash((await store.history()).filter(row => ids.has(row.id))), verified.historyHash)
    return { kind: 'legacy-candle-promotion-rehearsal/v1', observedAt: new Date().toISOString(), identity: await store.identity(), mode,
      result, registrySteps: plan.steps.length, proofHash: proof.proofHash, backfillProofHash: backfill.proofHash,
      tableCount: snapshot.length, snapshotHash: hash(snapshot), priorHistoryHash: verified.historyHash,
      candleTables: snapshot.filter(row => ['market_candles', 'market_candles_build_v4', 'market_candles_legacy_v3', 'legacy_candle_backfill_v4', 'legacy_candle_mappings_v4'].includes(row.name)),
      currentDevVueWritten: false, scope: 'Restored database promotion only; all rows and registered history retained. No application or production cutover.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ result: receipt.result, tableCount: receipt.tableCount, proofHash: receipt.proofHash }))
} catch (error) {
  const cause = error?.cause ?? error
  const failure = { failed: true, phase, code: /^legacy_candle_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'legacy_candle_promotion_rehearsal_failed',
    databaseError: /^ER_[A-Z_]+$/.test(cause?.code ?? '') ? cause.code : undefined }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
