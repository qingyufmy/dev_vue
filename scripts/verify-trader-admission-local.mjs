import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { loadServerEnvironment, loadV4RuntimeConfig, createCacheRedis, connectCacheRedis } from '../server/dist-v4/bootstrap/index.js'
import { TraderAdmission } from '../server/dist-v4/queue/trader-admission.js'

loadServerEnvironment()
assert.equal(process.env.MYSQL_DATABASE, 'dev_vue')
const config = loadV4RuntimeConfig()
const redis = createCacheRedis(config.cacheRedis)
await connectCacheRedis(redis)
const prefix = `${config.queuePrefix}:test:${randomUUID()}`
const firstWorker = new TraderAdmission(redis, prefix, 2)
const secondWorker = new TraderAdmission(redis, prefix, 2)
const permits = []
try {
  const a = await firstWorker.enter(1, 'a'); assert.ok(a); permits.push(a)
  assert.equal(await secondWorker.enter(1, 'a'), null)
  const b = await secondWorker.enter(1, 'b'); assert.ok(b); permits.push(b)
  assert.equal(await firstWorker.enter(1, 'c'), null)
  const d = await secondWorker.enter(2, 'd'); assert.ok(d); permits.push(d)
  await a.close()
  const replacement = await secondWorker.enter(1, 'a'); assert.ok(replacement); permits.push(replacement)
  await a.close() // An old owner must not release the replacement's permit.
  assert.equal(await firstWorker.enter(1, 'a'), null)
  console.log(JSON.stringify({ passed: true, checks: ['account_serial_across_workers', 'accounts_parallel', 'user_capacity', 'other_user_progress', 'token_safe_release'], sendsOrders: false }))
} finally {
  await Promise.allSettled(permits.map(permit => permit.close()))
  // Exact test-owned keys only; no production queue or lock is modified.
  await redis.del(...['a', 'b', 'c', 'd'].map(id => `${prefix}:trader-admission:account:${id}`),
    ...[1, 2].map(id => `${prefix}:trader-admission:user:${id}`))
  await redis.quit()
}
