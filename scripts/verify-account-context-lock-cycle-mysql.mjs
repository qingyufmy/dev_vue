import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createActivePrincipalAccess, createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'
import { createAccountRegistration } from '../server/dist-v4/modules/trading/composition.js'
import { MysqlContextCommands } from '../server/dist-v4/modules/trading/infrastructure/mysql-context-commands.js'
import { prepareMysqlContextTarget } from '../server/dist-v4/modules/trading/infrastructure/mysql-context-target.js'

const [fixturePath, ownedPath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 5 && [fixturePath, ownedPath, destination].every(isAbsolute))
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const owned = JSON.parse(await readFile(ownedPath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1')
assert.equal(owned.kind, 'local-owned-accounts-intent/v1')
assert.equal(owned.userId, fixture.userId)
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.match(owned.brokerServer, /^V4-LOCAL-[a-f0-9-]{36}$/)
const output = await open(destination, 'wx', 0o600)
let pool, a, b, phase = 'identity'
const driverErrors = [], checkpoints = []
let contextAttempts = 0, blockedWrites = 0
function guard(connection, label) {
  return new Proxy(connection, { get(target, key) {
    if (key === 'release') return () => {}
    if (key === 'commit') return async () => { throw Error('probe_commit_forbidden') }
    if (key === 'execute') return async (sql, params) => {
      // Real application reads and locks only; stop the survivor before any write.
      if (!/^\s*SELECT\b/i.test(sql)) { blockedWrites++; throw Error('probe_write_forbidden') }
      try { return await target.execute(sql, params) }
      catch (error) { driverErrors.push({ connection: label, code: error.code }); throw error }
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.31.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  a = await pool.getConnection(); b = await pool.getConnection()
  const [[identity]] = await a.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@innodb_deadlock_detect deadlockDetection')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(Number(identity.deadlockDetection), 1)
  const [users] = await a.execute("SELECT id FROM users WHERE id=? AND email=? AND deletion_status='active' AND deleted_at IS NULL", [fixture.userId, fixture.email])
  assert.equal(users.length, 1)
  const sql = `SELECT CAST(a.id AS CHAR) id,a.platform,a.account_login login,CAST(a.ownership_revision AS CHAR) revision,
    o.interval_id,CAST(o.revision AS CHAR) grantRevision,o.revoked_at_utc,oi.ended_at_utc
    FROM trading_accounts a JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.role='owner'
    JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id
    WHERE a.broker_server=? AND a.account_login=? AND o.user_id=? AND oi.origin_kind='runtime'`
  const params = [owned.brokerServer, owned.logins[0], fixture.userId]
  const [before] = await a.execute(sql, params)
  assert.equal(before.length, 1)
  const account = before[0]
  assert.equal(account.revoked_at_utc, null); assert.equal(account.ended_at_utc, null)
  assert.equal(account.revision, account.grantRevision)
  const contextSql = 'SELECT mode,CAST(trading_account_id AS CHAR) accountId,revision FROM trading_contexts WHERE user_id=?'
  const [contextBefore] = await a.execute(contextSql, [fixture.userId])
  assert.equal(contextBefore.length, 1)
  await a.query('SET SESSION innodb_lock_wait_timeout=3')
  await b.query('SET SESSION innodb_lock_wait_timeout=3')
  const command = { userId: fixture.userId, requestId: randomUUID(), action: 'select_account',
    targetId: account.id, expectedRevision: Number(contextBefore[0].revision) }
  const ga = guard(a, 'context'), gb = guard(b, 'registration')
  // Preparation is advisory and uses the already-held connection; it does not write.
  const target = await prepareMysqlContextTarget(ga, { async current() { return null } }, command, createAccountPrincipalReader)
  let targetReached, resumeTarget
  const reached = new Promise(resolve => { targetReached = resolve })
  const resume = new Promise(resolve => { resumeTarget = resolve })
  const commands = new MysqlContextCommands({ async getConnection() { contextAttempts++; return ga } }, async (...args) => {
    checkpoints.push('context-holds-user-and-context'); targetReached(); await resume
    return target(...args)
  }, createActivePrincipalAccess)
  phase = 'cycle'
  // Either a target barrier or early completion wakes setup: no unbounded barrier wait.
  const contextRun = commands.execute(command).then(() => ({ completed: true }), error => ({ error: error.code ?? error.message }))
  const entry = await Promise.race([reached.then(() => 'target'), contextRun.then(() => 'early-exit')])
  assert.equal(entry, 'target')
  let registrationRun
  try {
    await b.beginTransaction()
    const registration = createAccountRegistration(gb, createActivePrincipalAccess(gb))
    assert.equal((await registration.lockAccount({ platform: account.platform, brokerServer: owned.brokerServer, login: account.login })).id, account.id)
    checkpoints.push('registration-holds-account')
    resumeTarget()
    registrationRun = registration.lockCurrentOwnership({ userId: fixture.userId, accountId: account.id })
      .then(revision => ({ revision }), error => ({ error: error.code ?? error.message }))
      .finally(() => b.rollback())
  } catch (error) {
    await b.rollback(); resumeTarget(); await contextRun; throw error
  }
  const outcomes = await Promise.all([contextRun, registrationRun])
  assert.equal(driverErrors.filter(error => error.code === 'ER_LOCK_DEADLOCK').length, 1)
  assert.ok(!driverErrors.some(error => error.code === 'ER_LOCK_WAIT_TIMEOUT'))
  // Require the intended victim so this run proves recovery, not merely another cycle.
  assert.equal(driverErrors[0].connection, 'context')
  assert.equal(contextAttempts, 2)
  assert.equal(blockedWrites, 1)
  await a.rollback(); await b.rollback()
  phase = 'preservation'
  assert.deepEqual((await a.execute(sql, params))[0], before)
  assert.deepEqual((await a.execute(contextSql, [fixture.userId]))[0], contextBefore)
  const [[receipt]] = await a.execute('SELECT COUNT(*) n FROM trading_context_changes_v4 WHERE user_id=? AND request_id=?', [fixture.userId, command.requestId])
  assert.equal(Number(receipt.n), 0)
  await output.writeFile(JSON.stringify({ kind: 'account-context-lock-cycle-mysql/v2', passed: true,
    observedAt: new Date().toISOString(), identity, checkpoints, driverErrors, outcomes, contextAttempts, blockedWrites,
    checks: ['actual-context-command-user-lock', 'actual-account-registration-lock', 'mysql-detected-cycle',
      'no-lock-timeout', 'ownership-and-context-preserved', 'no-command-receipt', 'deadlock-victim-restarts-and-reaches-write-guard'],
    committedMutations: 0,
    scope: 'Current compiled context target and account registration on exact synthetic identity. SELECT locks only; guard blocks every application write/commit. Proves the context victim restarts and reaches its write boundary; does not prove a successful real commit or a repaired global lock order.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, driverErrors, committedMutations: 0 }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, phase, code: 'account_lock_cycle_probe_failed', driverErrors, checkpoints }) + '\n')
  process.exitCode = 1
} finally {
  for (const connection of [a, b]) if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool?.end(); await output.sync(); await output.close()
}
