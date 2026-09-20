import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'
import { MysqlObserverSnapshotReader, withMysqlObserverSnapshot } from '../server/dist-v4/modules/trading/infrastructure/mysql-observer-snapshot-reader.js'

const [fixturePath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && isAbsolute(fixturePath) && isAbsolute(destination) && fixturePath !== destination)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1'); assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0)
const output = await open(destination, 'wx', 0o600)
let pool, phase = 'identity'
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  const [[identity]] = await pool.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone,@@session.transaction_isolation isolationLevel,CONNECTION_ID() connectionId')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  const [users] = await pool.execute("SELECT id FROM users WHERE id=? AND email=? AND deletion_status='active' AND deleted_at IS NULL", [fixture.userId, fixture.email])
  assert.equal(users.length, 1)
  phase = 'snapshot-and-read-only'
  await withMysqlObserverSnapshot(pool, async connection => {
    const facts = await createAccountPrincipalReader(connection).readMany([fixture.userId], 'none')
    assert.ok(facts.has(fixture.userId))
    // Locking a persistent table is forbidden in this read-only transaction. No update is attempted.
    await assert.rejects(connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [fixture.userId]),
      error => error.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION')
  })
  phase = 'ordinary-observer-read'
  assert.deepEqual(await new MysqlObserverSnapshotReader(pool, createAccountPrincipalReader).list(fixture.userId), [])
  phase = 'pool-reuse'
  const [[after]] = await pool.query('SELECT @@session.transaction_isolation isolationLevel,CONNECTION_ID() connectionId')
  assert.equal(after.isolationLevel, identity.isolationLevel)
  assert.equal(after.connectionId, identity.connectionId)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [fixture.userId])
    await connection.rollback()
  } finally { connection.destroy() }
  await output.writeFile(JSON.stringify({ kind: 'observer-snapshot-mysql/v1', observedAt: new Date().toISOString(),
    identity, passed: true, checks: ['principal-facts-inside-read-only-snapshot', 'locking-read-rejected',
      'ordinary-observer-list', 'same-connection-reused-with-original-isolation-and-write-mode'], databaseWrites: 0,
    scope: 'Real current MySQL, compiled snapshot wrapper and identity facts reader, synthetic user with no channels. Does not prove cross-connection concurrent snapshots, positive observer grants or browser behavior.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: 4, databaseWrites: 0 }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, phase, code: 'observer_snapshot_verification_failed' }) + '\n')
  process.exitCode = 1
} finally {
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
