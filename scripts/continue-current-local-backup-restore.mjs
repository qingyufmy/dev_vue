import assert from 'node:assert/strict'
import { readFile, writeFile, unlink, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { runLocalBackupProcess, discardLocalBackupOutput } from './lib/local-backup-process.mjs'
import { decryptLocalBackup } from './lib/local-backup-stream.mjs'
import { backupRestoreArgs } from './lib/v4-backup-executor.mjs'
import { inspectBackupSql } from './lib/v4-backup-sql-scope-v2.mjs'
import { inspectBackupDatabase } from './lib/v4-backup-preflight.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

// One specific, failed-before-CREATE backup. No restart of a partial restore.
const directory = 'D:/dev_codex/.backup-current-20260908-03'
const keys = 'C:/Users/Administrator/.aurum-backup-keys-20260908-03'
const target = 'dev_vue_m1_source_20260908_03', uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const persist = (name, value) => writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
let connection, key, configCreated = false, rawCreated = false, attempted = false, stage = 'arguments'
const raw = join(directory, 'continuation-verified.sql'), config = join(keys, 'continuation-client.cnf')
const mark = value => { stage = value; console.log(JSON.stringify({ stage })) }
try {
  assert.ok(process.platform === 'win32' && process.argv.length === 3 && process.argv[2] === '--restore-existing-03')
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  for (const path of [directory, keys]) await runLocalBackupProcess({ command: powershell,
    args: ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/private-local-backup-directory.ps1'), '-Mode', 'Verify', '-Path', path],
    consume: discardLocalBackupOutput, timeoutMs: 15000 })
  for (const name of ['continuation-create-attempt.json', 'continuation-receipt.json']) {
    await assert.rejects(access(join(directory, name)), { code: 'ENOENT' })
  }
  const failure = await json(join(directory, 'failure.json'))
  assert.equal(failure.targetCreationAttempted, false); assert.equal(failure.stage, 'authenticate-and-review-sql')
  const attempt = await json('docs/architecture/current-local-backup-attempt-20260908.json')
  const artifact = await json(join(directory, 'encrypted-artifact.json'))
  assert.deepEqual(artifact, attempt.artifact)
  const preparation = await json('docs/architecture/current-account-wave-preparation-20260908.json')
  assert.equal(hash(preparation.frozen), preparation.manifestHash)
  for (const tool of preparation.frozen.tools) assert.equal(sha256(await readFile(tool.path)), tool.sha256)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  const connect = database => mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectTimeout: 5000 })
  connection = await connect('dev_vue')
  const absent = async () => {
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
    assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, uuid); assert.equal(identity.version, '8.4.8')
    const [existing] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [target])
    assert.equal(existing.length, 0)
  }
  await absent()
  const snapshot = async database => {
    const c = await connect(database)
    try {
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      const tables = (await readAccountRootSnapshot(c)).tables.map(({ name, rows, rowsSha256, ddl }) => ({ name, rows, rowsSha256, ddlSha256: sha256(ddl) }))
      await c.rollback(); return tables
    } finally { c.destroy() }
  }
  assert.deepEqual(await snapshot('dev_vue'), preparation.frozen.tables)
  mark('authenticate-existing-backup')
  key = await readFile(join(keys, 'backup.key'))
  await decryptLocalBackup(join(directory, 'source.sql.enc'), raw, key, artifact); rawCreated = true
  key.fill(0)
  const before = await json(join(directory, 'source-observation.json'))
  mark('review-sql-v2')
  const review = await inspectBackupSql(createReadStream(raw), { tables: before.tables })
  await persist('continuation-sql-review.json', review)
  const provision = await json('docs/architecture/local-mysql-client-provision-20260908.json')
  const client = provision.clients.find(item => item.path.endsWith('\\mysql.exe'))
  assert.equal(sha256(await readFile(client.path)), client.sha256)
  const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"'
  await writeFile(config, `[client]\nhost=127.0.0.1\nport=${credentials.port}\nuser=root\npassword=${quote(credentials.password)}\nprotocol=TCP\n`, { flag: 'wx', mode: 0o600 }); configCreated = true
  mark('create-isolated-restore')
  await absent()
  assert.equal(before.schemaFingerprint.charset, 'utf8mb4'); assert.equal(before.schemaFingerprint.collation, 'utf8mb4_general_ci')
  await persist('continuation-create-attempt.json', { target, uuid, atUtc: new Date().toISOString() }); attempted = true
  await connection.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  mark('restore-verified-sql')
  await runLocalBackupProcess({ command: client.path, args: [`--defaults-file=${config.replaceAll('\\', '/')}`, ...backupRestoreArgs(target).slice(1)],
    input: createReadStream(raw), consume: discardLocalBackupOutput })
  mark('verify-restored-data')
  const observer = await connect(target)
  let restored
  try { restored = await inspectBackupDatabase(observer, { database: target, expectedServerUuid: uuid, role: 'restored-source',
    sourceDatabase: 'dev_vue', restoreDatabase: target, timeoutMs: 180000 }) } finally { observer.destroy() }
  assert.equal(restored.schemaFingerprint.sha256, before.schemaFingerprint.sha256)
  assert.deepEqual(await snapshot(target), preparation.frozen.tables)
  assert.deepEqual(await snapshot('dev_vue'), preparation.frozen.tables)
  const tools = await Promise.all(['scripts/continue-current-local-backup-restore.mjs', 'scripts/lib/v4-backup-sql-scope-v2.mjs',
    'scripts/lib/local-backup-process.mjs', 'scripts/lib/local-backup-stream.mjs', 'scripts/private-local-backup-directory.ps1'].map(async path => ({ path, sha256: sha256(await readFile(path)) })))
  const receipt = { kind: 'current-local-backup-restoration/v1', status: 'verified', observedAt: new Date().toISOString(), source: 'dev_vue', target,
    serverUuid: uuid, preparationManifestHash: preparation.manifestHash, artifact, tools, schemaSha256: restored.schemaFingerprint.sha256,
    tablesSha256: hash(preparation.frozen.tables), tableCount: restored.tables.length, totalRows: restored.totalRows,
    sqlScopeReviewed: true, completeRowAndDdlParity: true, sourceUnchanged: true, currentDevVueWrites: 0, currentDatabaseUpgraded: false }
  await persist('continuation-receipt.json', receipt)
  console.log(JSON.stringify(receipt))
} catch (error) {
  const cause = /^backup_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'unclassified'
  const failure = { failed: true, stage, cause, target, targetCreationAttempted: attempted }
  await persist('continuation-failure.json', failure).catch(() => {})
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  if (key) key.fill(0)
  if (rawCreated) await unlink(raw).catch(() => { process.exitCode = 1 })
  if (configCreated) await unlink(config).catch(() => { process.exitCode = 1 })
}
