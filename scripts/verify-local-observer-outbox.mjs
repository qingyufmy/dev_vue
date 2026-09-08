import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { localAccountEnvironment } from './run-local-account-api.mjs'
import { connectCacheRedis, createCacheRedis, createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { OutboxDispatcher, MysqlOutboxRepository, RedisOutboxRealtimePublisher } from '../server/dist-v4/outbox/index.js'
import { OBSERVER_CONTROL_CHANNEL, observerInvalidation } from '../server/dist-v4/modules/trading/index.js'
import { hash } from './lib/v4-backfill-contract.mjs'

const [fixturePath, sourceJournalPath, runtimeConfigPath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 6 && [fixturePath, sourceJournalPath, runtimeConfigPath, destination].every(isAbsolute))
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-observer-fixture/v1'); assert.equal(fixture.passed, true)
assert.equal(fixture.identity.db, 'dev_vue')
const intent = JSON.parse((await readFile(sourceJournalPath, 'utf8')).split('\n')[0])
assert.equal(intent.kind, 'local-observer-fixture-intent/v1'); assert.equal(intent.viewerUserId, fixture.viewerUserId)
assert.match(intent.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
assert.equal(intent.actorEmail, `v4-local-observer-${intent.runId}@example.invalid`)
const output = await open(destination, 'wx', 0o600)
const parseJson = value => typeof value === 'string' ? JSON.parse(value) : value
let pool, publisherRedis, observerRedis, phase = 'identity', batchResult, before, after, owner
const deliveries = [], checks = []
try {
  const base = parse(await readFile(new URL('../server/.env', import.meta.url)))
  const env = localAccountEnvironment(base, parse(await readFile(runtimeConfigPath)))
  assert.equal(env.MYSQL_HOST, '192.168.31.254')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  const [[identity]] = await pool.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.timezone, '+00:00')
  const [actors] = await pool.execute("SELECT id FROM users WHERE id=? AND uid=? AND email=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL",
    [fixture.actorUserId, intent.runId.replaceAll('-', ''), intent.actorEmail])
  assert.equal(actors.length, 1)
  const select = `SELECT CAST(e.id AS CHAR) id,e.event_id eventId,e.event_type eventType,e.aggregate_type aggregateType,
    e.status,e.attempts,e.available_at_utc availableAt,e.payload_json payload,
    o.actor_user_id actorUserId,o.action,o.audit_json audit
    FROM outbox_events e LEFT JOIN observer_management_operations o ON o.id=e.aggregate_id
    ORDER BY e.id LIMIT 501`
  const validate = rows => {
    assert.ok(rows.length > 0 && rows.length <= 100)
    for (const row of rows) {
      assert.match(row.id, /^[1-9][0-9]*$/); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0)
      assert.equal(row.eventType, 'observer.authorization.changed'); assert.equal(row.aggregateType, 'observer_management')
      assert.equal(row.actorUserId, fixture.actorUserId); assert.ok(row.availableAt instanceof Date && row.availableAt.getTime() <= Date.now())
      const audit = parseJson(row.audit), payload = observerInvalidation(parseJson(row.payload))
      assert.ok(payload); assert.equal(audit.kind, row.action)
      if (row.action === 'source.create' || row.action === 'source.update') {
        assert.equal(audit.config.tradingAccountId, fixture.accountId)
        assert.equal(payload.source_id, fixture.sourceId)
      } else if (row.action === 'channel.create' || row.action === 'channel.update') {
        assert.equal(audit.config.sourceId, fixture.sourceId); assert.equal(audit.config.slug, intent.slug)
        assert.equal(payload.channel_id, fixture.channelId)
      } else {
        assert.equal(row.action, 'access.set'); assert.equal(audit.channelId, fixture.channelId)
        assert.equal(audit.userId, fixture.viewerUserId); assert.equal(payload.user_id, fixture.viewerUserId)
        assert.equal(payload.channel_id, fixture.channelId)
      }
    }
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
  }
  ;[before] = await pool.query(select)
  validate(before)
  const ids = new Set(before.map(row => row.id))
  const immutable = rows => rows.map(row => ({ id: row.id, eventId: row.eventId, eventType: row.eventType,
    status: row.status, attempts: row.attempts, payload: parseJson(row.payload), audit: parseJson(row.audit) }))
  const beforeHash = hash(immutable(before))
  checks.push('entire-outbox-is-bounded-pending-synthetic-observer-events')
  const redisConfig = { host: env.REDIS_HOST, port: Number(env.REDIS_PORT), db: Number(env.REDIS_DB), password: env.REDIS_PASSWORD }
  publisherRedis = createCacheRedis(redisConfig); observerRedis = createCacheRedis(redisConfig)
  await Promise.all([connectCacheRedis(publisherRedis), connectCacheRedis(observerRedis)])
  observerRedis.on('message', (channel, raw) => {
    if (channel !== OBSERVER_CONTROL_CHANNEL || deliveries.length >= 101) return
    try { deliveries.push(observerInvalidation(JSON.parse(raw))) } catch { deliveries.push(null) }
  })
  await observerRedis.subscribe(OBSERVER_CONTROL_CHANNEL)
  // Guard before the real repository's first mutation, inside its transaction. Locking the full bounded
  // set prevents a concurrent insertion/claim from making this one-shot batch touch unrelated events.
  const guardedPool = {
    async getConnection() {
      const connection = await pool.getConnection()
      return new Proxy(connection, { get(target, key) {
        if (key === 'beginTransaction') return async () => {
          await target.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
          await target.beginTransaction()
          const [locked] = await target.query(select + ' FOR UPDATE')
          validate(locked); assert.equal(hash(immutable(locked)), beforeHash)
        }
        if (key === 'execute') return async (sql, args) => {
          if (sql.includes("SET status='dispatching'")) { owner = args[0]; assert.match(owner, /^outbox:/) }
          return target.execute(sql, args)
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    },
    async execute(sql, args) {
      // Acknowledge/retry may only mutate the exact ids claimed by this probe and its generated owner.
      const id = sql.includes("SET status='dispatched'") ? args[1] : args[2]
      assert.ok(ids.has(id)); assert.equal(args.at(-1), owner)
      return pool.execute(sql, args)
    },
  }
  phase = 'dispatch'
  const realPublisher = new RedisOutboxRealtimePublisher(pool, publisherRedis)
  batchResult = await new OutboxDispatcher(new MysqlOutboxRepository(guardedPool), {
    async publish(event) { assert.ok(ids.has(event.id)); assert.equal(event.eventType, 'observer.authorization.changed'); await realPublisher.publish(event) },
  }).runBatch(before.length)
  assert.deepEqual(batchResult, { claimed: before.length, dispatched: before.length, failed: 0 })
  checks.push('real-mysql-claim-dispatcher-publisher-and-acknowledgement-complete')
  phase = 'verify-delivery'
  const deadline = Date.now() + 3000
  while (deliveries.length < before.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(deliveries.map(value => hash(value)).sort(), before.map(row => hash(observerInvalidation(parseJson(row.payload)))).sort())
  checks.push('redis-subscriber-received-every-persisted-control-payload')
  ;[after] = await pool.execute(`SELECT CAST(id AS CHAR) id,status,attempts,lease_owner leaseOwner,lease_expires_at_utc leaseExpiresAt,
    dispatched_at_utc dispatchedAt FROM outbox_events WHERE id IN (${[...ids].map(() => '?').join(',')}) ORDER BY id`, [...ids])
  assert.equal(after.length, before.length)
  for (const row of after) {
    assert.equal(row.status, 'dispatched'); assert.equal(row.attempts, 1)
    assert.equal(row.leaseOwner, null); assert.equal(row.leaseExpiresAt, null); assert.ok(row.dispatchedAt instanceof Date)
  }
  checks.push('all-selected-events-acknowledged-once-and-leases-cleared')
  await output.writeFile(JSON.stringify({ kind: 'local-observer-outbox-dispatch/v1', observedAt: new Date().toISOString(), passed: true,
    identity, checks, batchResult, beforeHash, eventIds: before.map(row => row.eventId), after, redisDeliveries: deliveries.length,
    scope: 'Real permanent MySQL claim/ack and Redis delivery for the complete bounded synthetic observer batch. Transactional fixture guard precedes repository mutations. No unrelated event, BullMQ task, background dispatcher loop or terminal action.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, batchResult, redisDeliveries: deliveries.length }))
} catch {
  await output.writeFile(JSON.stringify({ passed: false, phase, batchResult, code: 'local_observer_outbox_failed',
    recovery: 'Inspect the exact fixture event statuses/leases before continuing. Do not reset dispatched rows or blindly rerun this probe.' }) + '\n')
  console.log(JSON.stringify({ passed: false, phase, batchResult })); process.exitCode = 1
} finally {
  await Promise.allSettled([observerRedis?.quit(), publisherRedis?.quit(), pool?.end()])
  await output.sync(); await output.close()
}
