import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { parse } from 'dotenv'
import Redis from 'ioredis'
import { localAccountEnvironment } from './run-local-account-api.mjs'

const [configuration, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && isAbsolute(configuration) && isAbsolute(destination) && configuration !== destination)
const output = await open(destination, 'wx', 0o600)
let redis, state, phase = 'configuration'
function request(path, host, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    // node:http preserves Host for the local reverse-proxy surfaces; never follow redirects.
    const req = http.request({ host: '127.0.0.1', port: 3010, path, method: data ? 'POST' : 'GET',
      headers: { Host: host, ...(data ? { 'Content-Type': 'application/json', Origin: 'http://' + host, 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; let length = 0
      res.on('error', reject)
      res.on('data', chunk => { length += chunk.length; if (length > 1_048_576) res.destroy(Error('response_budget')); else chunks.push(chunk) })
      res.on('end', () => {
        try { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }) }
        catch { reject(Error('response_invalid')) }
      })
    })
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(Error('request_timeout'))); req.end(data)
  })
}
try {
  const env = localAccountEnvironment(parse(await readFile(new URL('../server/.env', import.meta.url))), parse(await readFile(configuration)))
  redis = new Redis({ host: env.REDIS_HOST, port: Number(env.REDIS_PORT), password: env.REDIS_PASSWORD, db: Number(env.REDIS_DB),
    lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null, connectTimeout: 3000 })
  redis.on('error', () => {})
  phase = 'redis'
  await redis.connect(); assert.equal(await redis.ping(), 'PONG')
  const version = /(?:^|\r\n)redis_version:([^\r]+)/.exec(await redis.info('server'))?.[1]
  const checks = []
  for (const path of ['/health/live', '/health/ready']) {
    phase = path
    const result = await request(path, '127.0.0.1:3010')
    assert.equal(result.status, 200); assert.equal(result.body.status, 'ok')
    if (path.endsWith('/ready')) assert.equal(result.body.dependencies_ready, true)
    checks.push({ name: path, status: 200 })
  }
  phase = 'auth-endpoints'
  let result = await request('/.well-known/openid-configuration', 'localhost:4176')
  assert.equal(result.status, 200); assert.equal(result.body.issuer, env.AUTH_ORIGIN)
  checks.push({ name: 'auth-discovery', status: 200 })
  result = await request('/oauth/jwks', 'localhost:4176')
  assert.equal(result.status, 200); assert.equal(result.body.keys.length, 1)
  assert.equal(result.body.keys[0].alg, 'ES256'); assert.equal('d' in result.body.keys[0], false)
  checks.push({ name: 'public-signing-key', status: 200, privateMaterial: false })
  result = await request('/.well-known/openid-configuration', 'localhost:4174')
  assert.equal(result.status, 404); checks.push({ name: 'wrong-auth-host', status: 404 })
  result = await request('/api/v4/session', 'localhost:4174')
  assert.equal(result.status, 401); checks.push({ name: 'anonymous-trade-session', status: 401 })
  phase = 'login-start'
  result = await request('/auth/start?next=%2F', 'localhost:4174')
  assert.equal(result.status, 302)
  const redirect = new URL(result.headers.location)
  assert.equal(redirect.origin, env.AUTH_ORIGIN); assert.equal(redirect.pathname, '/oauth/authorize')
  const params = Object.fromEntries(redirect.searchParams)
  assert.match(params.state, /^[A-Za-z0-9_-]{24,128}$/); state = params.state
  assert.ok(await redis.exists(`auth:v4:login:${state}`))
  checks.push({ name: 'trade-login-start', status: 302, redisTransactionPresent: true })
  phase = 'invalid-credentials'
  result = await request('/api/v4/auth/login', 'localhost:4176', { ...params,
    login: `local-nonexistent-${randomUUID()}@example.invalid`, password: 'not-an-account-password', remember: false })
  assert.equal(result.status, 401); assert.equal(result.body.code, 'auth_credentials_invalid')
  assert.equal(result.headers['set-cookie'], undefined)
  checks.push({ name: 'nonexistent-credentials', status: 401, sessionCookieCreated: false })
  await redis.del(`auth:v4:login:${state}`); state = undefined
  const report = { kind: 'local-account-api-smoke/v1', observedAt: new Date().toISOString(), redis: { host: env.REDIS_HOST, port: Number(env.REDIS_PORT), version, ping: 'PONG' },
    api: 'http://127.0.0.1:3010', checks, ownLoginTransactionRemoved: true,
    scope: 'Real local API with Redis and development MySQL from server/.env. No successful login, browser flow, account selection, observer grant or terminal execution proof.' }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ checks: checks.length, redisVersion: version, ownLoginTransactionRemoved: true }))
} catch {
  await output.writeFile(JSON.stringify({ failed: true, phase, code: 'local_account_api_smoke_failed' }) + '\n'); await output.sync()
  console.error('local_account_api_smoke_failed'); process.exitCode = 1
} finally {
  if (redis) { if (state) await redis.del(`auth:v4:login:${state}`).catch(() => {}); redis.disconnect() }
  await output.close()
}
