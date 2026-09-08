import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAccountRegistration, createTransactionTradingReader } from '../server/dist-v4/modules/trading/composition.js'
import { createActivePrincipalAccess, createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'

// The durable intent identifies both accounts even if COMMIT acknowledgement is lost.
// --verify never retries a write. Keep the intent outside the repository with the private user fixture.
const [fixturePath, intentPath, destination, mode] = process.argv.slice(2)
assert.ok(process.argv.length === 6 && ['--create', '--verify'].includes(mode))
assert.ok([fixturePath, intentPath, destination].every(value => isAbsolute(value)))
assert.equal(new Set([fixturePath, intentPath, destination].map(value => resolve(value).toLowerCase())).size, 3)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1')
assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0)
const output = await open(destination, 'wx', 0o600)
let pool, connection, intent, identity, phase = 'intent', commitState = 'not_attempted'
const accounts = [], checks = []
try {
  if (mode === '--create') {
    intent = { kind: 'local-owned-accounts-intent/v1', userId: fixture.userId, db: 'dev_vue',
      brokerServer: `V4-LOCAL-${randomUUID()}`, logins: ['900000001', '900000002'],
      createdAt: new Date().toISOString(), purpose: 'Synthetic offline account switching; no terminal or trade facts' }
    const handle = await open(intentPath, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(intent, null, 2) + '\n'); await handle.sync() }
    finally { await handle.close() }
  } else intent = JSON.parse(await readFile(intentPath, 'utf8'))
  assert.equal(intent.kind, 'local-owned-accounts-intent/v1')
  assert.equal(intent.userId, fixture.userId); assert.equal(intent.db, 'dev_vue')
  assert.match(intent.brokerServer, /^V4-LOCAL-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  assert.deepEqual(intent.logins, ['900000001', '900000002'])
  phase = 'identity'
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.31.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  ;[[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.beginTransaction()
  const [users] = await connection.execute("SELECT id FROM users WHERE id=? AND email=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [fixture.userId, fixture.email])
  assert.equal(users.length, 1)
  checks.push('exact-synthetic-user-and-development-database')
  const registration = createAccountRegistration(connection, createActivePrincipalAccess(connection))
  phase = 'account-registration'
  if (mode === '--create') {
    const [owners] = await connection.execute('SELECT trading_account_id FROM trading_account_ownerships WHERE user_id=? AND revoked_at_utc IS NULL LIMIT 1', [fixture.userId])
    assert.equal(owners.length, 0)
    const [[clock]] = await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%d %H:%i:%s.%f') registeredAt")
    for (const login of intent.logins) {
      const input = { platform: 'mt5', brokerServer: intent.brokerServer, login }
      assert.equal(await registration.lockAccount(input), null)
      const result = await registration.createAccount({ ...input, currency: 'USD', registeredAt: clock.registeredAt })
      assert.equal(result.ok, true)
      assert.equal((await registration.grantFirstOwnership({ userId: fixture.userId, accountId: result.accountId, registeredAt: clock.registeredAt })).ok, true)
    }
  }
  for (const login of intent.logins) {
    const account = await registration.lockAccount({ platform: 'mt5', brokerServer: intent.brokerServer, login })
    assert.ok(account); assert.equal(account.currency, 'USD')
    assert.equal(await registration.lockCurrentOwnership({ userId: fixture.userId, accountId: account.id }), '1')
    accounts.push({ accountId: account.id, login })
  }
  checks.push('two-accounts-have-current-ownership-and-matching-history-intervals')
  const reader = createTransactionTradingReader(connection, createAccountPrincipalReader)
  const visible = await reader.listAccounts(fixture.userId)
  assert.deepEqual(visible.map(account => account.id).sort(), accounts.map(account => account.accountId).sort())
  for (const account of visible) {
    assert.equal(account.tradePermission, false); assert.equal(account.bridgeState, 'offline')
    assert.equal(account.terminalProfileId, null); assert.equal(account.terminalInstanceId, null)
  }
  assert.deepEqual(await reader.listTerminalProfiles(fixture.userId), [])
  checks.push('public-account-reader-lists-both-offline-accounts-without-trading-permission')
  if (mode === '--create') {
    phase = 'commit'; commitState = 'attempted'
    await connection.commit(); commitState = 'confirmed'
  } else await connection.rollback()
  await output.writeFile(JSON.stringify({ kind: 'local-owned-accounts-provision/v1', observedAt: new Date().toISOString(),
    passed: true, mode, identity, checks, commitState, accounts,
    retained: 'Two synthetic accounts, ownership grants and history intervals. Private durable intent retained for exact identification; no rows deleted.',
    scope: 'Real dev_vue constraints and compiled registration/read capabilities. No terminal profiles, snapshots, positions, commands or observer channels created. Not HTTP/browser switching proof.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, mode, checks: checks.length, commitState, accounts }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, phase, commitState, accounts, code: 'local_owned_accounts_failed',
    errorCode: typeof error.code === 'string' && /^(ER_|ERR_ASSERTION)/.test(error.code) ? error.code : undefined,
    recovery: 'Keep the private durable intent. Use --verify with a new report to resolve database state; do not replay an uncertain creation or delete evidence.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: false, phase, commitState })); process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
