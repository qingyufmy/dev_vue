import { createTradingApiModule, createMysqlInstrumentSnapshotReader } from '../server/dist-v4/modules/trading/composition.js'
import { createBridgeGatewayLeases } from '../server/dist-v4/modules/bridge/composition.js'
import { createMysqlStrategyService, createStrategyHttp, createAnalysisStrategyAccess } from '../server/dist-v4/modules/strategies/composition.js'
import { createMysqlReviewHttp } from '../server/dist-v4/modules/reviews/composition.js'
import { createRiskService, createRiskHttp } from '../server/dist-v4/modules/risk/composition.js'
import { createMysqlTradeDecisionRiskWriter } from '../server/dist-v4/modules/inference/composition.js'
import { createBrowserRequestAccess, createActivePrincipalAccess, createAccountPrincipalReader, createAdminPrincipalAccess } from '../server/dist-v4/modules/auth/composition.js'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import Redis from 'ioredis'
import Fastify from 'fastify'
import { localAccountEnvironment } from './run-local-account-api.mjs'
import { loadV4ApiRuntimeConfig } from '../server/dist-v4/bootstrap/runtime-config.js'
import { createAuthModule, createAuthHttp } from '../server/dist-v4/modules/auth/composition.js'
const [configuration, fixturePath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 5 && [configuration, fixturePath, destination].every(isAbsolute))
const env = localAccountEnvironment(parse(await readFile(new URL('../server/.env', import.meta.url))), parse(await readFile(configuration)))
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1'); assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.REDIS_HOST, '192.168.1.254')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'auth-current-inprocess/v1', passed: false, checks: [], networkListenerStarted: false, browserVerified: false, sessionsCreated: 0, sessionsRevoked: 0 }
let pool, redis, app
const cookies = new Map()
const request = async (port, path, payload, csrf, post = false) => app.inject({ method: !post && payload === undefined ? 'GET' : 'POST', url: path,
  headers: { host: `localhost:${port}`, ...(cookies.has(port) ? { cookie: cookies.get(port) } : {}),
    ...(!post && payload === undefined ? {} : { origin: `http://localhost:${port}` }), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(payload === undefined ? {} : { payload }) })
const remember = (port, response) => {
  const cookie = response.headers['set-cookie']; assert.ok(typeof cookie === 'string' || Array.isArray(cookie))
  const value = Array.isArray(cookie) ? cookie[0] : cookie
  assert.match(value, /HttpOnly/i); assert.doesNotMatch(value, /;\s*Domain=/i)
  cookies.set(port, value.split(';')[0]); report.sessionsCreated++
}
try {
  pool = mysql.createPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE, timezone: 'Z', connectionLimit: 2 })
  const [[identity]] = await pool.query('SELECT @@server_uuid uuid')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  redis = new Redis({ host: env.REDIS_HOST, port: Number(env.REDIS_PORT), password: env.REDIS_PASSWORD, db: Number(env.REDIS_DB), retryStrategy: () => null, maxRetriesPerRequest: 1 })
  redis.on('error', () => {}); await redis.ping()
  app = Fastify()
  const config = loadV4ApiRuntimeConfig(env)
  const auth = createAuthModule(pool, redis, config.auth, { revokeAllForUser: async () => { throw new Error('unexpected_device_revocation') } })
  await app.register(createAuthHttp(auth, config.secureCookies))
  const access = createBrowserRequestAccess(auth)
  const trading = createTradingApiModule(pool, redis, access, createBridgeGatewayLeases(redis), createActivePrincipalAccess, createAccountPrincipalReader, createAdminPrincipalAccess, createAnalysisStrategyAccess)
  await app.register(trading.tradeHttp)
  await app.register(createStrategyHttp(createMysqlStrategyService(pool), trading.tradeAuth))
  await app.register(createMysqlReviewHttp(pool, trading.tradeAuth))
  await app.register(createRiskHttp(createRiskService(pool, createMysqlTradeDecisionRiskWriter, createMysqlInstrumentSnapshotReader(pool)), trading.tradeAuth))
  const paths = ['/api/v4/trading-accounts', '/api/v4/strategies', '/api/v4/strategy-subscriptions', '/api/v4/review-cases', '/api/v4/strategy-memories']
  for (const path of paths) assert.equal((await request(4174, path)).statusCode, 401)
  report.checks.push('anonymous-business-reads-rejected')
  let response = await request(4174, '/auth/start?next=%2F')
  assert.equal(response.statusCode, 302)
  const authorize = new URL(response.headers.location)
  response = await request(4176, '/api/v4/auth/login', { ...Object.fromEntries(authorize.searchParams), login: fixture.email, password: fixture.password, remember: false })
  assert.equal(response.statusCode, 200); remember(4176, response); report.checks.push('real-password-login')
  const callback = new URL(response.json().data.redirect_to)
  response = await request(4174, callback.pathname + callback.search)
  assert.equal(response.statusCode, 302); remember(4174, response); report.checks.push('authorization-code-exchange')
  response = await request(4174, '/api/v4/session')
  assert.equal(response.statusCode, 200); assert.equal(response.json().data.user.id, String(fixture.userId)); report.checks.push('authenticated-session')
  response = await request(4174, callback.pathname + callback.search)
  assert.notEqual(response.statusCode, 302); report.checks.push('code-replay-rejected')
  report.businessReads = []
  for (const path of paths) {
    const result = await request(4174, path)
    report.businessReads.push({ path, status: result.statusCode })
    assert.equal(result.statusCode, 200)
  }
  const accounts = (await request(4174, paths[0])).json().data.items
  report.ownedAccounts = accounts.length
  for (const account of accounts) {
    const result = await request(4174, `/api/v4/risk-accounts/${account.id}/policy`)
    report.businessReads.push({ path: 'owned-account-risk-policy', status: result.statusCode })
    assert.equal(result.statusCode, 200)
  }
  const [foreign] = await pool.execute('SELECT id FROM review_cases_v4 WHERE user_id<>? LIMIT 1', [fixture.userId])
  assert.ok(foreign[0])
  for (const suffix of ['', '/versions', '/history', '/history/jobs', '/history/events', '/history/stages']) {
    assert.equal((await request(4174, '/api/v4/review-cases/' + foreign[0].id + suffix)).statusCode, 404)
  }
  report.checks.push('authenticated-business-reads-and-foreign-review-denial')
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name; report.locations = String(error?.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 2); process.exitCode = 1 }
finally {
  for (const port of [...cookies.keys()].reverse()) {
    try {
      const sessionPath = port === 4176 ? '/api/v4/auth/session' : '/api/v4/session'
      const session = await request(port, sessionPath)
      assert.equal(session.statusCode, 200)
      const response = await request(port, port === 4176 ? '/api/v4/auth/logout' : '/api/v4/session/logout', undefined, session.json().data.csrf_token, true)
      assert.equal(response.statusCode, 204)
      assert.equal((await request(port, sessionPath)).statusCode, 401); report.sessionsRevoked++
      if (port === 4174) {
        for (const path of ['/api/v4/trading-accounts', '/api/v4/strategies', '/api/v4/review-cases']) assert.equal((await request(port, path)).statusCode, 401)
        report.checks.push('revoked-session-rejected-by-business-modules')
      }
    } catch { report.passed = false; report.cleanupFailed = true; process.exitCode = 1 }
  }
  if (app) await app.close(); if (redis) await redis.quit(); if (pool) await pool.end()
  report.observedAt = new Date().toISOString(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close(); console.log(JSON.stringify(report))
}
