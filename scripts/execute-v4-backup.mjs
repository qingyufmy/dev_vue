#!/usr/bin/env node
import { fstatSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import { backupExecutionConfig, executeBackupRehearsal } from './lib/v4-backup-executor.mjs'
import { requireBackup as check } from './lib/v4-backup-artifact.mjs'

try {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === 'help') {
    process.stdout.write('execute --run-id=YYYYMMDD-NN --server-uuid=UUID --confirm-no-source-ddl\nLinux host only. Explicit approval of paths and new database is required. No resume or cleanup.\n')
  } else {
    check(args.length === 4 && args[0] === 'execute' && args[3] === '--confirm-no-source-ddl', 'backup_execution_arguments_invalid')
    check(args[1].startsWith('--run-id=') && args[2].startsWith('--server-uuid='), 'backup_execution_arguments_invalid')
    const config = backupExecutionConfig({ runId: args[1].slice(9), serverUuid: args[2].slice(14), ddlWindowConfirmed: true })
    check(process.platform === 'linux' && process.getuid() === 0, 'backup_execution_host_invalid')
    const credentialFd = Number(process.env.V4_BACKUP_CREDENTIAL_FD)
    const defaultsFd = Number(process.env.V4_BACKUP_MYSQL_DEFAULTS_FD)
    check(Number.isInteger(credentialFd) && credentialFd >= 3 && Number.isInteger(defaultsFd) && defaultsFd >= 3 && credentialFd !== defaultsFd, 'backup_credential_fd_invalid')
    for (const fd of [credentialFd, defaultsFd]) {
      const info = fstatSync(fd)
      check(info.isFile() && info.nlink === 0 && info.size > 0 && info.size <= 16384 && (info.mode & 0o777) === 0o600, 'backup_credential_fd_invalid')
    }
    const credential = JSON.parse(readFileSync(credentialFd, 'utf8'))
    check(typeof credential.password === 'string' && credential.password.length > 0 && typeof credential.user === 'string'
      && /^[a-zA-Z0-9_]+$/.test(credential.user) && credential.socketPath === '/tmp/mysql.sock', 'backup_credential_invalid')
    const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`
    const expectedDefaults = `[client]\nuser=${quote(credential.user)}\npassword=${quote(credential.password)}\nprotocol=SOCKET\nsocket=${quote(credential.socketPath)}\n`
    check(readFileSync(`/proc/self/fd/${defaultsFd}`, 'utf8') === expectedDefaults, 'backup_client_credentials_mismatch')
    const modulePath = process.env.V4_BACKUP_MYSQL2_MODULE
    check(typeof modulePath === 'string' && isAbsolute(modulePath) && modulePath.endsWith('/mysql2/promise.js'), 'backup_driver_path_invalid')
    const { default: mysql } = await import(pathToFileURL(modulePath).href)
    const connect = database => mysql.createConnection({ ...credential, database, multipleStatements: false,
      connectTimeout: 10000, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true })
    const receipt = await executeBackupRehearsal(config, { connect, mysqlDefaultsFd: defaultsFd,
      progress: value => process.stdout.write(`${JSON.stringify(value)}\n`) })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^backup_[a-z0-9_]+$/.test(error.code) ? error.code : 'backup_execution_failed'
  process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
  process.exitCode = 1
}
