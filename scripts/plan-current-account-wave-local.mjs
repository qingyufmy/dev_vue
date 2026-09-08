import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { prepareCurrentAccountWave } from './lib/current-account-wave-preparation.mjs'
import { withAccountSourceFreeze } from './lib/account-source-freeze.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { hash, validateSpec } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
let control, reader
try {
  assert.equal(process.argv[2], '--prepare'); assert.equal(process.argv.length, 4); assert.ok(isAbsolute(process.argv[3] ?? ''))
  const source = JSON.parse(await readFile('docs/architecture/current-account-wave-preparation-20260908.json', 'utf8'))
  const backupPath = 'docs/architecture/current-local-backup-restoration-20260908.json'
  const backupBytes = await readFile(backupPath), backup = JSON.parse(backupBytes)
  assert.equal(backup.status, 'verified'); assert.equal(backup.source, 'dev_vue')
  assert.equal(backup.preparationManifestHash, source.manifestHash)
  assert.equal(backup.sourceTablesSha256, hash(source.frozen.tables))
  assert.ok(backup.completeRowParity && backup.completeColumnMetadataParity && backup.semanticDdlParity)
  for (const tool of backup.tools) assert.equal(sha256(await readFile(tool.path)), tool.sha256)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root'); assert.equal(credentials.port, 13316)
  const connect = () => mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database: 'dev_vue', timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectTimeout: 5000 })
  control = await connect(); reader = await connect()
  const result = await withInplaceUpgradeLock(control, 'dev_vue', () => withAccountSourceFreeze(control, 'dev_vue', async freeze => {
    await reader.query("SET SESSION time_zone='+00:00'")
    await reader.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const current = await prepareCurrentAccountWave(reader, root)
    await reader.rollback()
    assert.deepEqual(current, { frozen: source.frozen, manifestHash: source.manifestHash })
    await freeze.assertHeld()
    const tools = await Promise.all(['scripts/plan-current-account-wave-local.mjs', 'scripts/lib/account-source-freeze.mjs']
      .map(async path => ({ path, sha256: sha256(await readFile(path)) })))
    const frozen = { kind: 'current-account-wave-execution-plan/v1', targetIdentity: source.frozen.targetIdentity,
      preparationManifestHash: source.manifestHash, backup: { path: backupPath, sha256: sha256(backupBytes), mirrorDatabase: backup.target },
      sourceSnapshotHash: hash({ account: source.frozen.account.sourceHash, ownership: source.frozen.ownershipEvidenceHash }),
      runs: [source.frozen.account, source.frozen.ownership].map(stream => ({ runId: randomUUID(), stream: stream.stream,
        transformHash: stream.transformHash, sourceRows: stream.sourceRows, batches: stream.batches })),
      tools, requiredGuards: ['inplace_upgrade_lock', 'live_source_range_locks', 'source_input_hash', 'protected_table_hashes',
        'prior_ledger_rows_preserved', 'exact_final_projection'], timeOffsetMinutes: 0 }
    const manifestHash = hash(frozen)
    for (const run of frozen.runs) validateSpec({ runId: run.runId, admission: { approved: true, blockers: [] }, bindings: {
      logicalSourceId: 'dev_vue', sourceDatabase: 'dev_vue', mirrorDatabase: backup.target, targetDatabase: 'dev_vue',
      targetServerUuid: frozen.targetIdentity.serverUuid, storageMode: 'inplace-account-v2', schemaHash: frozen.targetIdentity.schemaHash,
      snapshotHash: frozen.sourceSnapshotHash, manifestHash, transformHash: run.transformHash, streams: [run.stream],
    } })
    return { observedAt: new Date().toISOString(), frozen, manifestHash, sourceLocksVerified: freeze.locked,
      databaseWrites: 0, applied: false, scope: 'Stable run IDs and exact batch manifests. Apply must reacquire live guards and revalidate source, existing receipts and protected rows; this file is not an execution receipt.' }
  }))
  await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ manifestHash: result.manifestHash, runs: result.frozen.runs.map(run => ({ runId: run.runId, rows: run.sourceRows, batches: run.batches.length })), databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: 'current_account_wave_plan_failed' })); process.exitCode = 1
} finally { if (reader) reader.destroy(); if (control) control.destroy() }
