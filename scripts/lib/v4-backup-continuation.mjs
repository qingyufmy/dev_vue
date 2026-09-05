import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { requireBackup as check, verifyBackupArtifact } from './v4-backup-artifact.mjs'
import { backupExecutionConfig, backupDumpArgs, backupRestoreArgs, backupGpgArgs, compareRestoredDump } from './v4-backup-executor.mjs'
import { checkCapacity, hashArtifact, privatePath, runBackupPipeline, writePrivateJson } from './v4-backup-io.mjs'
import { inspectBackupDatabase } from './v4-backup-preflight.mjs'
import { inspectBackupSql } from './v4-backup-sql-scope.mjs'

// This is an explicitly approved continuation of one frozen run, not a generic retry switch.
export const retainedBackup = Object.freeze({
  runId: '20260905-01', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104',
  encrypted: Object.freeze({ bytes: '177649476', sha256: 'efc9a6c2d2871e86427e05d79972c845d20b25f2a08552468a2e6d55a0f390ad' }),
  rawSql: Object.freeze({ bytes: '682966225', sha256: 'af5ed95821a392b62acc24779a3c802dba8d60fb32e713fead5ed25c7817e08c' }),
  schemaSha256: 'a5031597b419f41ae21ae2cf6cd1cf80616db601473079c0c8a2a542ad3e3e36',
  files: Object.freeze({
    'source-before.json': '057c21fdc6663d133f141dcfd4cd109572a6e2e0b6908eba825139913b185cd3',
    'source-after.json': 'e69b328bc21765f07770f76d03f4be4854ecb2441d0eeb89f0994cee92bf880b',
    'export.json': '0dff49150f8fabd7f7faa9318fd376fcbcd884d13c0c15b2dd1246c54a96f1ac',
    'failure.json': 'a9bd3c649372f0f16643f3e19b82a8618e6c15e7a03b7cd631dded878ddacc01',
  }),
})

export function backupContinuationConfig({ runId, serverUuid, newTargetConfirmed }) {
  check(runId === retainedBackup.runId && serverUuid === retainedBackup.serverUuid && newTargetConfirmed === true,
    'backup_continuation_scope_invalid')
  const config = backupExecutionConfig({ runId, serverUuid, ddlWindowConfirmed: true })
  return Object.freeze({ ...config, continuationDirectory: `${config.directory}/continuation-01` })
}

export function validateRetainedMetadata(before, after, exported, failure, config) {
  for (const observation of [before, after]) {
    check(observation.kind === 'v4_backup_database_observation' && observation.database === config.source
      && observation.serverUuid === config.serverUuid && observation.mysqlVersion === '8.4.8'
      && observation.schemaFingerprint?.sha256 === retainedBackup.schemaSha256
      && observation.schemaFingerprint.charset === 'utf8mb4' && observation.schemaFingerprint.collation === 'utf8mb4_general_ci'
      && observation.tables?.length === 165, 'backup_retained_metadata_invalid')
  }
  check(exported.bytes === retainedBackup.encrypted.bytes && exported.sha256 === retainedBackup.encrypted.sha256
    && exported.stages?.[0]?.bytes === retainedBackup.rawSql.bytes && exported.stages[0].sha256 === retainedBackup.rawSql.sha256,
  'backup_retained_export_mismatch')
  check(failure.status === 'failed' && failure.code === 'backup_sql_function_forbidden'
    && failure.stage === 'decrypt-and-sql-review' && failure.target === config.target
    && failure.targetCreated === false && failure.targetCreationAttempted === false && failure.targetMayExist === false,
  'backup_continuation_previous_write_uncertain')
}

export async function assertContinuationTargetAbsent(connection, config) {
  const [identity] = await connection.query({ sql: 'SELECT DATABASE() db, @@server_uuid uuid, VERSION() version', timeout: 10000 })
  check(identity.length === 1 && identity[0].db === config.source && identity[0].uuid === config.serverUuid
    && identity[0].version.split('-')[0] === '8.4.8', 'backup_instance_mismatch')
  const [rows] = await connection.query({ sql: 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
    values: [config.target], timeout: 10000 })
  check(rows.length === 0, 'backup_restore_target_exists')
}

