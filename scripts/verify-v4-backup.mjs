#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { open, lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { BackupArtifactError, buildBackupDumpPlan, requireBackup as check, verifyBackupArtifact } from './lib/v4-backup-artifact.mjs'
import { compareBackupObservations } from './lib/v4-backup-observation.mjs'
import { BackupPreflightError, inspectBackupDatabase } from './lib/v4-backup-preflight.mjs'

let connection
try {
  const [command, ...rawArgs] = process.argv.slice(2)
  const specs = {
    help: [], 'inspect-source': [], 'inspect-restored': [],
    'dump-plan': ['mysql-version', 'dump-version'],
    'verify-artifact': ['file', 'sha256', 'bytes'],
    'compare-observations': ['baseline', 'baseline-sha256', 'actual', 'actual-sha256'],
  }
  check(Object.hasOwn(specs, command ?? ''), 'backup_command_invalid')
  const args = new Map()
  for (const arg of rawArgs) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(arg)
    check(match && specs[command].includes(match[1]) && !args.has(match[1]), 'backup_argument_invalid')
    args.set(match[1], match[2])
  }
  check(args.size === specs[command].length, 'backup_argument_required')
  let result
  if (command === 'help') {
    result = { commands: specs, writesDatabase: false, exportsData: false, executesSqlFiles: false,
      note: 'Inspection requires separate authorization. No .env loading, export, decrypt, create, restore or cleanup command exists.' }
  } else if (command === 'dump-plan') {
    result = buildBackupDumpPlan({ sourceDatabase: 'dev_vue', mysqlVersion: args.get('mysql-version'), dumpVersion: args.get('dump-version') })
  } else if (command === 'verify-artifact') {
    result = await verifyBackupArtifact(args.get('file'), { sha256: args.get('sha256'), bytes: args.get('bytes') })
  } else if (command === 'compare-observations') {
    const baseline = await readObservation(args.get('baseline'), args.get('baseline-sha256'))
    const actual = await readObservation(args.get('actual'), args.get('actual-sha256'))
    result = compareBackupObservations(baseline, actual)
    if (result.status !== 'match') process.exitCode = 1
  } else {
    const database = required('V4_BACKUP_DATABASE')
    const role = command === 'inspect-source' ? 'source' : 'restored-source'
    check(role === 'source' ? database === 'dev_vue' : /^dev_vue_m1_source_\d{8}_\d{2}$/.test(database), 'backup_database_invalid')
    const expectedServerUuid = required('V4_BACKUP_SERVER_UUID')
    check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expectedServerUuid), 'backup_instance_invalid')
    // Run on the database host through approved SSH, never send credentials over a fallback TCP link.
    const socketPath = required('V4_BACKUP_SOCKET_PATH')
    check(process.platform !== 'win32' && isAbsolute(socketPath) && !socketPath.includes('\0'), 'backup_socket_invalid')
    const user = required('V4_BACKUP_USER')
    const { default: mysql } = await import('mysql2/promise')
    connection = await mysql.createConnection({ socketPath, user, password: process.env.V4_BACKUP_PASSWORD ?? '', database,
      multipleStatements: false, connectTimeout: 10000, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true })
    result = await inspectBackupDatabase(connection, { database, expectedServerUuid, role, sourceDatabase: 'dev_vue',
      restoreDatabase: role === 'restored-source' ? database : undefined })
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const known = error instanceof BackupArtifactError || error instanceof BackupPreflightError
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: known ? error.code : 'backup_cli_failed' })}\n`)
  process.exitCode = 1
} finally {
  if (connection) {
    let timer
    try {
      await Promise.race([connection.end().catch(() => undefined), new Promise(resolve => {
        timer = setTimeout(() => { connection.destroy(); resolve() }, 1000)
      })])
    } finally { clearTimeout(timer) }
  }
}

function required(key) {
  const value = process.env[key]
  check(typeof value === 'string' && value.length > 0, 'backup_environment_required')
  return value
}

async function readObservation(file, sha256) {
  check(typeof file === 'string' && isAbsolute(file), 'backup_path_invalid')
  let handle
  try {
    const size = (await lstat(file, { bigint: true })).size
    await verifyBackupArtifact(file, { sha256, bytes: size.toString() }, { maxBytes: 8 * 1024 * 1024 })
    handle = await open(file, 'r')
    // Fixed allocation and a second content hash prevent a changed file being trusted after verification.
    const buffer = Buffer.alloc(Number(size))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      check(bytesRead > 0, 'backup_artifact_changed')
      offset += bytesRead
    }
    check((await handle.stat({ bigint: true })).size === size, 'backup_artifact_changed')
    check(createHash('sha256').update(buffer).digest('hex') === sha256, 'backup_artifact_hash_mismatch')
    return JSON.parse(buffer.toString('utf8'))
  } finally { await handle?.close() }
}
