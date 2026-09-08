import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAdminPrincipalAccess, createActivePrincipalAccess } from '../server/dist-v4/modules/auth/composition.js'
import { createAnalysisStrategyAccess } from '../server/dist-v4/modules/strategies/composition.js'
import { ObserverManagementService } from '../server/dist-v4/modules/trading/index.js'
import { MysqlObserverManagementRepository } from '../server/dist-v4/modules/trading/infrastructure/mysql-observer-management-repository.js'

const [fixturePath, journalPath, planPath, reportPath, mode] = process.argv.slice(2)
assert.ok(process.argv.length === 7 && ['--prepare', '--apply'].includes(mode))
assert.ok([fixturePath, journalPath, planPath, reportPath].every(isAbsolute))
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const intent = JSON.parse((await readFile(journalPath, 'utf8')).split('\n')[0])
assert.equal(fixture.kind, 'local-observer-fixture/v1'); assert.equal(fixture.passed, true)
assert.equal(intent.kind, 'local-observer-fixture-intent/v1')
assert.equal(intent.viewerUserId, fixture.viewerUserId)
assert.match(intent.runId, /^[a-f0-9-]{36}$/)
assert.equal(intent.actorEmail, `v4-local-observer-${intent.runId}@example.invalid`)
const log = await open(reportPath, 'wx', 0o600)
const record = async value => { await log.writeFile(JSON.stringify(value) + '\n'); await log.sync() }
let pool, phase = 'inspect'
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  const [[identity]] = await pool.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  const readFixture = async () => {
    const [actors] = await pool.execute("SELECT id FROM users WHERE id=? AND uid=? AND email=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL",
      [fixture.actorUserId, intent.runId.replaceAll('-', ''), intent.actorEmail])
    assert.equal(actors.length, 1)
    const [accounts] = await pool.execute('SELECT id FROM trading_accounts WHERE id=? AND broker_server=? AND account_login=? AND deleted_at_utc IS NULL', [fixture.accountId, intent.brokerServer, intent.login])
    assert.equal(accounts.length, 1)
    const [sources] = await pool.execute('SELECT CAST(id AS CHAR) id,operator_user_id operatorId,CAST(trading_account_id AS CHAR) accountId,display_name displayName,notes,CAST(analysis_strategy_id AS CHAR) strategyId,status,revision FROM observer_sources WHERE id=?', [fixture.sourceId])
    assert.equal(sources.length, 1)
    const source = sources[0]
    assert.equal(source.operatorId, fixture.actorUserId); assert.equal(source.accountId, fixture.accountId)
    const [channels] = await pool.execute('SELECT CAST(id AS CHAR) id,display_name displayName,slug,description,audience,active,is_default isDefault,sort_order sortOrder,revision FROM observer_channels WHERE source_id=? ORDER BY id LIMIT 2', [fixture.sourceId])
    assert.equal(channels.length, 1)
    const channel = channels[0]
    assert.equal(channel.id, fixture.channelId); assert.equal(channel.slug, intent.slug)
    assert.equal(channel.audience, 'assigned'); assert.equal(Number(channel.isDefault), 0)
    const [accesses] = await pool.execute('SELECT user_id userId,revoked_at_utc revokedAt,revision FROM observer_channel_accesses WHERE observer_channel_id=? ORDER BY user_id LIMIT 2', [fixture.channelId])
    assert.equal(accesses.length, 1); assert.equal(accesses[0].userId, fixture.viewerUserId)
    return { source, channel, access: accesses[0] }
  }
  const before = await readFixture()
  let plan
  if (mode === '--prepare') {
    const revision = value => { const n = Number(value); assert.ok(Number.isSafeInteger(n) && n > 0); return n }
    plan = { kind: 'local-observer-retirement-plan/v1', runId: intent.runId, identity, actorUserId: fixture.actorUserId,
      sourceId: fixture.sourceId, channelId: fixture.channelId, viewerUserId: fixture.viewerUserId, before,
      commands: [
        { kind: 'access.set', channelId: fixture.channelId, userId: fixture.viewerUserId, granted: false, expectedRevision: revision(before.access.revision) },
        { kind: 'channel.update', id: fixture.channelId, expectedRevision: revision(before.channel.revision), config: {
          displayName: before.channel.displayName, sourceId: fixture.sourceId, slug: before.channel.slug,
          description: before.channel.description, audience: 'assigned', active: false, sortOrder: before.channel.sortOrder,
        } },
        { kind: 'source.update', id: fixture.sourceId, expectedRevision: revision(before.source.revision), config: {
          displayName: before.source.displayName, notes: before.source.notes, tradingAccountId: fixture.accountId,
          analysisStrategyId: before.source.strategyId, status: 'disabled',
        } },
      ] }
    const file = await open(planPath, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    await record({ status: 'prepared', identity, before, commandCount: 3 })
  } else {
    plan = JSON.parse(await readFile(planPath, 'utf8'))
    assert.equal(plan.kind, 'local-observer-retirement-plan/v1'); assert.equal(plan.runId, intent.runId)
    assert.deepEqual(plan.identity, identity)
    assert.equal(plan.actorUserId, fixture.actorUserId); assert.equal(plan.sourceId, fixture.sourceId)
    assert.equal(plan.channelId, fixture.channelId); assert.equal(plan.viewerUserId, fixture.viewerUserId)
    assert.equal(plan.commands.length, 3)
    const [revoke, channel, source] = plan.commands
    assert.equal(revoke.kind, 'access.set'); assert.equal(revoke.channelId, fixture.channelId)
    assert.equal(revoke.userId, fixture.viewerUserId); assert.equal(revoke.granted, false)
    assert.equal(channel.kind, 'channel.update'); assert.equal(channel.id, fixture.channelId)
    assert.deepEqual(channel.config, { displayName: before.channel.displayName, sourceId: fixture.sourceId, slug: intent.slug,
      description: before.channel.description, audience: 'assigned', active: false, sortOrder: before.channel.sortOrder })
    assert.equal(source.kind, 'source.update'); assert.equal(source.id, fixture.sourceId)
    assert.deepEqual(source.config, { displayName: before.source.displayName, notes: before.source.notes,
      tradingAccountId: fixture.accountId, analysisStrategyId: before.source.strategyId, status: 'disabled' })
    const service = new ObserverManagementService(new MysqlObserverManagementRepository(pool, createAdminPrincipalAccess, createActivePrincipalAccess, createAnalysisStrategyAccess))
    for (const [index, command] of plan.commands.entries()) {
      phase = `command-${index}`
      const key = `${intent.runId}:retire-v1:${index}`
      await record({ phase, key, command, status: 'attempted' })
      const result = await service.write(fixture.actorUserId, 'admin', key, command)
      await record({ phase, key, result, status: 'confirmed' })
    }
    phase = 'verify'
    const after = await readFixture()
    assert.notEqual(after.access.revokedAt, null)
    assert.equal(Number(after.channel.active), 0); assert.equal(after.source.status, 'disabled')
    await record({ status: 'verified', identity, after, retained: 'All fixture identities, account ownership, source/channel rows, grant tombstone and management history. Outbox delivery is a separate verification.' })
  }
  console.log(JSON.stringify({ passed: true, mode, sourceId: fixture.sourceId, channelId: fixture.channelId }))
} catch {
  await record({ status: 'failed', phase, recovery: 'Inspect receipts then resume only with the original plan and identical keys/bodies. Do not regenerate revisions or restore grants.' })
  process.exitCode = 1
  console.log(JSON.stringify({ passed: false, phase }))
} finally { await pool?.end(); await log.close() }