export async function continueBackupRestore(config, { connect, mysqlDefaultsFd, progress = () => {} }) {
  const expected = backupContinuationConfig({ runId: config.runId, serverUuid: config.serverUuid, newTargetConfirmed: true })
  check(Object.keys(expected).every(key => config[key] === expected[key]), 'backup_continuation_scope_invalid')
  check(process.platform === 'linux' && process.getuid() === 0, 'backup_execution_host_invalid')
  check(Number.isInteger(mysqlDefaultsFd) && mysqlDefaultsFd >= 3, 'backup_credential_fd_invalid')
  for (const directory of [config.directory, config.keyDirectory, config.continuationDirectory, `${config.directory}/artifacts`]) {
    await privatePath(directory, { directory: true })
  }
  const directory = `${config.continuationDirectory}/artifacts`
  await mkdir(directory, { mode: 0o700 }) // EEXIST is a stop, even if an earlier attempt did not create a database.
  await privatePath(directory, { directory: true })
  const file = name => `${directory}/${name}`
  const oldFile = name => `${config.directory}/artifacts/${name}`
  const capacityPaths = [directory, config.keyDirectory, '/www/server/data']
  const run = (stages, options = {}) => runBackupPipeline(stages, { capacityPaths, ...options })
  let stage = 'retained-backup-preflight', targetCreationAttempted = false, targetCreated = false
  const mark = name => { stage = name; progress({ stage, atUtc: new Date().toISOString() }) }
  try {
    mark(stage)
    await checkCapacity(capacityPaths)
    const records = {}
    for (const [name, sha256] of Object.entries(retainedBackup.files)) {
      await privatePath(oldFile(name))
      check((await stat(oldFile(name))).size <= 2 * 1024 ** 2, 'backup_retained_metadata_too_large')
      check((await hashArtifact(oldFile(name))).sha256 === sha256, 'backup_retained_metadata_changed')
      records[name] = JSON.parse(await readFile(oldFile(name), 'utf8'))
    }
    const before = records['source-before.json']
    validateRetainedMetadata(before, records['source-after.json'], records['export.json'], records['failure.json'], config)
    for (const [name, digest] of [['source.sql.gz.gpg', retainedBackup.encrypted], ['restored.sql', retainedBackup.rawSql]]) {
      await privatePath(oldFile(name)); await verifyBackupArtifact(oldFile(name), digest)
    }
    const checkConnection = await connect(config.source)
    try { await assertContinuationTargetAbsent(checkConnection, config) } finally { checkConnection.destroy() }
    for (const name of ['mysql', 'dump']) {
      const version = await run([{ command: config[name], args: ['--no-defaults', '--no-login-paths', '--version'] }], { maxBytes: 65536, timeoutMs: 10000 })
      check(/Ver 8\.4\.8\b/.test(version.output.toString('utf8')), 'backup_client_version_mismatch')
    }
    await writePrivateJson(file('continuation-plan.json'), { ...config, retainedBackup, sourceExportedAgain: false,
      oldArtifactsImmutable: true, restoreArgs: backupRestoreArgs(config.target) })
    mark('fresh-decryption-and-frozen-sql-review')
    const gpgHome = `${directory}/gnupg`
    await mkdir(gpgHome, { mode: 0o700 })
    const passphrase = `${config.keyDirectory}/passphrase`
    await privatePath(passphrase)
    const key = await open(passphrase, 'r')
    try {
      await run([{ command: config.gpg, args: backupGpgArgs(gpgHome, true), secretFd: key.fd }],
        { input: createReadStream(oldFile('source.sql.gz.gpg')), output: file('decrypted.sql.gz') })
    } finally { await key.close() }
    const rawSql = file('source.sql')
    const decoded = await run([{ command: config.gzip, args: ['-d', '-c'] }], { input: createReadStream(file('decrypted.sql.gz')), output: rawSql })
    check(decoded.bytes === retainedBackup.rawSql.bytes && decoded.sha256 === retainedBackup.rawSql.sha256, 'backup_plaintext_hash_mismatch')
    await verifyBackupArtifact(rawSql, retainedBackup.rawSql)
    const review = await inspectBackupSql(createReadStream(rawSql), { tables: before.tables })
    await writePrivateJson(file('source-sql-review.json'), review)
    mark('create-and-restore-isolated-source')
    await checkCapacity(capacityPaths)
    await verifyBackupArtifact(rawSql, retainedBackup.rawSql)
    const createConnection = await connect(config.source)
    try {
      await assertContinuationTargetAbsent(createConnection, config)
      targetCreationAttempted = true
      await createConnection.query({ sql: `CREATE DATABASE \`${config.target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`, timeout: 60000 })
      targetCreated = true
    } finally { createConnection.destroy() }
    await writePrivateJson(file('target-created.json'), { target: config.target, serverUuid: config.serverUuid, createdAtUtc: new Date().toISOString() })
    await run([{ command: config.mysql, args: backupRestoreArgs(config.target), secretFd: mysqlDefaultsFd }],
      { input: createReadStream(rawSql), maxBytes: 65536 })
    mark('restore-verification')
    const connection = await connect(config.target)
    let restored
    try {
      restored = await inspectBackupDatabase(connection, { database: config.target, expectedServerUuid: config.serverUuid,
        role: 'restored-source', sourceDatabase: config.source, restoreDatabase: config.target, timeoutMs: 180000 })
    } finally { connection.destroy() }
    await writePrivateJson(file('restored-observation.json'), restored)
    check(restored.schemaFingerprint.sha256 === retainedBackup.schemaSha256, 'backup_restore_schema_mismatch')
    const redumpFile = file('verification-redump.sql')
    const redump = await run([{ command: config.dump, args: backupDumpArgs(config.target), secretFd: mysqlDefaultsFd }], { output: redumpFile })
    await verifyBackupArtifact(redumpFile, redump)
    const restoredReview = await inspectBackupSql(createReadStream(redumpFile), { tables: restored.tables })
    await writePrivateJson(file('restored-sql-review.json'), restoredReview)
    const parity = compareRestoredDump(review, restoredReview, restored)
    // Check the retained evidence again, without rewriting its original failure or receipt files.
    for (const [name, sha256] of Object.entries(retainedBackup.files)) {
      check((await hashArtifact(oldFile(name))).sha256 === sha256, 'backup_retained_metadata_changed')
    }
    await verifyBackupArtifact(oldFile('source.sql.gz.gpg'), retainedBackup.encrypted)
    await verifyBackupArtifact(oldFile('restored.sql'), retainedBackup.rawSql)
    const receipt = { version: 1, kind: 'v4_backup_restore_receipt', status: 'verified', completedAtUtc: new Date().toISOString(),
      source: config.source, target: config.target, serverUuid: config.serverUuid, sourceSnapshotId: `sha256:${retainedBackup.rawSql.sha256}`,
      encrypted: retainedBackup.encrypted, rawSql: retainedBackup.rawSql, schemaSha256: restored.schemaFingerprint.sha256,
      parity, decryptionIntegrityVerified: true, sqlScopeReviewed: true, sourceExportedAgain: false, oldArtifactsPreserved: true,
      businessMigrationComplete: false, offHostBackupVerified: false, abModified: false, terminalContacted: false }
    await writePrivateJson(file('receipt.json'), receipt)
    mark('complete')
    return receipt
  } catch (error) {
    const code = typeof error?.code === 'string' && /^backup_[a-z0-9_]+$/.test(error.code) ? error.code : 'backup_continuation_failed'
    await writePrivateJson(file('failure.json'), { status: 'failed', stage, code, targetCreated, targetCreationAttempted,
      targetMayExist: targetCreationAttempted, target: config.target, atUtc: new Date().toISOString(), preserved: true }).catch(() => {})
    throw error
  }
}
