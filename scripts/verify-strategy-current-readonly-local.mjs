import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { createMysqlStrategyService } from '../server/dist-v4/modules/strategies/composition.js'
import { assertMysqlExecutionWorkflowSchemaReady } from '../server/dist-v4/modules/execution/composition.js'
import Fastify from 'fastify'
import { createMysqlReviewHttp } from '../server/dist-v4/modules/reviews/composition.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'strategy-current-application-readonly/v1', passed: false, writes: 0, applicationCredentialsUsed: true }
let db
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const connection = new Proxy(db, { get(target, key) {
    if (key === 'release') return () => {}
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
  } })
  const pool = { getConnection: async () => connection, execute: db.execute.bind(db) }
  await assertMysqlExecutionWorkflowSchemaReady(pool)
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  await db.query('SELECT actor_user_id,idempotency_key FROM strategy_write_receipts_v4 LIMIT 1')
  const [users] = await db.query('SELECT DISTINCT user_id FROM strategy_subscriptions ORDER BY user_id')
  const service = createMysqlStrategyService(pool)
  const counts = []
  for (const row of users) {
    const userId = Number(row.user_id), subscriptions = await service.listSubscriptions(userId), strategies = await service.list(userId)
    assert.ok(subscriptions.every(item => item.userId === userId && item.status === 'paused' && !item.analysisEnabled && !item.traderEnabled && !item.tradeSendEnabled))
    assert.ok(strategies.every(item => item.status === 'draft' && item.activeVersionId === null))
    counts.push({ userId, visibleStrategies: strategies.length, visibleSubscriptions: subscriptions.length })
  }
  assert.equal(counts.reduce((sum, row) => sum + row.visibleSubscriptions, 0), 3)
  const app = Fastify()
  try {
    await app.register(createMysqlReviewHttp(pool, { authenticate: async () => ({ userId: counts[0].userId }), assertWrite: async () => { throw Error('readonly_probe') } }))
    const list = await app.inject({ method: 'GET', url: '/api/v4/strategy-memories' })
    report.memoryListStatus = list.statusCode
    if (list.statusCode !== 200) report.memoryListCode = list.json().code
    assert.equal(list.statusCode, 200)
    const items = list.json().data.items
    assert.equal(items.length, 4)
    for (const item of items) {
      assert.equal(item.mode, 'shadow'); assert.equal(item.status, 'revalidating')
      const detail = await app.inject({ method: 'GET', url: `/api/v4/strategy-memories/${item.id}` })
      report.memoryDetailStatus = detail.statusCode
      if (detail.statusCode !== 200) report.memoryDetailCode = detail.json().code
      assert.equal(detail.statusCode, 200)
    }
    report.memoryReadApiVerified = true; report.visibleMemoryLibraries = items.length
    report.realAuthenticationVerified = false
  } finally { await app.close() }
  await db.rollback()
  Object.assign(report, { passed: true, schemaReady: true, counts, historicalSubscriptionsHidden: 2 })
} catch (error) { report.errorCode = error?.code ?? error?.name; report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3); process.exitCode = 1 }
finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
