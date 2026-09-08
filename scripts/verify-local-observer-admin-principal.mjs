import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAdminPrincipalAccess, createActivePrincipalAccess } from '../server/dist-v4/modules/auth/composition.js'
import { MysqlObserverManagementRepository } from '../server/dist-v4/modules/trading/infrastructure/mysql-observer-management-repository.js'

const [fixturePath, journalPath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 5 && [fixturePath, journalPath, destination].every(isAbsolute))
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const intent = JSON.parse((await readFile(journalPath, 'utf8')).split('\n')[0])
assert.equal(fixture.kind, 'local-observer-fixture/v1')
assert.equal(fixture.passed, true)
assert.equal(intent.kind, 'local-observer-fixture-intent/v1')
assert.equal(intent.viewerUserId, fixture.viewerUserId)
assert.equal(intent.actorEmail, `v4-local-observer-${intent.runId}@example.invalid`)
const output = await open(destination, 'wx', 0o600)
let pool, connection
const checks = []
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  const [[identity]] = await pool.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.serverUuid, fixture.identity.serverUuid)
  assert.equal(identity.timezone, '+00:00')
  const [actors] = await pool.execute("SELECT id FROM users WHERE id=? AND uid=? AND email=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL",
    [fixture.actorUserId, intent.runId.replaceAll('-', ''), intent.actorEmail])
  assert.equal(actors.length, 1)
  checks.push('exact-development-database-and-synthetic-administrator')
  connection = await pool.getConnection()
  await connection.beginTransaction()
  const access = createAdminPrincipalAccess(connection)
  assert.equal(await access.isAdmin(fixture.actorUserId, 'share'), true)
  assert.equal(await access.isAdmin(fixture.viewerUserId, 'share'), false)
  const principals = createActivePrincipalAccess(connection)
  assert.equal(await principals.isActive(fixture.actorUserId, 'share'), true)
  assert.equal(await principals.isActive(fixture.viewerUserId, 'share'), true)
  checks.push('same-connection-active-source-operator-and-recipient')
  await connection.rollback()
  connection.release(); connection = undefined
  checks.push('same-connection-shared-lock-admin-accepted-viewer-rejected')
  const management = new MysqlObserverManagementRepository(pool, createAdminPrincipalAccess, createActivePrincipalAccess)
  const page = await management.list(fixture.actorUserId, { kind: 'sources', afterId: null, limit: 100 })
  assert.ok(page.items.length > 0)
  await assert.rejects(management.list(fixture.viewerUserId, { kind: 'sources', afterId: null, limit: 100 }),
    error => error.code === 'observer_management_admin_required' && error.status === 403)
  checks.push('real-management-list-admin-accepted-viewer-forbidden')
  await output.writeFile(JSON.stringify({ kind: 'local-observer-admin-principal/v2', passed: true,
    observedAt: new Date().toISOString(), identity, checks, commitState: 'not_attempted',
    scope: 'Compiled auth capability and observer management list against existing synthetic identities. Shared-lock transaction rolled back; no data mutation, runtime restart, HTTP or browser proof.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, code: 'local_observer_admin_principal_failed', checks }) + '\n')
  process.exitCode = 1
  console.log(JSON.stringify({ passed: false, checks: checks.length }))
} finally {
  if (connection) { try { await connection.rollback() } finally { connection.release() } }
  await pool?.end()
  await output.sync(); await output.close()
}
