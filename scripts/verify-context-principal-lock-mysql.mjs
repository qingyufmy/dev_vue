import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createActivePrincipalAccess } from '../server/dist-v4/modules/auth/composition.js'
import { MysqlContextCommands } from '../server/dist-v4/modules/trading/infrastructure/mysql-context-commands.js'

const [fixturePath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && isAbsolute(fixturePath) && isAbsolute(destination) && fixturePath !== destination)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1')
assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0)
const output = await open(destination, 'wx', 0o600)
let pool, reader, updater, phase = 'identity', passed = false
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  reader = await pool.getConnection(); updater = await pool.getConnection()
  const [[identity]] = await reader.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone,CONNECTION_ID() connectionId')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  const [[other]] = await updater.query('SELECT CONNECTION_ID() connectionId')
  assert.notEqual(identity.connectionId, other.connectionId)
  const [users] = await reader.execute("SELECT id FROM users WHERE id=? AND email=? AND deletion_status='active' AND deleted_at IS NULL", [fixture.userId, fixture.email])
  assert.equal(users.length, 1)
  await updater.query('SET SESSION innodb_lock_wait_timeout=1')
  let timeoutObserved = false, receiptRead = false, rolledBack = false
  const adapter = new Proxy(reader, { get(target, key) {
    if (key === 'release') return () => {}
    if (key === 'rollback') return async () => { await target.rollback(); rolledBack = true }
    if (key === 'execute') return async (sql, params) => {
      if (sql.includes('FROM trading_context_changes_v4')) {
        phase = 'contending-update'
        await updater.beginTransaction()
        try {
          // No-op on the verified synthetic user only; never changes status and never commits.
          await assert.rejects(updater.execute('UPDATE users SET deletion_status=deletion_status WHERE id=? AND email=?',
            [fixture.userId, fixture.email]), error => error.code === 'ER_LOCK_WAIT_TIMEOUT')
          timeoutObserved = true
        } finally { await updater.rollback() }
        receiptRead = true
      }
      return target.execute(sql, params)
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const commands = new MysqlContextCommands({ async getConnection() { return adapter } },
    async () => { throw Error('unexpected_target_resolution') }, createActivePrincipalAccess)
  phase = 'receipt-read'
  assert.equal(await commands.receipt(fixture.userId, randomUUID()), null)
  assert.ok(timeoutObserved && receiptRead && rolledBack)
  phase = 'released-lock'
  await updater.beginTransaction()
  await updater.execute('UPDATE users SET deletion_status=deletion_status WHERE id=? AND email=?', [fixture.userId, fixture.email])
  await updater.rollback()
  passed = true
  await output.writeFile(JSON.stringify({ kind: 'context-principal-lock-mysql/v1', observedAt: new Date().toISOString(),
    passed, identity, checks: ['separate-connections', 'receipt-shared-lock-blocks-user-update', 'rollback-releases-lock'],
    committedMutations: 0, scope: 'Compiled receipt reader and auth shared lock on the verified synthetic user. Two no-op UPDATE attempts are rolled back; no user status change, context write, terminal or browser activity. Proves lock contention, not a complete account revocation workflow.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed, checks: 3, committedMutations: 0 }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, phase, code: 'context_principal_lock_verification_failed' }) + '\n')
  process.exitCode = 1
} finally {
  if (reader) { await reader.rollback().catch(() => {}); reader.destroy() }
  if (updater) { await updater.rollback().catch(() => {}); updater.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
