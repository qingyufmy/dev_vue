import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, unlink, statfs } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { runLocalBackupProcess, discardLocalBackupOutput } from './lib/local-backup-process.mjs'
import { encryptLocalBackup, decryptLocalBackup } from './lib/local-backup-stream.mjs'
import { backupDumpArgs, backupRestoreArgs, compareRestoredDump } from './lib/v4-backup-executor.mjs'
import { inspectBackupDatabase } from './lib/v4-backup-preflight.mjs'
import { inspectBackupSql } from './lib/v4-backup-sql-scope-v3.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { loadBridgeInstallationUpgrade } from './lib/bridge-installation-upgrade.mjs'
import { verifyRiskRestoredSnapshot } from './lib/risk-backup-parity.mjs'

const root = new URL('../', import.meta.url), uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
let guard, configPath, directory, key, stage = 'arguments', targetCreationAttempted = false
const plaintext = []
const privateJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
try {
  const [mode, runId, archivePath, keyPath] = process.argv.slice(2)
  assert.ok(process.platform === 'win32' && mode === '--execute' && /^\d{8}-\d{2}$/.test(runId)
    && isAbsolute(archivePath ?? '') && isAbsolute(keyPath ?? '') && process.argv.length === 6)
  directory = resolve(archivePath)
  const keys = resolve(keyPath)
  assert.notEqual(directory, keys)
  assert.ok(!directory.startsWith(keys + '\\') && !keys.startsWith(directory + '\\'))
  const target = `dev_vue_m1_source_${runId.replace('-', '_')}`
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  const connect = database => mysql.createConnection({ ...credentials, database, timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  const identity = async connection => {
    const [[row]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
    assert.equal(row.db, 'dev_vue'); assert.equal(row.uuid, uuid); assert.equal(row.version, '8.4.8')
  }
  const absent = async connection => {
    await identity(connection)
    const [rows] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [target])
    assert.equal(rows.length, 0)
  }
  guard = await connect('dev_vue'); await absent(guard)
  const provision = JSON.parse(await readFile(new URL('docs/architecture/local-mysql-client-provision-20260908.json', root)))
  for (const client of provision.clients) assert.equal(sha256(await readFile(client.path)), client.sha256)
  const binary = name => provision.clients.find(client => client.path.endsWith('\\' + name)).path
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const privateDirectory = (path, mode) => runLocalBackupProcess({ command: powershell,
    args: ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/private-local-backup-directory.ps1'), '-Mode', mode, '-Path', path],
    consume: discardLocalBackupOutput, timeoutMs: 15000 })
  await privateDirectory(directory, 'Create'); await privateDirectory(keys, 'Create')
  for (const path of [directory, keys]) { const free = await statfs(path, { bigint: true }); assert.ok(free.bavail * free.bsize > 10n * 1024n ** 3n) }
  const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"'
  configPath = join(keys, 'mysql-client.cnf')
  await writeFile(configPath, `[client]\nhost=127.0.0.1\nport=${credentials.port}\nuser=root\npassword=${quote(credentials.password)}\nprotocol=TCP\n`, { flag: 'wx', mode: 0o600 })
  key = randomBytes(32); await writeFile(join(keys, 'backup.key'), key, { flag: 'wx', mode: 0o600 })
  const args = original => [`--defaults-file=${configPath.replaceAll('\\', '/')}`, ...original.slice(1)]
  const observe = async database => {
    const connection = await connect(database)
    try { return await inspectBackupDatabase(connection, { database, expectedServerUuid: uuid,
      role: database === 'dev_vue' ? 'source' : 'restored-source', sourceDatabase: 'dev_vue',
      ...(database === target ? { restoreDatabase: target } : {}), timeoutMs: 180000 }) }
    finally { connection.destroy() }
  }
  const snapshot = async database => {
    const connection = await connect(database)
    try {
      await connection.query("SET SESSION time_zone='+00:00'")
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      const tables = (await readAccountRootSnapshot(connection)).tables
      const [columns] = await connection.query('SELECT TABLE_NAME tableName,COLUMN_NAME name,ORDINAL_POSITION ordinalPosition,COLUMN_DEFAULT defaultValue,IS_NULLABLE nullable,DATA_TYPE dataType,COLUMN_TYPE columnType,CHARACTER_SET_NAME characterSet,COLLATION_NAME collation,COLUMN_KEY columnKey,EXTRA extra,COLUMN_COMMENT comment,GENERATION_EXPRESSION generationExpression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION')
      const result = tables.map(({ name, rows, rowsSha256, ddl }) => ({ name, rows, rowsSha256, ddl, columns: columns.filter(column => column.tableName === name) }))
      await connection.rollback(); return result
    } finally { connection.destroy() }
  }
  const mark = value => { stage = value; console.log(JSON.stringify({ stage })) }
  mark('freeze-source-ddl')
  await guard.query('SET SESSION lock_wait_timeout=10'); await guard.query('LOCK INSTANCE FOR BACKUP')
  const before = await observe('dev_vue'), sourceRows = await snapshot('dev_vue')
  const plan = await loadBridgeInstallationUpgrade(root)
  const toolPaths = ['scripts/backup-bridge-installation-dev-vue-local.mjs', 'scripts/lib/v4-backup-sql-scope-v3.mjs', 'scripts/lib/local-backup-stream.mjs', 'scripts/lib/local-backup-process.mjs', 'scripts/apply-bridge-installation-upgrade-local.mjs']
  const tools = { planHash: hash(plan.steps), files: await Promise.all(toolPaths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) }))) }
  const preparation = { kind: 'bridge-installation-backup-preparation/v1', tools, sourceSnapshotHash: hash(sourceRows) }
  preparation.manifestHash = hash(preparation)
  await privateJson(join(directory, 'preparation.json'), preparation)
  await privateJson(join(directory, 'source-snapshot.json'), sourceRows)
  await privateJson(join(directory, 'source-observation.json'), before)
  mark('encrypted-export')
  const encryptedPath = join(directory, 'source.sql.enc')
  const artifact = await runLocalBackupProcess({ command: binary('mysqldump.exe'), args: args(backupDumpArgs('dev_vue')),
    consume: stream => encryptLocalBackup(stream, encryptedPath, key) })
  await privateJson(join(directory, 'encrypted-artifact.json'), artifact)
  assert.deepEqual(await snapshot('dev_vue'), sourceRows)
  await guard.query('SELECT 1'); await guard.query('UNLOCK INSTANCE')
  mark('authenticate-and-review-sql')
  const raw = join(directory, 'verified-source.sql')
  await decryptLocalBackup(encryptedPath, raw, key, artifact); plaintext.push(raw)
  const review = await inspectBackupSql(createReadStream(raw), { tables: before.tables })
  await privateJson(join(directory, 'source-sql-review.json'), review)
  await privateDirectory(directory, 'Verify'); await privateDirectory(keys, 'Verify')
  mark('create-isolated-restore')
  await absent(guard)
  assert.equal(before.schemaFingerprint.charset, 'utf8mb4'); assert.equal(before.schemaFingerprint.collation, 'utf8mb4_general_ci')
  targetCreationAttempted = true
  await privateJson(join(directory, 'target-creation-attempt.json'), { target, uuid, atUtc: new Date().toISOString() })
  await guard.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  mark('restore')
  await runLocalBackupProcess({ command: binary('mysql.exe'), args: args(backupRestoreArgs(target)), input: createReadStream(raw), consume: discardLocalBackupOutput })
  mark('independent-restore-verification')
  const restored = await observe(target)
  const restoredRows = await snapshot(target)
  const metadataParity = verifyRiskRestoredSnapshot(sourceRows, restoredRows)
  await privateJson(join(directory, 'restored-snapshot.json'), restoredRows)
  const redumpEncrypted = join(directory, 'verification.sql.enc'), redumpRaw = join(directory, 'verified-redump.sql')
  const redump = await runLocalBackupProcess({ command: binary('mysqldump.exe'), args: args(backupDumpArgs(target)),
    consume: stream => encryptLocalBackup(stream, redumpEncrypted, key) })
  await decryptLocalBackup(redumpEncrypted, redumpRaw, key, redump); plaintext.push(redumpRaw)
  const restoredReview = await inspectBackupSql(createReadStream(redumpRaw), { tables: restored.tables })
  const parity = compareRestoredDump(review, restoredReview, restored)
  assert.deepEqual(await snapshot('dev_vue'), sourceRows)
  const receipt = { kind: 'bridge-installation-dev-vue-local-backup/v1', status: 'verified', observedAt: new Date().toISOString(),
    source: 'dev_vue', target, serverUuid: uuid, directory, keyDirectory: keys, preparationManifestHash: preparation.manifestHash,
    artifact, schemaSha256: restored.schemaFingerprint.sha256, tablesSha256: hash(sourceRows), parity, metadataParity,
    currentDevVueWrites: 0, sourceUnchanged: true, localExecution: true, sqlScopeReviewed: true, decryptionIntegrityVerified: true,
    restoredDatabaseRetained: true, currentDatabaseUpgraded: false }
  await privateJson(join(directory, 'receipt.json'), receipt)
  console.log(JSON.stringify(receipt))
} catch (error) {
  const cause = /^backup_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'unclassified'
  const failure = { failed: true, code: 'bridge_installation_local_backup_failed', cause, stage, targetCreationAttempted }
  if (directory) await privateJson(join(directory, 'failure.json'), failure).catch(() => {})
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally {
  if (guard) guard.destroy()
  for (const path of plaintext) await unlink(path).catch(() => { process.exitCode = 1 })
  if (configPath) await unlink(configPath).catch(() => { process.exitCode = 1 })
  if (key) key.fill(0)
}
