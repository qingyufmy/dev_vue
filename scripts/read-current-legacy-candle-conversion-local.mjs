import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadLegacyCandleBuildMigration } from './lib/inplace-legacy-candle-build-migration.mjs'
import { mysqlLegacyCandleBuildMigrationStore } from './lib/mysql-current-legacy-candle-build-migration.mjs'
import { coordinateLegacyCandleBuildMigration } from './lib/legacy-candle-build-coordinator.mjs'
import { readLegacyCandleConversion } from './lib/mysql-legacy-candle-source.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue'
const path = name => fileURLToPath(new URL('docs/architecture/' + name, root))
const json = async name => JSON.parse(await readFile(name, 'utf8'))
let connection, output, phase = 'arguments'
try {
  assert.equal(process.argv[2], '--read-only'); assert.equal(process.argv.length, 4); assert.ok(isAbsolute(process.argv[3] ?? ''))
  output = await open(process.argv[3], 'wx', 0o600)
  const sourcePath = path('current-account-wave-preparation-20260908.json')
  const source = await json(sourcePath)
  assert.equal(hash(source.frozen), source.manifestHash); assert.equal(source.frozen.timeOffsetMinutes, 0)
  const buildPath = path('current-legacy-candle-build-proof-20260908.json'), build = await json(buildPath), binding = await json(buildPath + '.current.json')
  assert.equal(hash(binding.frozen), binding.manifestHash); assert.equal(sha256(await readFile(buildPath)), binding.frozen.proofFileSha256)
  for (const tool of [...source.frozen.tools, ...build.tools, ...binding.frozen.tools]) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.port, 13316); assert.equal(credentials.user, 'root')
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid,@@version version')
  assert.equal(identity.databaseName, target); assert.equal(identity.serverUuid, source.frozen.targetIdentity.serverUuid)
  const report = await withInplaceUpgradeLock(connection, target, async () => {
    phase = 'registered-history'
    const registry = await loadLegacyCandleBuildMigration(root)
    const store = await mysqlLegacyCandleBuildMigrationStore(connection, registry, root, buildPath,
      path('current-account-projection-proof-20260908.json'), path('current-observer-context-proof-20260908.json'),
      path('current-terminal-route-proof-20260908.json'), path('current-account-root-proof-20260908.json'))
    assert.ok((await coordinateLegacyCandleBuildMigration(store, registry)).steps.every(step => step.status === 'completed'))
    const rootStore = store.priorStore.priorStore.priorStore.rootStore
    const before = await rootStore.snapshot(), history = await store.history()
    const area = new Set(registry.additions.map(step => step.table))
    assert.deepEqual(before.filter(table => !area.has(table.name)), build.priorSnapshot)
    assert.ok(before.filter(table => area.has(table.name)).every(table => table.rows === 0))
    const writerPath = 'server/routes/ai/platform-market-data.js', writerHash = sha256(await readFile(new URL(writerPath, root)))
    assert.equal(writerHash, source.frozen.tools.find(tool => tool.path === writerPath).sha256)
    phase = 'bounded-source-conversion'
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    let result
    try { result = await readLegacyCandleConversion(connection, { accountMappingHash: source.frozen.mappingHash, writerHash }) }
    finally { await connection.rollback() }
    phase = 'unchanged-verification'
    assert.deepEqual(await rootStore.snapshot(), before); assert.deepEqual(await store.history(), history)
    const { mappings, projections, ...conversion } = result.conversion
    assert.equal(hash(mappings), conversion.mappingHash); assert.equal(hash(projections), conversion.projectionHash)
    const paths = ['scripts/read-current-legacy-candle-conversion-local.mjs', 'scripts/lib/mysql-legacy-candle-source.mjs',
      'scripts/lib/legacy-candle-conversion.mjs', writerPath, 'docs/architecture/current-account-wave-preparation-20260908.json',
      'docs/architecture/current-legacy-candle-build-proof-20260908.json', 'docs/architecture/current-legacy-candle-build-proof-20260908.json.current.json']
    return { kind: 'current-legacy-candle-conversion/v1', observedAt: new Date().toISOString(), identity, registrySteps: registry.steps.length,
      buildProofHash: build.proofHash, accountPreparationManifestHash: source.manifestHash, sourcePlan: result.sourcePlan, conversion,
      snapshotHash: hash(before), historyHash: hash(history), databaseWrites: 0, timeOffsetMinutes: 0,
      tools: await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) }))),
      scope: 'Read-only current-database conversion plan; original IDs and UTC epoch times retained. No persisted candle backfill or promotion.' }
  })
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ inputRows: report.conversion.inputRows, outputRows: report.conversion.outputRows,
    duplicateRows: report.conversion.duplicateRows, planHash: report.conversion.planHash, databaseWrites: 0 }))
} catch (error) {
  const code = /^legacy_candle_[a-z_]+$/.test(error.message ?? '') ? error.message
    : /^ER_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'current_legacy_candle_conversion_failed'
  if (output) { await output.writeFile(JSON.stringify({ failed: true, phase, code }) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify({ failed: true, phase, code })); process.exitCode = 1
} finally { if (connection) connection.destroy(); if (output) await output.close() }
