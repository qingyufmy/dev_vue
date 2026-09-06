import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { requireBackup as check, verifyBackupArtifact } from './v4-backup-artifact.mjs'
import { inspectBackupDatabase } from './v4-backup-preflight.mjs'
import { inspectBackupSql } from './v4-backup-sql-scope.mjs'
import { checkCapacity, hashArtifact, privatePath, runBackupPipeline, writePrivateJson } from './v4-backup-io.mjs'

export function backupExecutionConfig({ runId, serverUuid, ddlWindowConfirmed }) {
  check(/^\d{8}-\d{2}$/.test(runId ?? '') && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(serverUuid ?? ''), 'backup_execution_scope_invalid')
  check(ddlWindowConfirmed === true, 'backup_ddl_window_required')
  return Object.freeze({ runId, serverUuid, source: 'dev_vue', target: `dev_vue_m1_source_${runId.replace('-', '_')}`,
    directory: `/www/backup/aurum-v4/m1/${runId}`, keyDirectory: `/root/.local/share/aurum-v4-backup-keys/m1-${runId}`,
    mysql: '/www/server/mysql/bin/mysql', dump: '/www/server/mysql/bin/mysqldump', gpg: '/usr/bin/gpg', gzip: '/usr/bin/gzip' })
}

export function backupDumpArgs(database) {
  check(database === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(database), 'backup_database_invalid')
  return ['--defaults-file=/proc/self/fd/3', '--no-login-paths', '--single-transaction', '--quick', '--hex-blob',
    '--default-character-set=utf8mb4', '--tz-utc', '--no-tablespaces', '--set-gtid-purged=OFF',
    '--routines', '--events', '--triggers', '--skip-lock-tables', '--skip-add-drop-table', '--skip-add-locks',
    '--skip-disable-keys', '--column-statistics=0', '--complete-insert', '--skip-extended-insert', '--order-by-primary', '--no-autocommit', database]
}

export function backupRestoreArgs(database) {
  check(/^dev_vue_m1_source_\d{8}_\d{2}$/.test(database), 'backup_restore_target_invalid')
  return ['--defaults-file=/proc/self/fd/3', '--no-login-paths', '--binary-mode', '--batch', '--skip-reconnect',
    '--local-infile=0', '--default-character-set=utf8mb4', '--max-allowed-packet=128M', `--database=${database}`]
}

export function backupGpgArgs(gpgHome, decrypt = false) {
  return ['--no-options', '--homedir', gpgHome, '--batch', '--no-tty', '--no-autostart',
    '--pinentry-mode', 'loopback', '--passphrase-fd', '3', '--no-symkey-cache',
    ...(decrypt ? ['--decrypt'] : ['--symmetric', '--cipher-algo', 'AES256', '--s2k-mode', '3',
      '--s2k-count', '65011712', '--s2k-digest-algo', 'SHA256', '--compress-algo', 'none'])]
}

export function compareRestoredDump(sourceReview, restoredReview, observation) {
  const expected = new Map(sourceReview.tables.map(table => [table.name, table]))
  check(restoredReview.tables.length === expected.size && observation.tables.length === expected.size, 'backup_restore_table_mismatch')
  const counts = new Map(observation.tables.map(table => [table.name, table.rowCount]))
  for (const table of restoredReview.tables) {
    const before = expected.get(table.name)
    check(before && before.rows === table.rows && before.dataSha256 === table.dataSha256
      && table.rows === counts.get(table.name), 'backup_restore_data_mismatch')
    expected.delete(table.name)
  }
  check(expected.size === 0, 'backup_restore_table_mismatch')
  return { tableCount: restoredReview.tables.length,
    rows: restoredReview.tables.reduce((total, table) => total + BigInt(table.rows), 0n).toString(),
    scope: 'ordered_complete_insert_values_and_exact_counts', matched: true }
}

