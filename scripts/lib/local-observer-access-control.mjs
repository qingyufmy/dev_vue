import { createAnalysisStrategyAccess } from '../../server/dist-v4/modules/strategies/composition.js'
import { createAdminPrincipalAccess, createActivePrincipalAccess } from '../../server/dist-v4/modules/auth/composition.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { parse } from 'dotenv'
import { connectCacheRedis, createCacheRedis, createMysqlPool } from '../../server/dist-v4/bootstrap/runtime-resources.js'
import { RedisOutboxRealtimePublisher } from '../../server/dist-v4/outbox/infrastructure/redis-outbox-realtime-publisher.js'
import { localAccountEnvironment } from '../run-local-account-api.mjs'
import { ObserverManagementService } from '../../server/dist-v4/modules/trading/application/observer-management-service.js'
import { MysqlObserverManagementRepository } from '../../server/dist-v4/modules/trading/infrastructure/mysql-observer-management-repository.js'

// Test-only control: exactly revoke, then restore one verified synthetic viewer grant.
// No general administrator credentials or arbitrary target selection are exposed.
export async function createLocalObserverAccessControl(fixture, observer, sourceJournalPath, runtimeConfigPath) {
  assert.ok(isAbsolute(sourceJournalPath))
  const intent = JSON.parse((await readFile(sourceJournalPath, 'utf8')).split('\n')[0])
  assert.equal(intent.kind, 'local-observer-fixture-intent/v1')
  assert.match(intent.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  assert.equal(intent.db, 'dev_vue'); assert.equal(intent.viewerUserId, fixture.userId)
  assert.equal(intent.actorEmail, `v4-local-observer-${intent.runId}@example.invalid`)
  assert.equal(intent.brokerServer, `V4-OBSERVER-${intent.runId}`)
  assert.equal(intent.slug, `local-observer-${intent.runId}`)
  assert.equal(observer.viewerUserId, fixture.userId); assert.notEqual(observer.actorUserId, fixture.userId)
  const env = parse(await readFile(new URL('../../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  let journal, redis, phase = 0, initialRevision, inFlight = false
  const transitions = [], runId = randomUUID()
  const read = async () => {
    const [rows] = await pool.execute(`SELECT CAST(x.revision AS CHAR) revision,x.revoked_at_utc revokedAt,
      DATE_FORMAT(x.granted_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') grantedAt
      FROM observer_channel_accesses x
      INNER JOIN observer_channels c ON c.id=x.observer_channel_id AND c.source_id=? AND c.slug=? AND c.audience='assigned' AND c.active=1
      INNER JOIN observer_sources s ON s.id=c.source_id AND s.operator_user_id=? AND s.trading_account_id=? AND s.status='active' AND s.configuration_status='ready'
      INNER JOIN trading_accounts a ON a.id=s.trading_account_id AND a.id=c.source_trading_account_id AND a.broker_server=? AND a.account_login=? AND a.deleted_at_utc IS NULL
      INNER JOIN users actor ON actor.id=s.operator_user_id AND actor.uid=? AND actor.email=? AND actor.role='admin' AND actor.deletion_status='active' AND actor.deleted_at IS NULL
      INNER JOIN users viewer ON viewer.id=x.user_id AND viewer.email=? AND viewer.role='user' AND viewer.deletion_status='active' AND viewer.deleted_at IS NULL
      WHERE x.observer_channel_id=? AND x.user_id=? AND x.granted_by_user_id=?`,
    [observer.sourceId, intent.slug, observer.actorUserId, observer.accountId, intent.brokerServer, intent.login,
      intent.runId.replaceAll('-', ''), intent.actorEmail, fixture.email, observer.channelId, fixture.userId, observer.actorUserId])
    assert.equal(rows.length, 1)
    assert.match(rows[0].revision, /^[1-9][0-9]*$/)
    assert.ok(BigInt(rows[0].revision) < BigInt(Number.MAX_SAFE_INTEGER - 2))
    return rows[0]
  }
  try {
    const [[identity]] = await pool.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
    assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
    assert.equal(identity.timezone, '+00:00')
    const initial = await read(); assert.equal(initial.revokedAt, null)
    initialRevision = Number(initial.revision)
    if (runtimeConfigPath) {
      assert.ok(isAbsolute(runtimeConfigPath))
      const local = localAccountEnvironment(env, parse(await readFile(runtimeConfigPath)))
      redis = createCacheRedis({ host: local.REDIS_HOST, port: Number(local.REDIS_PORT), db: Number(local.REDIS_DB), password: local.REDIS_PASSWORD })
      await connectCacheRedis(redis)
    }
    journal = await open(join(dirname(sourceJournalPath), `observer-access-${runId}.jsonl`), 'wx', 0o600)
    const record = async value => { await journal.writeFile(JSON.stringify(value) + '\n'); await journal.sync() }
    await record({ kind: 'local-observer-access-test/v1', runId, actorUserId: observer.actorUserId,
      viewerUserId: fixture.userId, channelId: observer.channelId, initialRevision, identity })
    const service = new ObserverManagementService(new MysqlObserverManagementRepository(pool, createAdminPrincipalAccess, createActivePrincipalAccess, createAnalysisStrategyAccess))
    return {
      async transition(granted) {
        assert.ok(!inFlight && phase < 2 && granted === (phase === 1))
        inFlight = true
        const prior = await read()
        assert.equal(Number(prior.revision), initialRevision + phase)
        assert.equal(prior.revokedAt === null, !granted)
        const key = `${runId}:${granted ? 'restore' : 'revoke'}`
        const command = { kind: 'access.set', channelId: observer.channelId, userId: fixture.userId, granted, expectedRevision: Number(prior.revision) }
        const attempt = { key, granted, priorRevision: command.expectedRevision, commitState: 'attempted' }
        transitions.push(attempt)
        await record({ ...attempt, command })
        const result = await service.write(observer.actorUserId, 'admin', key, command)
        attempt.commitState = 'confirmed'; attempt.result = result
        await record(attempt)
        assert.equal(result.revision, initialRevision + phase + 1)
        phase++
        const after = await read()
        assert.equal(Number(after.revision), result.revision); assert.equal(after.revokedAt === null, granted)
        const eligibilityWaitMs = granted ? Math.max(0, Date.parse(after.grantedAt) - Date.now() + 25) : 0
        assert.ok(Number.isFinite(eligibilityWaitMs) && eligibilityWaitMs <= 10_000)
        attempt.eligibilityWaitMs = eligibilityWaitMs
        if (eligibilityWaitMs) await new Promise(resolve => setTimeout(resolve, eligibilityWaitMs))
        inFlight = false
        return result
      },
      report() { return { initialRevision, completedTransitions: phase, transitions } },
      async publishRevocation() {
        assert.ok(redis && phase === 1)
        const transition = transitions[0]
        assert.equal(transition.granted, false); assert.equal(transition.commitState, 'confirmed')
        assert.equal(transition.publication, undefined)
        const [rows] = await pool.execute(`SELECT CAST(id AS CHAR) id,event_id eventId,event_type eventType,payload_json payload,status,attempts,
          DATE_FORMAT(created_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') occurredAt FROM outbox_events
          WHERE aggregate_type='observer_management' AND aggregate_id=? AND event_type='observer.authorization.changed'`, [transition.result.operation_id])
        assert.equal(rows.length, 1); assert.equal(rows[0].status, 'pending')
        const row = rows[0], payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
        assert.equal(payload.user_id, fixture.userId); assert.equal(payload.channel_id, observer.channelId)
        assert.equal(payload.source_id, observer.sourceId); assert.equal(payload.registry_revision, transition.result.registry_revision)
        transition.publication = { state: 'attempted', eventId: row.eventId, outboxAcknowledged: false }
        await record(transition)
        await new RedisOutboxRealtimePublisher(pool, redis).publish({ ...row, payload })
        transition.publication.state = 'confirmed'
        await record(transition)
      },
      async close() {
        const results = await Promise.allSettled([redis ? redis.quit() : Promise.resolve(), pool.end(), journal.close()])
        if (results.some(result => result.status === 'rejected')) throw Error('local_observer_control_cleanup_failed')
      },
    }
  } catch (error) { if (redis) redis.disconnect(); await pool.end(); if (journal) await journal.close(); throw error }
}
