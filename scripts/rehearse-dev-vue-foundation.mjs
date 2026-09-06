import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadFoundationSteps, executeFoundationSteps, withTableInspection, foundationNames } from './lib/inplace-foundation-upgrade.mjs'
import { readOriginalRows, verifyOriginalSchema, validateColumnEvidence } from './lib/inplace-column-evidence.mjs'

const check = (value, code) => { if (!value) throw new Error(code) }
let connection
try {
  const [base, output, mode] = process.argv.slice(2)
  const resume = mode === '--resume-after-definition-check'
  const verifyCompleted = mode === '--verify-completed'
  check((process.argv.length === 4 || (process.argv.length === 5 && (resume || verifyCompleted))) && process.platform === 'linux' && process.getuid() === 0, 'inplace_foundation_arguments')
  const backup = JSON.parse(await readFile(`${base}/artifacts/receipt.json`, 'utf8'))
  const columns = JSON.parse(await readFile(`${base}/column-rehearsal/receipt.json`, 'utf8'))
  validateColumnEvidence(backup, columns)
  const steps = await loadFoundationSteps(new URL('../', import.meta.url))
  const fd = Number(process.env.V4_BACKUP_CREDENTIAL_FD)
  check(Number.isInteger(fd) && fd >= 3, 'inplace_credential_fd_invalid')
  const credential = JSON.parse(await readFile(`/proc/self/fd/${fd}`, 'utf8'))
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  const connect = async () => {
    const c = await mysql.createConnection({ ...credential, database: backup.target, timezone: 'Z', dateStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, multipleStatements: false, connectTimeout: 10000 })
    try {
      const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
      check(identity.db === backup.target && identity.uuid === backup.serverUuid, 'inplace_instance_mismatch')
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('SET SESSION autocommit=1')
      await c.query('SET SESSION lock_wait_timeout=10')
      check(await verifyInplaceJournal(c), 'inplace_journal_missing')
      return c
    } catch (error) { c.destroy(); throw error }
  }
  connection = await connect()
  if (resume || verifyCompleted) {
    const planned = await executeFoundationSteps(withTableInspection(connection, mysqlColumnStore(connection, true)), steps)
    check(verifyCompleted ? planned.steps.every(step => step.status === 'completed') : planned.steps[0].status === 'reconcile' && planned.steps.slice(1).every(step => step.status === 'pending'), 'inplace_recovery_state_invalid')
  }
  await verifyOriginalSchema(connection, backup.schemaSha256, resume || verifyCompleted ? foundationNames : [])
  const before = await readOriginalRows(connection, columns.originalColumns)
  check(JSON.stringify(before) === JSON.stringify(columns.parity), 'inplace_source_changed_since_backup')
  let executed = verifyCompleted ? steps.length : resume ? 1 : 0
  if (!resume && !verifyCompleted) await withInplaceUpgradeLock(connection, backup.target, async () => {
    const store = withTableInspection(connection, mysqlColumnStore(connection, true))
    const planned = await executeFoundationSteps(store, steps)
    check(planned.steps.every(step => step.status === 'pending'), 'inplace_rehearsal_already_started')
    store.execute = async sql => {
      await connection.query(sql)
      executed++
      connection.destroy()
      throw new Error('inplace_injected_response_loss')
    }
    await executeFoundationSteps(store, steps, { apply: true })
  }).catch(error => { if (error.message !== 'inplace_injected_response_loss') throw error })
  check(executed === (verifyCompleted ? steps.length : 1), 'inplace_fault_not_exercised')
  connection.destroy()
  connection = await connect()
  const recovery = await withInplaceUpgradeLock(connection, backup.target, async () => {
    const store = withTableInspection(connection, mysqlColumnStore(connection, true))
    const execute = store.execute
    store.execute = async sql => { await execute(sql); executed++ }
    const recovered = await executeFoundationSteps(store, steps, { apply: true })
    check(recovered.steps[0].status === (verifyCompleted ? 'completed' : 'reconciled'), 'inplace_recovery_not_reconciled')
    const repeated = await executeFoundationSteps(store, steps, { apply: true })
    check(repeated.steps.every(step => step.status === 'completed') && executed === steps.length, 'inplace_replay_not_idempotent')
    return recovered
  })
  await verifyOriginalSchema(connection, backup.schemaSha256, foundationNames)
  const after = await readOriginalRows(connection, columns.originalColumns)
  check(JSON.stringify(before) === JSON.stringify(after), 'inplace_original_data_changed')
  for (const name of foundationNames) {
    const [[count]] = await connection.query(`SELECT COUNT(*) n FROM \`${name}\``)
    check(String(count.n) === '0', 'inplace_unexpected_seed_rows')
  }
  const report = { version: 1, kind: 'dev_vue_foundation_rehearsal', status: 'verified', target: backup.target,
    serverUuid: backup.serverUuid, backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(),
    stepChecksums: steps.map(({ id, checksum, expectedHash }) => ({ id, checksum, expectedHash })),
    recovery, ddlExecutions: executed, repeatNoop: true, originalTablesVerified: after.length,
    originalRowsVerified: after.reduce((total, table) => total + BigInt(table.rows), 0n).toString(),
    resumedAfterDefinitionCheck: resume, verificationOfCompletedRun: verifyCompleted,
    ddlExecutionsThisVerification: verifyCompleted ? 0 : null,
    noBusinessRowsSeeded: true, sourceModified: false, fullNormalizationComplete: false }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: /^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_foundation_rehearsal_failed' }))
  process.exitCode = 1
} finally { if (connection) connection.destroy() }
