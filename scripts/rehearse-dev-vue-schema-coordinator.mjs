import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loadInplaceSchemaCoordinator, coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, readOriginalRows, verifyOriginalSchema } from './lib/inplace-column-evidence.mjs'
import { sha256, splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { hashArtifact, runBackupPipeline, writePrivateJson, checkCapacity } from './lib/v4-backup-io.mjs'
import { backupRestoreArgs } from './lib/v4-backup-executor.mjs'

const root = new URL('../', import.meta.url)
const base = '/www/backup/aurum-v4/m1/20260906-01'
const database = 'dev_vue_m1_source_20260907_02'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const check = (value, code) => { if (!value) throw new Error(code) }
let connection
try {
  check(process.platform === 'linux' && process.getuid() === 0 && process.argv.length === 2, 'inplace_coordinator_arguments')
  const backup = await json(`${base}/artifacts/receipt.json`), columns = await json(`${base}/column-rehearsal/receipt.json`)
  validateColumnEvidence(backup, columns)
  check(backup.serverUuid === 'ac423207-6ef3-11f1-b302-000c29fda104'
    && backup.rawSql.sha256 === '9eebdd97aebf89b94c186bfbeda19dc7c028e672d3b27fae1ee4cf45e162bbee', 'inplace_coordinator_backup')
  const manifest = await json(new URL('../tools.json', root))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'inplace_coordinator_tool_path')
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'inplace_coordinator_tool_changed')
  }
  const plan = await loadInplaceSchemaCoordinator(root)
  const rawSql = `${base}/artifacts/restored.sql`
  check(JSON.stringify(await hashArtifact(rawSql)) === JSON.stringify(backup.rawSql), 'inplace_coordinator_backup_changed')
  // Exact bytes already passed the restricted SQL-scope parser in the backup receipt.
  const fd = Number(process.env.V4_BACKUP_CREDENTIAL_FD), defaultsFd = Number(process.env.V4_BACKUP_MYSQL_DEFAULTS_FD)
  check(Number.isInteger(fd) && fd >= 3 && Number.isInteger(defaultsFd) && defaultsFd >= 3, 'inplace_coordinator_credential')
  const credential = await json(`/proc/self/fd/${fd}`)
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  const connect = async (db = database) => {
    const c = await mysql.createConnection({ ...credential, database: db, timezone: 'Z', dateStrings: true, jsonStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
    try {
      const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
      check(identity.db === db && identity.uuid === backup.serverUuid, 'inplace_coordinator_instance')
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('SET SESSION lock_wait_timeout=10')
      return c
    } catch (error) { c.destroy(); throw error }
  }
  connection = await connect('information_schema')
  const [exists] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [database])
  check(exists.length === 0, 'inplace_coordinator_target_exists')
  await checkCapacity(['/www/server/data', base])
  await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  await connection.end(); connection = null
  console.log(JSON.stringify({ stage: 'restoring', database }))
  await runBackupPipeline([{ command: '/www/server/mysql/bin/mysql', args: backupRestoreArgs(database), secretFd: defaultsFd }],
    { input: createReadStream(rawSql), maxBytes: 65536, capacityPaths: ['/www/server/data', base] })
  connection = await connect()
  const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
  const verifyOriginal = async () => {
    await verifyOriginalSchema(connection, backup.schemaSha256, excluded)
    check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(columns.parity), 'inplace_coordinator_original_changed')
  }
  await verifyOriginal()
  check(!await verifyInplaceJournal(connection), 'inplace_coordinator_journal_exists')
  const journal = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/001_upgrade_journal.sql', root), 'utf8'))
  check(journal.length === 1, 'inplace_coordinator_journal_sql')
  await withInplaceUpgradeLock(connection, database, async () => {
    await connection.query(journal[0])
    check(await verifyInplaceJournal(connection), 'inplace_coordinator_journal_invalid')
  })
  console.log(JSON.stringify({ stage: 'restored-parity-verified', database }))
  const faults = [], recoveries = []
  let ddlExecutions = 0
  const run = inject => withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'inplace_coordinator_journal_invalid')
    await verifyOriginal()
    const store = plan.store(connection), execute = store.execute
    const preview = await coordinateInplaceSchema(store, plan)
    recoveries.push(...preview.steps.filter(row => row.status === 'reconcile').map(row => row.id))
    store.execute = async sql => {
      await execute(sql); ddlExecutions++
      if (sql === inject?.sql) {
        faults.push(inject.id); connection.destroy()
        throw new Error('inplace_coordinator_injected_loss')
      }
    }
    return coordinateInplaceSchema(store, plan, { apply: true })
  })
  for (const index of [0, 9, 18, 22, 25, 28]) {
    const step = plan.steps[index]
    try { await run(step) } catch (error) { if (error.message !== 'inplace_coordinator_injected_loss') throw error }
    check(faults.at(-1) === step.id, 'inplace_coordinator_fault_missing')
    console.log(JSON.stringify({ stage: 'injected-and-reconnecting', step: step.id }))
    connection = await connect()
  }
  const completed = await run(null), repeated = await run(null)
  check(ddlExecutions === 29 && completed.structureComplete && repeated.steps.every(row => row.status === 'completed')
    && JSON.stringify(faults) === JSON.stringify(recoveries), 'inplace_coordinator_recovery_failed')
  await verifyOriginal()
  const report = { kind: 'inplace-schema-coordinator-rehearsal/v1', status: 'verified', database, serverUuid: backup.serverUuid,
    backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(), journalCreates: 1, ddlExecutions, faults, recoveries,
    completed, repeated, steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })), toolManifest: manifest,
    originalTables: columns.parity.length, originalRows: backup.parity.rows, originalParityHash: sha256(JSON.stringify(columns.parity)),
    repeatNoop: true, sourceDatabaseWritten: false, fullNormalizationComplete: false }
  await writePrivateJson(new URL('../receipt.json', root).pathname, report)
  console.log(JSON.stringify({ status: 'verified', database, ddlExecutions, recoveryCount: recoveries.length, originalRows: report.originalRows }))
} catch (error) {
  console.error(JSON.stringify({ code: /^inplace_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'inplace_coordinator_rehearsal_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
