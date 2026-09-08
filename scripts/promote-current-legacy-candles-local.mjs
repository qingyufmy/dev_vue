import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { withAccountRootWriteFreeze } from './lib/account-root-write-freeze.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { persistAccountRootMigrationProof } from './lib/mysql-account-root-migration.mjs'
import { loadLegacyCandlePromotion, coordinateLegacyCandlePromotion } from './lib/inplace-legacy-candle-promotion.mjs'
import { mysqlLegacyCandleBuildMigrationStore } from './lib/mysql-current-legacy-candle-build-migration.mjs'
import { coordinateLegacyCandleBuildMigration } from './lib/legacy-candle-build-coordinator.mjs'
import { freezeLegacyCandlePromotionTools, prepareVerifiedCandlePromotionProof, mysqlLegacyCandlePromotionStore } from './lib/mysql-current-legacy-candle-promotion.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue'
const path = name => fileURLToPath(new URL('docs/architecture/' + name, root))
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let connection, observer, output, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare', '--inspect', '--apply'].includes(mode) && process.argv.length === 5
    && isAbsolute(proofPath) && isAbsolute(destination) && proofPath !== destination)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.user === 'root' && credentials.port === 13316)
  const connect = () => mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectTimeout: 5000 })
  connection = await connect(); observer = await connect()
  await connection.query("SET SESSION time_zone='+00:00'")
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    const plan = await loadLegacyCandlePromotion(root)
    const paths = { proof: proofPath, build: path('current-legacy-candle-build-proof-20260908.json'),
      projection: path('current-account-projection-proof-20260908.json'), observer: path('current-observer-context-proof-20260908.json'),
      terminal: path('current-terminal-route-proof-20260908.json'), account: path('current-account-root-proof-20260908.json') }
    const backfill = await json(path('current-legacy-candle-backfill-proof-20260908.json'))
    const verified = await json(path('current-legacy-candle-backfill-repeat-20260908.json'))
    const reference = await json(path('current-legacy-candle-build-reference-20260908.json'))
    const { proofHash: referenceHash, ...referenceBody } = reference
    assert.equal(hash(referenceBody), referenceHash)
    assert.equal(reference.referenceRemoved, true); assert.equal(reference.sourceWritten, false)
    assert.equal(reference.identity.database, target)
    const probe = await json(path('account-root-write-freeze-probe-20260908-v4.json'))
    assert.equal(probe.temporaryDatabaseRemoved, true); assert.equal(probe.checks.length, 7)
    for (const tool of probe.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
    const [names] = await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
    let expectedNames = names.map(row => row.name)
    phase = 'write-freeze'
    return withAccountRootWriteFreeze(connection, observer, target, expectedNames, async held => {
      if (mode === '--prepare') {
        phase = 'prepare'
        const prior = await mysqlLegacyCandleBuildMigrationStore(connection, plan.prior, root,
          paths.build, paths.projection, paths.observer, paths.terminal, paths.account)
        assert.ok((await coordinateLegacyCandleBuildMigration(prior, plan.prior)).steps.every(row => row.status === 'completed'))
        const rootStore = prior.priorStore.priorStore.priorStore.rootStore
        const tables = (await readAccountRootSnapshot(connection)).tables
        const proof = prepareVerifiedCandlePromotionProof(plan, await rootStore.identity(), tables, backfill, verified,
          hash(await prior.history()), await freezeLegacyCandlePromotionTools(root))
        // The current reference actually exercised the same rename and both mapping FKs.
        for (const name of ['market_candles', 'legacy_candle_mappings_v4']) {
          const definition = reference.promotedDefinitions.find(row => row.table === name)
          assert.ok(definition)
          assert.equal(proof.after.find(row => row.name === name).schemaSha256, tableDefinitionHash(definition.ddl))
        }
        await held.assertHeld(expectedNames)
        await persistAccountRootMigrationProof(proofPath, proof)
      }
      phase = 'promotion'
      const store = await mysqlLegacyCandlePromotionStore(connection, plan, root, paths)
      const proof = await store.proof()
      assert.deepEqual(proof.identity, { database: target, serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' })
      const shape = rows => JSON.stringify([...rows].sort())
      assert.ok([proof.before, proof.after].some(rows => shape(rows.map(row => row.name)) === shape(expectedNames)))
      for (const name of ['history', 'snapshot', 'verifyPrior', 'begin', 'complete']) {
        const original = store[name]
        store[name] = async (...args) => { await held.assertHeld(expectedNames); return original(...args) }
      }
      const execute = store.execute
      store.execute = async sql => {
        await held.assertHeld(expectedNames)
        await execute(sql)
        expectedNames = proof.after.map(row => row.name)
        await held.assertHeld(expectedNames)
      }
      const result = await coordinateLegacyCandlePromotion(store, plan, { apply: mode === '--apply' })
      phase = 'verify-result'
      const snapshot = await store.snapshot()
      assert.deepEqual(snapshot, result.status === 'pending' ? proof.before : proof.after)
      const ids = new Set(plan.prior.steps.map(row => row.id))
      assert.equal(hash((await store.history()).filter(row => ids.has(row.id))), verified.historyHash)
      await held.assertHeld(expectedNames)
      return { kind: 'current-legacy-candle-promotion-result/v1', observedAt: new Date().toISOString(), identity: await store.identity(), mode,
        result, registrySteps: plan.steps.length, proofHash: proof.proofHash, backfillProofHash: backfill.proofHash,
        tableCount: snapshot.length, snapshotHash: hash(snapshot), priorHistoryHash: verified.historyHash,
        candleTables: snapshot.filter(row => ['market_candles', 'market_candles_build_v4', 'market_candles_legacy_v3', 'legacy_candle_backfill_v4', 'legacy_candle_mappings_v4'].includes(row.name)),
        currentDevVueWritten: ['applied', 'reconciled'].includes(result.status), runtimeActivated: false,
        scope: 'Current database atomic promotion only; all legacy rows, target rows and registered history retained. No runtime cutover.' }
    })
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ result: receipt.result, tableCount: receipt.tableCount, proofHash: receipt.proofHash }))
} catch (error) {
  const cause = error?.cause ?? error
  const failure = { failed: true, phase, code: /^(?:legacy_candle|account_root_freeze)_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'current_legacy_candle_promotion_failed',
    databaseError: /^ER_[A-Z_]+$/.test(cause?.code ?? '') ? cause.code : undefined }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (connection) connection.destroy(); if (observer) observer.destroy(); if (output) await output.close().catch(() => {}) }
