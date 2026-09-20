import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import Fastify from 'fastify'
import { createRiskService, createRiskHttp } from '../server/dist-v4/modules/risk/composition.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'risk-current-application-readonly/v1', passed: false, writes: 0, applicationCredentialsUsed: true, realAuthenticationVerified: false }
let db
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const unavailable = () => { throw Error('readonly_probe') }
  const service = createRiskService({ execute: db.execute.bind(db) }, unavailable, { read: unavailable })
  let userId = 1
  const app = Fastify()
  try {
    await app.register(createRiskHttp(service, { authenticate: async () => ({ userId }), assertWrite: unavailable }))
    const results = []
    for (const [actor, accountId, status] of [[1, '1', 200], [28, '2', 200], [29, '2', 404]]) {
      userId = actor
      const response = await app.inject({ method: 'GET', url: `/api/v4/risk-accounts/${accountId}/policy` })
      assert.equal(response.statusCode, status)
      if (status === 200) {
        const value = response.json().data
        assert.equal(value.trade_send_enabled, false); assert.equal(value.manual_release_enabled, false)
        assert.equal(value.max_order_volume, actor === 1 ? '0.5' : '0.05')
        assert.equal(value.max_daily_loss_percent, actor === 1 ? '100' : '3')
        assert.equal(value.pending_dedup_atr_multiplier, '0.05')
        const [[source]] = await db.execute('SELECT CAST(updated_at AS CHAR) time FROM risk_policy_sets WHERE id=?', [actor === 1 ? 1 : 2])
        const expected = source.time.replace(' ', 'T') + (source.time.includes('.') ? 'Z' : '.000Z')
        assert.equal(value.updated_at, expected)
        if (actor === 28) assert.equal(value.account_policy_version_id, null)
      }
      results.push({ userId: actor, accountId, status })
    }
    Object.assign(report, { passed: true, results, utcReadVerified: true, historicalOwnerDenied: true })
  } finally { await app.close() }
} catch (error) {
  report.errorCode = error?.code ?? error?.name
  report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
