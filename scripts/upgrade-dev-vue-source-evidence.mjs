import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadFoundationSteps, foundationNames } from './lib/inplace-foundation-upgrade.mjs'
import { loadAccountBuildSteps, accountBuildNames } from './lib/inplace-account-build.mjs'
import { validateColumnEvidence, readOriginalRows, verifyOriginalSchema } from './lib/inplace-column-evidence.mjs'

import { loadSourceEvidenceStep, executeSourceEvidence, inspectSourceEvidence, sourceEvidenceTable } from './lib/inplace-source-evidence-upgrade.mjs'

const root = new URL('../', import.meta.url)
const check = (value, code) => { if (!value) throw new Error(code) }
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const files = ['scripts/upgrade-dev-vue-source-evidence.mjs', 'scripts/lib/inplace-source-evidence-upgrade.mjs', 'scripts/lib/inplace-account-build.mjs', 'scripts/lib/inplace-foundation-upgrade.mjs',
  'scripts/lib/dev-vue-column-upgrade.mjs', 'scripts/lib/mysql-inplace-column-store.mjs', 'scripts/lib/inplace-column-evidence.mjs',
  'scripts/lib/v4-migration-plan.mjs', 'server/db/migrations/inplace/004_account_build_tables.sql', 'server/db/migrations/inplace/005_source_row_evidence.sql']
let connection
try {
  const [mode, base, output] = process.argv.slice(2), rehearsal = mode === '--rehearse', apply = mode !== '--plan'
  check(rehearsal ? process.argv.length === 5 && process.platform === 'linux' && process.getuid() === 0
    : process.argv.length === 3 && ['--plan', '--apply'].includes(mode), 'inplace_account_build_arguments')
  const backup = await json(rehearsal ? `${base}/artifacts/receipt.json` : new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
  const columns = await json(rehearsal ? `${base}/column-rehearsal/receipt.json` : new URL('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json', root))
  validateColumnEvidence(backup, columns)
  const foundation = await loadFoundationSteps(root), build = await loadAccountBuildSteps(root)
  const evidence = await loadSourceEvidenceStep(root)
  const stepChecksums = [evidence].map(({ id, checksum, expectedHash }) => ({ id, checksum, expectedHash }))
  const sourceFiles = await Promise.all(files.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
  if (apply && !rehearsal) {
    const proof = await json(new URL('docs/migration/dev-vue-source-evidence-rehearsal-20260906.json', root))
    check(proof.kind === 'dev_vue_source_evidence_rehearsal' && proof.status === 'verified' && proof.database === backup.target
      && proof.serverUuid === backup.serverUuid && proof.backupSnapshotId === backup.sourceSnapshotId && proof.repeatNoop === true
      && JSON.stringify(proof.stepChecksums) === JSON.stringify(stepChecksums)
      && JSON.stringify(proof.sourceFiles) === JSON.stringify(sourceFiles), 'inplace_account_build_evidence_invalid')
  }
  const database = rehearsal ? backup.target : 'dev_vue'
  let config, mysql
  if (rehearsal) {
    const fd = Number(process.env.V4_BACKUP_CREDENTIAL_FD)
    check(Number.isInteger(fd) && fd >= 3, 'inplace_credential_fd_invalid')
    config = await json(`/proc/self/fd/${fd}`)
    ;({ default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href))
  } else {
    const { parse } = await import('dotenv')
    const env = parse(await readFile(new URL('server/.env', root)))
    check(env.MYSQL_DATABASE === database, 'inplace_database_mismatch')
    config = { host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD }
    ;({ default: mysql } = await import('mysql2/promise'))
  }
  const connect = async () => {
    const c = await mysql.createConnection({ ...config, database, timezone: 'Z', dateStrings: true, jsonStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
    try {
      const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
      check(identity.db === database && identity.uuid === backup.serverUuid, 'inplace_instance_mismatch')
      await c.query("SET SESSION time_zone='+00:00'")
      await c.query('SET SESSION autocommit=1')
      await c.query('SET SESSION lock_wait_timeout=10')
      check(await verifyInplaceJournal(c), 'inplace_foundation_required')
      return c
    } catch (error) { c.destroy(); throw error }
  }
  connection = await connect()
  let before, result, ddlExecutions = 0
  const run = async (inject = false) => withInplaceUpgradeLock(connection, database, async () => {
    const store = inspectSourceEvidence(connection, mysqlColumnStore(connection, true))
    const planned = await executeSourceEvidence(store, foundation, build, evidence)
    for (const step of [evidence]) for (const match of step.sql.matchAll(/CONSTRAINT `([a-z][a-z0-9_]*)`/g)) {
      const [rows] = await connection.execute('SELECT TABLE_NAME name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME=?', [match[1]])
      check(rows.every(row => row.name === step.table), 'inplace_constraint_name_conflict')
    }
    if (!apply) return planned
    await verifyOriginalSchema(connection, backup.schemaSha256, [...foundationNames, ...accountBuildNames, sourceEvidenceTable])
    const original = await readOriginalRows(connection, columns.originalColumns)
    check(JSON.stringify(original) === JSON.stringify(columns.parity), 'inplace_source_changed_since_backup')
    before = original
    if (inject) check(planned.steps.slice(-1).every(step => step.status === 'pending'), 'inplace_rehearsal_already_started')
    const execute = store.execute
    store.execute = async sql => {
      await execute(sql); ddlExecutions++
      if (inject) { connection.destroy(); throw new Error('inplace_injected_response_loss') }
    }
    const applied = await executeSourceEvidence(store, foundation, build, evidence, { apply: true })
    const repeated = await executeSourceEvidence(store, foundation, build, evidence, { apply: true })
    check(repeated.steps.every(step => step.status === 'completed'), 'inplace_repeat_not_completed')
    await verifyOriginalSchema(connection, backup.schemaSha256, [...foundationNames, ...accountBuildNames, sourceEvidenceTable])
    const after = await readOriginalRows(connection, columns.originalColumns)
    check(JSON.stringify(before) === JSON.stringify(after), 'inplace_original_data_changed')
    for (const name of [...accountBuildNames, sourceEvidenceTable]) {
      const [[count]] = await connection.query(`SELECT COUNT(*) n FROM \`${name}\``)
      check(String(count.n) === '0', 'inplace_unexpected_seed_rows')
    }
    return applied
  })
  if (rehearsal) {
    await run(true).catch(error => { if (error.message !== 'inplace_injected_response_loss') throw error })
    check(ddlExecutions === 1, 'inplace_fault_not_exercised')
    connection = await connect()
  }
  result = await run()
  if (rehearsal) check(result.steps.at(-1).status === 'reconciled' && ddlExecutions === 1, 'inplace_recovery_not_reconciled')
  const report = { kind: rehearsal ? 'dev_vue_source_evidence_rehearsal' : 'dev_vue_source_evidence_upgrade', status: apply ? 'verified' : 'planned',
    database, serverUuid: backup.serverUuid, backupSnapshotId: backup.sourceSnapshotId, completedAtUtc: new Date().toISOString(),
    result, stepChecksums, sourceFiles, ddlExecutions, repeatNoop: apply, originalTablesVerified: before?.length ?? null,
    originalRowsVerified: before?.reduce((total, table) => total + BigInt(table.rows), 0n).toString() ?? null,
    sourceRenamed: false, noBusinessRowsSeeded: true, fullNormalizationComplete: false }
  if (rehearsal) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_account_build_failed') }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