// Intentionally no resume/overwrite/cleanup mode. A failed run is retained and requires a new decision.
export async function executeBackupRehearsal(config, { connect, mysqlDefaultsFd, progress = () => {} }) {
  const expectedConfig = backupExecutionConfig({ runId: config.runId, serverUuid: config.serverUuid, ddlWindowConfirmed: true })
  check(Object.keys(expectedConfig).every(key => config[key] === expectedConfig[key]), 'backup_execution_scope_invalid')
  check(process.platform === 'linux' && process.getuid() === 0, 'backup_execution_host_invalid')
  check(Number.isInteger(mysqlDefaultsFd) && mysqlDefaultsFd >= 3, 'backup_credential_fd_invalid')
  await privatePath(config.directory, { directory: true })
  await privatePath(config.keyDirectory, { directory: true })
  const artifactDirectory = `${config.directory}/artifacts`
  await mkdir(artifactDirectory, { mode: 0o700 })
  await privatePath(artifactDirectory, { directory: true })
  const file = name => `${artifactDirectory}/${name}`
  const capacityPaths = [artifactDirectory, config.keyDirectory, '/www/server/data']
  let stage = 'preflight', targetCreated = false, targetCreationAttempted = false, ddlGuard = null
  const mark = async name => { stage = name; progress({ stage, atUtc: new Date().toISOString() }) }
  const observe = async database => {
    const connection = await connect(database)
    try {
      return await inspectBackupDatabase(connection, { database, expectedServerUuid: config.serverUuid,
        role: database === config.source ? 'source' : 'restored-source', sourceDatabase: config.source,
        restoreDatabase: database === config.target ? config.target : undefined, timeoutMs: 180000 })
    } finally { connection.destroy() }
  }
  const absentTarget = async connection => {
    const [identity] = await connection.query('SELECT DATABASE() db, @@server_uuid uuid, VERSION() version')
    check(identity[0]?.db === config.source && identity[0]?.uuid === config.serverUuid && /^8\.4\./.test(identity[0]?.version), 'backup_instance_mismatch')
    const [rows] = await connection.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [config.target])
    check(rows.length === 0, 'backup_restore_target_exists')
  }
  const rawSql = file('restored.sql')
  const encrypted = file('source.sql.gz.gpg')
  const passphrase = `${config.keyDirectory}/passphrase`
  const gpgHome = `${config.keyDirectory}/gnupg`
  const run = (stages, options = {}) => runBackupPipeline(stages, { capacityPaths, ...options })
  const crypt = async (decrypt, input, output) => {
    await privatePath(passphrase)
    const handle = await open(passphrase, 'r')
    try {
      const args = backupGpgArgs(gpgHome, decrypt)
      return await run([{ command: config.gpg, args, secretFd: handle.fd }], { input, output })
    } finally { await handle.close() }
  }
  try {
    await checkCapacity(capacityPaths)
    const checkConnection = await connect(config.source)
    try { await absentTarget(checkConnection) } finally { checkConnection.destroy() }
    const versions = {}
    for (const name of ['mysql', 'dump', 'gpg', 'gzip']) {
      const result = await run([{ command: config[name], args: name === 'mysql' || name === 'dump'
        ? ['--no-defaults', '--no-login-paths', '--version'] : ['--version'] }], { maxBytes: 65536, timeoutMs: 10000 })
      versions[name] = result.output.toString('utf8').split('\n')[0]
    }
    check(/Ver 8\.4\.\d+/.test(versions.mysql) && /Ver 8\.4\.\d+/.test(versions.dump), 'backup_version_unsupported')
    check(versions.mysql.match(/Ver (8\.4\.\d+)/)[1] === versions.dump.match(/Ver (8\.4\.\d+)/)[1], 'backup_client_version_mismatch')
    // Keep DDL frozen through the export. Ordinary InnoDB DML remains available;
    // the dump owns its consistent snapshot, not these separate observations.
    ddlGuard = await connect(config.source)
    await ddlGuard.query('SET SESSION lock_wait_timeout = 10')
    await ddlGuard.query('LOCK INSTANCE FOR BACKUP')
    const sourceBefore = await observe(config.source)
    check(sourceBefore.mysqlVersion.split('-')[0] === versions.dump.match(/Ver (8\.4\.\d+)/)[1], 'backup_server_version_mismatch')
    await writePrivateJson(file('source-before.json'), sourceBefore)
    await writePrivateJson(file('execution-plan.json'), { ...config, versions, ddlWindowConfirmed: true, dumpArgs: backupDumpArgs(config.source), restoreArgs: backupRestoreArgs(config.target) })
    await mark('encryption-self-test')
    const key = await open(passphrase, 'wx', 0o600)
    try { await key.writeFile(`${randomBytes(48).toString('base64url')}\n`); await key.sync() } finally { await key.close() }
    await mkdir(gpgHome, { mode: 0o700 })
    const sample = Buffer.from('AURUM V4 backup integrity fixture\n\u0000中文\r\n', 'utf8')
    await crypt(false, Readable.from([sample]), file('self-test.gpg'))
    const decoded = await crypt(true, createReadStream(file('self-test.gpg')))
    check(decoded.output.equals(sample), 'backup_encryption_self_test_failed')
    // Corruption is tested only on the non-sensitive fixture. A bad exit must remain a failure.
    const sampleHandle = await open(file('self-test.gpg'), 'r')
    let corrupt
    try { corrupt = await sampleHandle.readFile() } finally { await sampleHandle.close() }
    corrupt[corrupt.length - 1] ^= 1
    let integrityRejected = false
    try { await crypt(true, Readable.from([corrupt])) }
    catch (error) { integrityRejected = error?.code === 'backup_process_failed' }
    check(integrityRejected, 'backup_encryption_integrity_not_enforced')
    await writePrivateJson(file('self-test.json'), { roundTrip: true, corruptedCiphertextRejected: true })
    await mark('encrypted-export')
    const passHandle = await open(passphrase, 'r')
    let exported
    try {
      exported = await run([
        { command: config.dump, args: backupDumpArgs(config.source), secretFd: mysqlDefaultsFd },
        { command: config.gzip, args: ['-c', '-n', '-6'] },
        { command: config.gpg, secretFd: passHandle.fd, args: backupGpgArgs(gpgHome) },
      ], { output: encrypted })
    } finally { await passHandle.close() }
    await writePrivateJson(file('export.json'), exported)
    await verifyBackupArtifact(encrypted, exported)
    const sourceAfter = await observe(config.source)
    await writePrivateJson(file('source-after.json'), sourceAfter)
    check(sourceBefore.schemaFingerprint.sha256 === sourceAfter.schemaFingerprint.sha256, 'backup_source_schema_changed')
    // A lost guard connection must fail instead of asserting a frozen schema.
    await ddlGuard.query('SELECT 1')
    await ddlGuard.query('UNLOCK INSTANCE')
    ddlGuard.destroy()
    ddlGuard = null
    await mark('decrypt-and-sql-review')
    await crypt(true, createReadStream(encrypted), file('decrypted.sql.gz'))
    const decompressed = await run([{ command: config.gzip, args: ['-d', '-c'] }], { input: createReadStream(file('decrypted.sql.gz')), output: rawSql })
    check(decompressed.sha256 === exported.stages[0].sha256 && decompressed.bytes === exported.stages[0].bytes, 'backup_plaintext_hash_mismatch')
    await verifyBackupArtifact(rawSql, decompressed)
    const review = await inspectBackupSql(createReadStream(rawSql), { tables: sourceBefore.tables })
    await writePrivateJson(file('source-sql-review.json'), review)
    await mark('create-and-restore-isolated-source')
    await checkCapacity(capacityPaths)
    // This second identity/absence gate runs immediately before the only CREATE DATABASE.
    const createConnection = await connect(config.source)
    try {
      await absentTarget(createConnection)
      check(sourceBefore.schemaFingerprint.charset === 'utf8mb4' && sourceBefore.schemaFingerprint.collation === 'utf8mb4_general_ci', 'backup_source_charset_changed')
      targetCreationAttempted = true
      await createConnection.query({ sql: `CREATE DATABASE \`${config.target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`, timeout: 60000 })
      targetCreated = true
    } finally { createConnection.destroy() }
    await writePrivateJson(file('target-created.json'), { target: config.target, serverUuid: config.serverUuid, createdAtUtc: new Date().toISOString() })
    await verifyBackupArtifact(rawSql, decompressed)
    await run([{ command: config.mysql, args: backupRestoreArgs(config.target), secretFd: mysqlDefaultsFd }],
      { input: createReadStream(rawSql), maxBytes: 65536 })
    await mark('restore-verification')
    const restored = await observe(config.target)
    await writePrivateJson(file('restored-observation.json'), restored)
    check(restored.schemaFingerprint.sha256 === sourceBefore.schemaFingerprint.sha256, 'backup_restore_schema_mismatch')
    const redumpPath = file('verification-redump.sql')
    const redump = await run([{ command: config.dump, args: backupDumpArgs(config.target), secretFd: mysqlDefaultsFd }], { output: redumpPath })
    await verifyBackupArtifact(redumpPath, redump)
    const restoredReview = await inspectBackupSql(createReadStream(redumpPath), { tables: restored.tables })
    await writePrivateJson(file('restored-sql-review.json'), restoredReview)
    const parity = compareRestoredDump(review, restoredReview, restored)
    const receipt = { version: 1, kind: 'v4_backup_restore_receipt', status: 'verified', completedAtUtc: new Date().toISOString(),
      source: config.source, target: config.target, serverUuid: config.serverUuid,
      sourceSnapshotId: `sha256:${decompressed.sha256}`, encrypted: await hashArtifact(encrypted), rawSql: await hashArtifact(rawSql),
      schemaSha256: restored.schemaFingerprint.sha256, parity, decryptionIntegrityVerified: true, sqlScopeReviewed: true,
      businessMigrationComplete: false, offHostBackupVerified: false, abModified: false, terminalContacted: false }
    await writePrivateJson(file('receipt.json'), receipt)
    await mark('complete')
    return receipt
  } catch (error) {
    const code = typeof error?.code === 'string' && /^backup_[a-z0-9_]+$/.test(error.code) ? error.code : 'backup_execution_failed'
    await writePrivateJson(file('failure.json'), { status: 'failed', stage, code, targetCreated, targetCreationAttempted,
      targetMayExist: targetCreationAttempted, target: config.target,
      atUtc: new Date().toISOString(), preserved: true }).catch(() => {})
    throw error
  } finally { if (ddlGuard) ddlGuard.destroy() }
}
