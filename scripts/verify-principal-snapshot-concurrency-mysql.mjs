import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'
import { withMysqlObserverSnapshot } from '../server/dist-v4/modules/trading/infrastructure/mysql-observer-snapshot-reader.js'

const [fixturePath, destination, mode] = process.argv.slice(2)
assert.ok(process.argv.length === 5 && mode === '--advance-fixture-version' && isAbsolute(fixturePath) && isAbsolute(destination) && fixturePath !== destination)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1'); assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0)
const output = await open(destination, 'wx', 0o600)
let pool, updater, lockedReader, phase = 'identity', versionAdvance = 'not_attempted', priorVersion
const checks = []
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.31.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  updater = await pool.getConnection()
  const [[identity]] = await updater.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone,CONNECTION_ID() connectionId')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  const [users] = await updater.execute("SELECT id,token_version FROM users WHERE id=? AND email=? AND deletion_status='active' AND deleted_at IS NULL", [fixture.userId, fixture.email])
  assert.equal(users.length, 1)
  priorVersion = users[0].token_version
  assert.ok(Number.isSafeInteger(priorVersion) && priorVersion >= 0 && priorVersion < 2_147_483_647)
  phase = 'snapshot-before-and-after-commit'
  await withMysqlObserverSnapshot(pool, async connection => {
    const [[current]] = await connection.query('SELECT CONNECTION_ID() connectionId')
    assert.notEqual(current.connectionId, identity.connectionId)
    const reader = createAccountPrincipalReader(connection)
    assert.equal((await reader.readMany([fixture.userId], 'none')).get(fixture.userId)?.tokenVersion, priorVersion)
    await updater.beginTransaction()
    const [result] = await updater.execute("UPDATE users SET token_version=token_version+1 WHERE id=? AND email=? AND token_version=? AND deletion_status='active' AND deleted_at IS NULL",
      [fixture.userId, fixture.email, priorVersion])
    assert.equal(result.affectedRows, 1)
    versionAdvance = 'commit_attempted'
    await updater.commit()
    versionAdvance = 'confirmed'
    assert.equal((await reader.readMany([fixture.userId], 'none')).get(fixture.userId)?.tokenVersion, priorVersion)
  })
  checks.push('same-snapshot-retains-prior-version-after-other-connection-commit')
  phase = 'fresh-snapshot'
  await withMysqlObserverSnapshot(pool, async connection => {
    assert.equal((await createAccountPrincipalReader(connection).readMany([fixture.userId], 'none')).get(fixture.userId)?.tokenVersion, priorVersion + 1)
  })
  checks.push('new-snapshot-observes-advanced-version')
  phase = 'shared-facts-lock'
  await updater.query('SET SESSION innodb_lock_wait_timeout=1')
  lockedReader = await pool.getConnection()
  await lockedReader.beginTransaction()
  assert.equal((await createAccountPrincipalReader(lockedReader).readMany([fixture.userId], 'share')).get(fixture.userId)?.tokenVersion, priorVersion + 1)
  await updater.beginTransaction()
  await assert.rejects(updater.execute('UPDATE users SET token_version=token_version WHERE id=? AND email=?', [fixture.userId, fixture.email]),
    error => error.code === 'ER_LOCK_WAIT_TIMEOUT')
  await updater.rollback()
  await lockedReader.rollback()
  checks.push('shared-principal-facts-block-concurrent-update')
  await updater.beginTransaction()
  await updater.execute('UPDATE users SET token_version=token_version WHERE id=? AND email=?', [fixture.userId, fixture.email])
  await updater.rollback()
  checks.push('shared-lock-released-by-caller-rollback')
  await output.writeFile(JSON.stringify({ kind: 'principal-snapshot-concurrency-mysql/v1', observedAt: new Date().toISOString(),
    identity, passed: true, checks, versionAdvance, priorVersion, finalVersion: priorVersion + 1,
    committedFixtureUpdates: 1, retained: 'Synthetic user identity revision is advanced, never restored backwards. Any prior fixture sessions are invalidated.',
    scope: 'Compiled auth facts reader and observer snapshot helper using two real MySQL connections. Only the verified private synthetic user version is changed; no channel/account/trading data changes. Does not prove a positive permanent observer channel or browser flow.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, versionAdvance, priorVersion, finalVersion: priorVersion + 1 }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, phase, versionAdvance, priorVersion,
    code: 'principal_snapshot_concurrency_failed', recovery: 'Do not decrement the identity version or automatically replay an uncertain commit.' }) + '\n')
  process.exitCode = 1
} finally {
  if (lockedReader) { await lockedReader.rollback().catch(() => {}); lockedReader.destroy() }
  if (updater) { await updater.rollback().catch(() => {}); updater.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
