import { readFile, open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { hash, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { writeReferralOpenings } from './lib/mysql-referral-openings.mjs'
import { loadReferralLedgerCoordinator } from './lib/inplace-referral-ledger-schema.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'
import { readOriginalRows, validateColumnEvidence } from './lib/inplace-column-evidence.mjs'

const root = new URL('../', import.meta.url), database = 'dev_vue_m1_source_20260907_02'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let pool, control
try {
  check(process.platform === 'linux' && process.getuid() === 0 && process.argv.length === 2, 'opening_rehearsal_scope')
  const manifest = await json(new URL('../tools.json', root))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.startsWith('/') && !file.path.split('/').includes('..'), 'opening_tool_path')
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'opening_tool_changed')
  }
  const backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
  const columns = await json(new URL('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json', root))
  const run = await json(new URL('docs/migration/dev-vue-referral-backfill-run-20260907.json', root))
  validateColumnEvidence(backup, columns)
  check(run.spec.bindings.targetDatabase === database && run.spec.bindings.targetServerUuid === backup.serverUuid, 'opening_run_identity')
  const credential = await json(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', dateStrings: true, jsonStrings: true,
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
  try { prior = await json(new URL('../receipt.json', root)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  check(!prior || (prior.status === 'verified' && prior.runManifestHash === hash(run) && prior.balanceHash === balanceHash), 'opening_prior_changed')
  let inject = !prior, injected = false, insertions = 0
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
    check(Number(count.n) === 0, 'opening_initial_ledger_not_empty')
    try { await repository.transaction(tx => writeReferralOpenings(tx.connection, run)) }
    catch (error) { check(error.code === 'backfill_commit_unknown' && injected, 'opening_unexpected_failure') }
    check(injected && insertions === 25, 'opening_injection_missing')
    result = await repository.transaction(tx => writeReferralOpenings(tx.connection, run, { verifyOnly: true }))
  }
  const before = insertions
  const repeated = await repository.transaction(tx => writeReferralOpenings(tx.connection, run))
  check(insertions === before && repeated.inserted === 0 && repeated.existing === 25, 'opening_repeat_changed')
  await verifyOriginal()
  const report = { kind: 'referral-opening-rehearsal/v1', status: 'verified', identity, runManifestHash: hash(run), toolManifest: manifest,
    result, repeated, insertions, commitResponseLossInjected: injected, repeatInsertions: insertions - before,
    originalRows: backup.parity.rows, originalParityHash: sha256(JSON.stringify(columns.parity)), balanceHash,
    sourceDatabaseWritten: false, fullNormalizationComplete: false }
  const handle = await open(new URL(prior ? '../repeat-receipt.json' : '../receipt.json', root), 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  console.log(JSON.stringify({ status: 'verified', insertions, commitResponseLossInjected: injected, verifiedRows: result.existing, balanceUpdates: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^(?:opening|referral|backfill|inplace)_[a-z_]+$/.test(error.code ?? error.message) ? error.code ?? error.message : 'opening_rehearsal_failed' }))
  process.exitCode = 1
} finally { if (control) control.release(); if (pool) await pool.end() }
