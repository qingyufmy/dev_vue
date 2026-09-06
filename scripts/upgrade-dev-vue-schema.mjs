import { loadReferralSchemaCoordinator } from './lib/inplace-referral-schema.mjs'
import { verifyReferralSchemaProof } from './lib/inplace-referral-schema-proof.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'
import { verifyUserDefaultsProof } from './lib/inplace-user-defaults-proof.mjs'
import { verifyMacroCoordinatorProof } from './lib/inplace-macro-coordinator-proof.mjs'
import { readFile, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyCoordinatorProof } from './lib/inplace-coordinator-proof.mjs'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, readOriginalRows } from './lib/inplace-column-evidence.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection, receipt
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--plan', '--apply'].includes(mode), 'inplace_coordinator_arguments')
  const apply = mode === '--apply'
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const plan = await loadReferralSchemaCoordinator(root)
  const baseProof = await verifyCoordinatorProof(root, await json('docs/migration/dev-vue-schema-coordinator-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 29) })
  const macroProof = await verifyMacroCoordinatorProof(root, await json('docs/migration/dev-vue-macro-schema-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 40) })
  const defaultsProof = await verifyUserDefaultsProof(root, await json('docs/migration/dev-vue-user-defaults-rehearsal-20260907.json'), backup, columns, { steps: plan.steps.slice(0, 45) })
  const referralProof = await verifyReferralSchemaProof(root, await json('docs/migration/dev-vue-referral-schema-rehearsal-20260907.json'), backup, columns, plan)
  const proof = { base: baseProof, macro: macroProof, userDefaults: defaultsProof, referral: referralProof }
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'inplace_coordinator_database')
  // Reserve an exclusive receipt before any database mutation. Failed attempts remain inspectable.
  const receiptPath = `docs/migration/dev-vue-schema-upgrade-${randomUUID()}.json`
  if (apply) receipt = await open(new URL(receiptPath, root), 'wx', 0o600)
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'inplace_coordinator_instance')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION lock_wait_timeout=10')
  let ddlExecutions = 0, journalWrites = 0
  const result = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    check(await verifyInplaceJournal(connection), 'inplace_coordinator_journal_required')
    const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
    const verifyOriginal = async () => {
      await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, excluded)
      check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(columns.parity), 'inplace_coordinator_original_changed')
    }
    const store = plan.store(connection)
    for (const method of ['execute', 'begin', 'complete']) {
      const original = store[method]
      store[method] = async (...args) => {
        check(apply, 'inplace_coordinator_read_only')
        await original(...args)
        if (method === 'execute') ddlExecutions++; else journalWrites++
      }
    }
    await verifyOriginal()
    const preview = await coordinateInplaceSchema(store, plan)
    if (!apply) return preview
    const applied = await coordinateInplaceSchema(store, plan, { apply: true })
    const repeated = await coordinateInplaceSchema(store, plan, { apply: true })
    check(repeated.steps.every(row => row.status === 'completed'), 'inplace_coordinator_repeat_failed')
    await verifyOriginal()
    return applied
  })
  const report = { kind: 'dev-vue-schema-upgrade/v4', status: apply ? 'verified' : 'planned', identity, proof,
    completedAtUtc: new Date().toISOString(), result, ddlExecutions, journalWrites, originalTables: columns.parity.length,
    originalRows: backup.parity.rows, originalParityHash: sha256(JSON.stringify(columns.parity)),
    repeatNoop: apply, businessRowsWritten: false, fullNormalizationComplete: false }
  if (receipt) { await receipt.writeFile(JSON.stringify(report, null, 2) + '\n'); await receipt.sync() }
  console.log(JSON.stringify({ ...report, ...(apply ? { receiptPath } : {}) }))
} catch (error) {
  const failure = { status: 'failed', code: /^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_coordinator_upgrade_failed' }
  if (receipt) await receipt.writeFile(JSON.stringify(failure) + '\n').catch(() => {})
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { await receipt?.close(); if (connection) await connection.end().catch(() => {}) }
