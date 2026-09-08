import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { persistAccountRootMigrationProof } from './lib/mysql-account-root-migration.mjs'
import { loadLegacyCandleBuildMigration } from './lib/inplace-legacy-candle-build-migration.mjs'
import { mysqlLegacyCandleBuildMigrationStore } from './lib/mysql-current-legacy-candle-build-migration.mjs'
import { coordinateLegacyCandleBuildMigration } from './lib/legacy-candle-build-coordinator.mjs'
import { readLegacyCandleConversion } from './lib/mysql-legacy-candle-source.mjs'
import { mysqlLegacyCandleBackfillStore } from './lib/mysql-legacy-candle-backfill.mjs'
import { backfillLegacyCandles } from './lib/legacy-candle-backfill.mjs'
import { freezeLegacyCandleBackfillTools, prepareLegacyCandleBackfillProof, verifyLegacyCandleBackfillProof } from './lib/current-legacy-candle-backfill-proof.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue'
const path = name => fileURLToPath(new URL('docs/architecture/' + name, root))
let db, output, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare', '--inspect', '--apply'].includes(mode)
    && process.argv.length === 5 && isAbsolute(proofPath) && isAbsolute(destination) && proofPath !== destination)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.user === 'root' && credentials.port === 13316)
  db = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await db.query("SET SESSION time_zone='+00:00'")
  await db.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  const [[identity]] = await db.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid,@@version version')
  assert.equal(identity.databaseName, target); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const receipt = await withInplaceUpgradeLock(db, target, async () => {
    phase = 'registered-history'
    const registry = await loadLegacyCandleBuildMigration(root)
    const buildPath = path('current-legacy-candle-build-proof-20260908.json')
    const buildStore = await mysqlLegacyCandleBuildMigrationStore(db, registry, root, buildPath,
      path('current-account-projection-proof-20260908.json'), path('current-observer-context-proof-20260908.json'),
      path('current-terminal-route-proof-20260908.json'), path('current-account-root-proof-20260908.json'))
    assert.ok((await coordinateLegacyCandleBuildMigration(buildStore, registry)).steps.every(step => step.status === 'completed'))
    const rootStore = buildStore.priorStore.priorStore.priorStore.rootStore
    const buildProof = JSON.parse(await readFile(buildPath, 'utf8'))
    const conversionReview = JSON.parse(await readFile(path('current-legacy-candle-conversion-20260908.json'), 'utf8'))
    assert.equal(conversionReview.kind, 'current-legacy-candle-conversion/v1')
    assert.deepEqual(conversionReview.identity, identity)
    assert.equal(conversionReview.buildProofHash, buildProof.proofHash); assert.equal(conversionReview.timeOffsetMinutes, 0)
    for (const tool of conversionReview.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
    const buildBinding = JSON.parse(await readFile(buildPath + '.current.json', 'utf8'))
    assert.equal(hash(buildBinding.frozen), buildBinding.manifestHash)
    assert.equal(sha256(await readFile(buildPath)), buildBinding.frozen.proofFileSha256)
    for (const tool of buildBinding.frozen.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
    const areaNames = new Set(registry.additions.map(row => row.table))
    const before = await rootStore.snapshot(), protectedSnapshot = before.filter(row => !areaNames.has(row.name))
    assert.deepEqual(protectedSnapshot, buildProof.priorSnapshot)
    const historyHash = hash(await buildStore.history())
    const writerHash = sha256(await readFile(new URL('server/routes/ai/platform-market-data.js', root)))
    assert.equal(writerHash, conversionReview.conversion.basis.writerHash)
    const sourceOptions = { accountMappingHash: conversionReview.sourcePlan.accountMappingHash, writerHash }
    async function readSource(lock) {
      if (!lock) await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      try { return await readLegacyCandleConversion(db, { ...sourceOptions, lock }) }
      finally { if (!lock) await db.rollback() }
    }
    phase = 'source-plan'
    const { conversion, sourcePlan } = await readSource(false)
    assert.equal(conversion.planHash, conversionReview.conversion.planHash)
    assert.equal(sourcePlan.planHash, conversionReview.sourcePlan.planHash)
    const evidence = { identity, buildProofHash: buildProof.proofHash, conversionPlanHash: conversion.planHash,
      sourcePlanHash: sourcePlan.planHash, accountMappingHash: sourceOptions.accountMappingHash, writerHash,
      protectedSnapshotHash: hash(protectedSnapshot), historyHash, tools: await freezeLegacyCandleBackfillTools(root) }
    if (mode === '--prepare') {
      assert.equal(hash(before), conversionReview.snapshotHash)
      assert.equal(historyHash, conversionReview.historyHash)
      assert.ok(before.filter(row => areaNames.has(row.name)).every(row => row.rows === 0))
      await persistAccountRootMigrationProof(proofPath, prepareLegacyCandleBackfillProof(evidence))
    }
    const proof = JSON.parse(await readFile(proofPath, 'utf8'))
    verifyLegacyCandleBackfillProof(proof, evidence)
    const guardedTables = ['trading_accounts', 'trading_accounts_legacy_v3', 'bridge_v3_terminal_sessions',
      'mt5_account_bindings', 'market_data_sources', 'market_candles', ...areaNames]
    const schemas = new Map(before.map(row => [row.name, row.schemaSha256]))
    const store = mysqlLegacyCandleBackfillStore(db, conversion, {
      async assertIdentity() {
        await rootStore.identity()
        await buildStore.verifyPlan(registry)
        verifyLegacyCandleBackfillProof(proof, { ...evidence, tools: await freezeLegacyCandleBackfillTools(root) })
        assert.equal(hash(await buildStore.history()), historyHash)
        for (const table of guardedTables) {
          const [[row]] = await db.query('SHOW CREATE TABLE `' + table + '`')
          assert.equal(tableDefinitionHash(row['Create Table']), schemas.get(table))
        }
      },
      async verifySource(_, { lock }) { return (await readSource(lock)).conversion.planHash },
    })
    let committedBatches = 0, verificationCommitted = false
    const markVerified = store.markVerified
    store.markVerified = async (...args) => {
      await markVerified(...args); verificationCommitted = true
    }
    const applyBatch = store.applyBatch
    store.applyBatch = async (...args) => {
      await applyBatch(...args); committedBatches++
      console.log(JSON.stringify({ phase: 'batch-committed', batch: committedBatches, mappedRows: args[2].checkpoint.mappedRows }))
    }
    phase = 'backfill'
    const result = await backfillLegacyCandles(store, conversion, { apply: mode === '--apply' })
    phase = 'final-verification'
    assert.ok((await coordinateLegacyCandleBuildMigration(buildStore, registry)).steps.every(step => step.status === 'completed'))
    const after = await rootStore.snapshot()
    assert.deepEqual(after.filter(row => !areaNames.has(row.name)), protectedSnapshot)
    assert.equal(hash(await buildStore.history()), historyHash)
    return { kind: 'current-legacy-candle-backfill-result/v1', observedAt: new Date().toISOString(), identity, mode,
      proofHash: proof.proofHash, conversionPlanHash: conversion.planHash, result, committedBatches, verificationCommitted,
      inputRows: conversion.inputRows, outputRows: conversion.outputRows, duplicateRows: conversion.duplicateRows,
      protectedTableCount: protectedSnapshot.length, protectedSnapshotHash: hash(protectedSnapshot), historyHash,
      buildTables: after.filter(row => areaNames.has(row.name)).map(({ name, rows, rowsSha256, schemaSha256 }) => ({ name, rows, rowsSha256, schemaSha256 })),
      currentDevVueWritten: committedBatches > 0 || verificationCommitted, scope: 'Current database build area only; no table promotion or runtime cutover. Legacy rows and complete registered history retained.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ phase: 'receipt', mode: receipt.mode, result: receipt.result, proofHash: receipt.proofHash }))
} catch (error) {
  const code = /^legacy_candle_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'current_legacy_candle_backfill_failed'
  const cause = error?.cause ?? error
  const failure = { failed: true, code, phase, causeCode: /^legacy_candle_[a-z_]+$/.test(cause?.message ?? '') ? cause.message : undefined,
    databaseError: /^ER_[A-Z_]+$/.test(cause?.code ?? '') ? cause.code : undefined }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (db) await db.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
