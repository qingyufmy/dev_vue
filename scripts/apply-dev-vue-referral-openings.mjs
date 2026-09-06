import mysql from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { parse } from 'dotenv'
import { verifyReferralOpeningProof } from './lib/referral-opening-proof.mjs'
import { readFile, open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { hash, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { writeReferralOpenings } from './lib/mysql-referral-openings.mjs'
import { loadReferralLedgerCoordinator } from './lib/inplace-referral-ledger-schema.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'
import { readOriginalRows, validateColumnEvidence } from './lib/inplace-column-evidence.mjs'

const root = new URL('../', import.meta.url), database = 'dev_vue'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let pool, control
try {
  check(process.argv.length === 3 && process.argv[2] === '--apply', 'opening_apply_scope')
  const backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
  const columns = await json(new URL('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json', root))
  const run = await json(new URL('docs/migration/dev-vue-referral-apply-run-20260907.json', root))
  const rehearsalRun = await json(new URL('docs/migration/dev-vue-referral-backfill-run-20260907.json', root))
  const proof = await verifyReferralOpeningProof(root,
    await json(new URL('docs/migration/dev-vue-referral-openings-rehearsal-20260907.json', root)),
    await json(new URL('docs/migration/dev-vue-referral-openings-repeat-20260907.json', root)), rehearsalRun, backup, columns)
  validateColumnEvidence(backup, columns)
  check(run.spec.bindings.targetDatabase === database && run.spec.bindings.targetServerUuid === backup.serverUuid, 'opening_run_identity')
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === database, 'opening_apply_database')
  pool = mysql.createPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database, timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3, multipleStatements: false })
  control = await pool.getConnection()
  const [[identity]] = await control.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === backup.serverUuid, 'opening_target_identity')
  await control.query("SET SESSION time_zone='+00:00'")
  const [[claim]] = await control.execute('SELECT GET_LOCK(?,0) acquired', [`aurum:inplace:${database}`])
  check(Number(claim.acquired) === 1, 'opening_upgrade_busy')
  const plan = await loadReferralLedgerCoordinator(root)
  const readBalances = async () => {
    const [rows] = await control.query('SELECT user_id,referral_code,referred_by_code,referral_credit,revision,updated_at_utc FROM user_referral_accounts ORDER BY user_id')
    check(rows.length === 25, 'opening_balance_count'); return sha256(JSON.stringify(rows))
  }
  const balanceHash = await readBalances()
  const verifyOriginal = async () => {
    await verifyOriginalSchemaWithUserDefaults(control, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
    check(JSON.stringify(await readOriginalRows(control, columns.originalColumns)) === JSON.stringify(columns.parity), 'opening_original_changed')
    check(await readBalances() === balanceHash, 'opening_balances_changed')
  }
  await verifyOriginal()
  let prior
  try { prior = await json(new URL('docs/migration/dev-vue-referral-openings-apply-20260907.json', root)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  check(!prior || (prior.status === 'verified' && prior.runManifestHash === hash(run) && prior.balanceHash === balanceHash), 'opening_prior_changed')
  let inject = false, injected = false, insertions = 0
  const repository = new MysqlBackfillRepository({ async getConnection() {
    const c = await pool.getConnection()
    return { query: (...args) => c.query(...args), beginTransaction: () => c.beginTransaction(), rollback: () => c.rollback(),
      destroy: () => c.destroy(), release: () => c.release(), async execute(sql, values) {
        if (/^(INSERT|UPDATE|DELETE)\b/.test(sql)) check(sql.startsWith('INSERT INTO referral_credit_ledger '), 'opening_unexpected_mutation')
        const result = await c.execute(sql, values)
        if (/^(INSERT|UPDATE|DELETE)\b/.test(sql)) {
          check(sql.startsWith('INSERT INTO referral_credit_ledger '), 'opening_unexpected_mutation'); insertions++
        }
        return result
      }, async commit() {
        await c.commit()
        if (inject) { inject = false; injected = true; c.destroy(); throw new Error('injected_commit_loss') }
      } }
  } })
  let result
  if (prior) result = await repository.transaction(tx => writeReferralOpenings(tx.connection, run, { verifyOnly: true }))
  else {
    const [[count]] = await control.query('SELECT COUNT(*) n FROM referral_credit_ledger')
    // A lost local receipt never authorizes a second write. Existing rows must all verify.
    if (Number(count.n) === 0) {
      try { await repository.transaction(tx => writeReferralOpenings(tx.connection, run)) }
      catch (error) { check(error.code === 'backfill_commit_unknown', 'opening_unexpected_failure') }
      check(insertions === 25, 'opening_insert_count')
    }
    result = await repository.transaction(tx => writeReferralOpenings(tx.connection, run, { verifyOnly: true }))
  }
  const before = insertions
  const repeated = await repository.transaction(tx => writeReferralOpenings(tx.connection, run))
  check(insertions === before && repeated.inserted === 0 && repeated.existing === 25, 'opening_repeat_changed')
  await verifyOriginal()
  const report = { kind: 'referral-opening-apply/v1', status: 'verified', identity, runManifestHash: hash(run), proof,
    result, repeated, insertions, commitResponseLossInjected: injected, repeatInsertions: insertions - before,
    originalRows: backup.parity.rows, originalParityHash: sha256(JSON.stringify(columns.parity)), balanceHash,
    sourceDatabaseWritten: true, fullNormalizationComplete: false }
  const receiptPath = prior ? `docs/migration/dev-vue-referral-openings-apply-repeat-${randomUUID()}.json` : 'docs/migration/dev-vue-referral-openings-apply-20260907.json'
  const handle = await open(new URL(receiptPath, root), 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  console.log(JSON.stringify({ status: 'verified', insertions, commitResponseLossInjected: injected, verifiedRows: result.existing, balanceUpdates: 0, receiptPath }))
} catch (error) {
  console.error(JSON.stringify({ code: /^(?:opening|referral|backfill|inplace)_[a-z_]+$/.test(error.code ?? error.message) ? error.code ?? error.message : 'opening_rehearsal_failed' }))
  process.exitCode = 1
} finally { if (control) control.release(); if (pool) await pool.end() }
