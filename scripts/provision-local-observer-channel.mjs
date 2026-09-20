import { createAnalysisStrategyAccess } from '../server/dist-v4/modules/strategies/composition.js'
import { createAdminPrincipalAccess } from '../server/dist-v4/modules/auth/composition.js'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import bcrypt from 'bcryptjs'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAccountRegistration, createTransactionTradingReader } from '../server/dist-v4/modules/trading/composition.js'
import { createActivePrincipalAccess, createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'
import { ObserverManagementService } from '../server/dist-v4/modules/trading/application/observer-management-service.js'
import { MysqlObserverManagementRepository } from '../server/dist-v4/modules/trading/infrastructure/mysql-observer-management-repository.js'

const [fixturePath, journalPath, destination, mode] = process.argv.slice(2)
const resume = mode === '--resume'
assert.ok(resume ? process.argv.length === 6 : process.argv.length === 5 && mode === undefined)
assert.ok([fixturePath, journalPath, destination].every(value => isAbsolute(value)))
assert.equal(new Set([fixturePath, journalPath, destination].map(value => resolve(value).toLowerCase())).size, 3)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1'); assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0)
const output = await open(destination, 'wx', 0o600)
let journal, pool, connection, phase = 'intent', commitState = 'not_attempted', actorUserId, accountId, sourceId, channelId
const checks = [], operations = []
const priorRecords = resume ? (await readFile(journalPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : []
const runId = resume ? priorRecords[0].runId : randomUUID()
assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
const intent = { kind: 'local-observer-fixture-intent/v1', runId, viewerUserId: fixture.userId,
  actorEmail: `v4-local-observer-${runId}@example.invalid`, brokerServer: `V4-OBSERVER-${runId}`,
  login: '900000003', slug: `local-observer-${runId}`, db: 'dev_vue' }
const record = async value => { await journal.writeFile(JSON.stringify(value) + '\n'); await journal.sync() }
try {
  if (resume) assert.deepEqual(priorRecords[0], intent)
  journal = await open(journalPath, resume ? 'a' : 'wx', 0o600)
  if (!resume) await record(intent)
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  // Hash a throwaway random password outside the transaction; no usable admin credential is retained.
  const passwordHash = resume ? null : await bcrypt.hash(randomBytes(48).toString('base64url'), 12)
  phase = 'operator-and-owned-account'
  await connection.beginTransaction()
  const [viewers] = await connection.execute("SELECT id FROM users WHERE id=? AND email=? AND role='user' AND deletion_status='active' AND deleted_at IS NULL FOR SHARE", [fixture.userId, fixture.email])
  assert.equal(viewers.length, 1)
  const registration = createAccountRegistration(connection, createActivePrincipalAccess(connection))
  if (resume) {
    const [actors] = await connection.execute("SELECT id FROM users WHERE uid=? AND email=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL FOR SHARE", [runId.replaceAll('-', ''), intent.actorEmail])
    assert.equal(actors.length, 1); actorUserId = actors[0].id
    const account = await registration.lockAccount({ platform: 'mt5', brokerServer: intent.brokerServer, login: intent.login })
    assert.ok(account); accountId = account.id
    assert.equal(await registration.lockCurrentOwnership({ userId: actorUserId, accountId }), '1')
    const priorCreation = priorRecords.find(row => row.phase === phase && row.commitState === 'attempted')
    assert.equal(priorCreation?.actorUserId, actorUserId); assert.equal(priorCreation?.accountId, accountId)
    await connection.rollback(); commitState = 'previously_confirmed'
    await record({ phase, actorUserId, accountId, commitState, resumed: true })
  } else {
    const [inserted] = await connection.execute("INSERT INTO users (uid,email,password,nickname,role,plan,token_version,deletion_status,created_at,updated_at) VALUES (?,?,?,'本地观摩联调运营者','admin','free',0,'active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [runId.replaceAll('-', ''), intent.actorEmail, passwordHash])
    assert.equal(inserted.affectedRows, 1); actorUserId = inserted.insertId
    const [[clock]] = await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%d %H:%i:%s.%f') registeredAt")
    const account = await registration.createAccount({ platform: 'mt5', brokerServer: intent.brokerServer,
      login: intent.login, currency: 'USD', registeredAt: clock.registeredAt })
    assert.equal(account.ok, true); accountId = account.accountId
    assert.equal((await registration.grantFirstOwnership({ userId: actorUserId, accountId, registeredAt: clock.registeredAt })).ok, true)
    await record({ phase, actorUserId, accountId, commitState: 'attempted' })
    commitState = 'attempted'; await connection.commit(); commitState = 'confirmed'
    await record({ phase, commitState })
  }
  assert.ok(Number.isSafeInteger(actorUserId) && actorUserId > 0 && actorUserId !== fixture.userId)
  connection.release(); connection = null
  checks.push('separate-synthetic-operator-and-owned-offline-account')
  const management = new ObserverManagementService(new MysqlObserverManagementRepository(pool, createAdminPrincipalAccess, createActivePrincipalAccess, createAnalysisStrategyAccess))
  const command = async (label, value) => {
    phase = label
    const key = `${runId}:${label}`
    const previous = priorRecords.filter(row => row.key === key)
    for (const row of previous) assert.deepEqual(row.command, value)
    if (resume) {
      const [receipts] = await pool.execute('SELECT result_json FROM observer_management_operations WHERE actor_user_id=? AND idempotency_key=?', [actorUserId, key])
      assert.ok(receipts.length <= 1)
      await record({ phase, inspectedReceiptCount: receipts.length })
    }
    await record({ phase, key, command: value, commitState: 'attempted' })
    const result = await management.write(actorUserId, 'admin', key, value)
    await record({ phase, result, commitState: 'confirmed' })
    operations.push({ phase, ...result }); return result
  }
  const sourceConfig = { displayName: '本地离线观摩源', notes: 'Synthetic local fixture; no terminal or trading data',
    tradingAccountId: accountId, analysisStrategyId: null, status: 'disabled' }
  const source = await command('source-create', { kind: 'source.create', config: sourceConfig })
  sourceId = source.target_id
  await command('source-activate', { kind: 'source.update', id: sourceId, expectedRevision: source.revision,
    config: { ...sourceConfig, status: 'active' } })
  const channelConfig = { displayName: '本地离线观摩频道', sourceId, slug: intent.slug,
    description: '仅供本地账户流程验收，无实时行情', audience: 'assigned', active: false, sortOrder: 999 }
  const channel = await command('channel-create', { kind: 'channel.create', config: channelConfig })
  channelId = channel.target_id
  await command('channel-activate', { kind: 'channel.update', id: channelId, expectedRevision: channel.revision,
    config: { ...channelConfig, active: true } })
  const grant = await command('viewer-grant', { kind: 'access.set', channelId, userId: fixture.userId, granted: true, expectedRevision: 0 })
  checks.push('domain-management-creates-disabled-then-activates-assigned-channel-and-grants-viewer')
  // The SQL grant timestamp must become eligible on the application clock; do not weaken authorization.
  // Bound this wait and report it so a skewed development VM is not mistaken for an immediate grant.
  phase = 'grant-clock-eligibility'
  const [grantRows] = await pool.execute("SELECT DATE_FORMAT(granted_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') grantedAt FROM observer_channel_accesses WHERE observer_channel_id=? AND user_id=? AND revision=? AND revoked_at_utc IS NULL", [channelId, fixture.userId, grant.revision])
  assert.equal(grantRows.length, 1)
  const grantedAt = Date.parse(grantRows[0].grantedAt)
  assert.ok(Number.isFinite(grantedAt))
  const eligibilityWaitMs = Math.max(0, grantedAt - Date.now() + 25)
  assert.ok(eligibilityWaitMs <= 10_000)
  if (eligibilityWaitMs) await new Promise(resolve => setTimeout(resolve, eligibilityWaitMs))
  phase = 'readback'
  connection = await pool.getConnection()
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const reader = createTransactionTradingReader(connection, createAccountPrincipalReader)
  const channels = await reader.listObserverChannels(fixture.userId)
  assert.equal(channels.length, 1); assert.equal(channels[0].id, channelId)
  assert.equal(channels[0].sourceAccountId, accountId)
  assert.equal(await reader.findOwnedAccount(fixture.userId, accountId), null)
  const owned = await reader.findOwnedAccount(actorUserId, accountId)
  assert.ok(owned); assert.equal(owned.bridgeState, 'offline'); assert.equal(owned.tradePermission, false)
  assert.equal(owned.terminalProfileId, null)
  assert.deepEqual(await reader.listObserverChannels(actorUserId), [])
  await connection.rollback()
  checks.push('viewer-can-observe-but-does-not-own-source-and-unassigned-operator-cannot-observe')
  await output.writeFile(JSON.stringify({ kind: 'local-observer-fixture/v1', observedAt: new Date().toISOString(), passed: true,
    identity, viewerUserId: fixture.userId, actorUserId, accountId, sourceId, channelId, accessRevision: grant.revision,
    checks, operations, commitState, eligibilityWaitMs, retained: 'Synthetic operator, owned account, source, assigned channel, grant, receipts and outbox events; private intent journal retained. No usable operator password retained.',
    scope: 'Compiled domain management and readback on current full dev_vue schema. No fabricated terminal profile, online state, prices, positions or commands. HTTP/browser observer flow not covered.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, actorUserId, accountId, sourceId, channelId }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, phase, commitState, actorUserId, accountId, sourceId, channelId, operations,
    code: 'local_observer_fixture_failed', detailCode: /^[a-z_]+$/.test(error.code ?? '') ? error.code : undefined,
    recovery: 'Do not create new identities. After diagnosing the failure, --resume verifies the durable intent and existing identity/account, inspects receipts, then reuses each exact original key/body through management idempotency. All history is retained.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: false, phase })); process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  if (pool) await pool.end()
  if (journal) await journal.close()
  await output.sync(); await output.close()
}
