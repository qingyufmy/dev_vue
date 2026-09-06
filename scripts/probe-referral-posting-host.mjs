import { readFile, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { postReferralCreditInTransaction } from './posting/infrastructure/mysql-referral-credit.js'

const userId = 777001, runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
const key = 'd'.repeat(64), source = 'e'.repeat(64)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let pool, control, fixtureCreated = false
try {
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credential = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  pool = mysql.createPool({ ...credential, database: 'dev_vue_m1_a', timezone: 'Z', dateStrings: true, connectionLimit: 4 })
  control = await pool.getConnection()
  const [[identity]] = await control.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'posting_probe_identity')
  const [[claim]] = await control.query("SELECT GET_LOCK('aurum:referral-posting-probe',0) acquired")
  check(Number(claim.acquired) === 1, 'posting_probe_busy')
  const [[user]] = await control.execute('SELECT COUNT(*) n FROM users WHERE id=?', [userId])
  const [[run]] = await control.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [runId])
  check(Number(user.n) === 0 && Number(run.n) === 0, 'posting_probe_fixture_exists')
  await control.beginTransaction()
  await control.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-posting-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId])
  await control.execute("INSERT INTO user_referral_accounts (user_id,referral_credit,updated_at_utc) VALUES (?,'80',UTC_TIMESTAMP(3))", [userId])
  await control.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, source])
  await control.execute("INSERT INTO referral_credit_ledger (user_id,account_revision,event_kind,source_key,resulting_balance,migration_run_id,source_sha256,recorded_at_utc) VALUES (?,1,'opening',?,'80',?,?,UTC_TIMESTAMP(3))", [userId, key, runId, source])
  await control.commit(); fixtureCreated = true
  const transaction = async work => {
    const connection = await pool.getConnection()
    try { await connection.query("SET SESSION time_zone='+00:00'"); await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
    catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
  const debit = { userId, expectedRevision: '1', kind: 'order_debit', sourceKey: key, sourceSha256: source, amount: '29' }
  let releaseFirst, firstLocked
  const gate = new Promise(resolve => { releaseFirst = resolve })
  const locked = new Promise(resolve => { firstLocked = resolve })
  const first = transaction(async c => {
    const result = await postReferralCreditInTransaction(c, debit)
    firstLocked(); await gate; return result
  })
  await Promise.race([locked, first])
  let secondStarted
  const secondReady = new Promise(resolve => { secondStarted = resolve })
  const second = transaction(async c => { secondStarted(); return postReferralCreditInTransaction(c, debit) })
  try { await Promise.race([secondReady, second]) } finally { releaseFirst() }
  const concurrent = await Promise.all([first, second])
  check(concurrent.filter(r => r.applied).length === 1 && concurrent.every(r => r.eventRevision === '2' && r.eventBalance === '51.00000000'), 'posting_probe_duplicate_failed')
  const snapshot = async () => {
    const [[balance]] = await control.execute('SELECT referral_credit balance,CAST(revision AS CHAR) revision FROM user_referral_accounts WHERE user_id=?', [userId])
    const [ledger] = await control.execute('SELECT account_revision,event_kind,source_key,previous_balance,delta,resulting_balance FROM referral_credit_ledger WHERE user_id=? ORDER BY account_revision', [userId])
    return { balance: { ...balance }, ledger: ledger.map(row => ({ ...row })) }
  }
  const beforeFailure = await snapshot()
  let injected = false
  try {
    await transaction(c => postReferralCreditInTransaction({ execute: async (sql, values) => {
      if (sql.startsWith('UPDATE user_referral_accounts')) { injected = true; throw new Error('injected_before_balance_update') }
      return c.execute(sql, values)
    } }, { ...debit, expectedRevision: '2', sourceKey: 'f'.repeat(64), amount: '1' }))
  } catch (error) { check(error.message === 'injected_before_balance_update', 'posting_probe_unexpected_failure') }
  check(injected && JSON.stringify(await snapshot()) === JSON.stringify(beforeFailure), 'posting_probe_rollback_failed')
  const released = await transaction(c => postReferralCreditInTransaction(c, { ...debit, expectedRevision: '2', kind: 'order_release' }))
  check(released.applied && released.eventBalance === '80.00000000' && released.eventRevision === '3', 'posting_probe_release_failed')
  const finalState = await snapshot()
  check(finalState.ledger.length === 3 && finalState.balance.balance === '80.00000000', 'posting_probe_final_state')
  await control.beginTransaction()
  await control.execute('DELETE FROM referral_credit_ledger WHERE user_id=?', [userId])
  await control.execute('DELETE FROM user_referral_accounts WHERE user_id=?', [userId])
  await control.execute('DELETE FROM users WHERE id=?', [userId])
  await control.execute('DELETE FROM data_migration_runs WHERE id=?', [runId])
  await control.commit(); fixtureCreated = false
  const [[remaining]] = await control.execute('SELECT (SELECT COUNT(*) FROM users WHERE id=?)+(SELECT COUNT(*) FROM referral_credit_ledger WHERE user_id=?)+(SELECT COUNT(*) FROM user_referral_accounts WHERE user_id=?)+(SELECT COUNT(*) FROM data_migration_runs WHERE id=?) n', [userId, userId, userId, runId])
  check(Number(remaining.n) === 0, 'posting_probe_cleanup_failed')
  const tools = []
  for (const name of ['probe-referral-posting-host.mjs', 'posting/infrastructure/mysql-referral-credit.js', 'posting/domain/referral-credit.js']) {
    tools.push({ name, sha256: createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex') })
  }
  const report = { kind: 'referral-posting-probe/v1', identity, concurrent, rollbackVerified: true, released,
    finalBalanceBeforeCleanup: finalState.balance, ledgerRowsBeforeCleanup: finalState.ledger.length, fixtureRowsRemaining: 0,
    tools, sourceDatabaseWritten: false }
  const file = await open(new URL('receipt.json', import.meta.url), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', concurrentApplied: 1, rollbackVerified: true, fixtureRowsRemaining: 0 }))
} catch (error) {
  await control?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^posting_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'posting_probe_failed', fixtureCreated })); process.exitCode = 1
} finally { control?.release(); await pool?.end() }
