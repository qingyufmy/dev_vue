import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import http from 'node:http'

// Requires a private, explicitly provisioned synthetic user; never accepts real credentials on argv.
const [fixturePath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && isAbsolute(fixturePath) && isAbsolute(destination) && fixturePath !== destination)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1')
assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0 && fixture.password.length >= 32)
const output = await open(destination, 'wx', 0o600)
const sessions = new Map()
const checks = []
let phase = 'start', failed = false

function request(port, path, body, csrf) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, path, method: data === null ? 'GET' : 'POST',
      headers: { Host: `localhost:${port}`, ...(sessions.has(port) ? { Cookie: sessions.get(port) } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(data === null ? {} : { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, res => {
      const chunks = []; let length = 0
      res.on('error', reject)
      res.on('data', chunk => { length += chunk.length; if (length > 1048576) res.destroy(Error('response_budget')); else chunks.push(chunk) })
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null })
        } catch { reject(Error('response_invalid')) }
      })
    })
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(Error('request_timeout'))); req.end(data)
  })
}
function remember(port, result) {
  const cookies = result.headers['set-cookie']
  assert.equal(cookies?.length, 1)
  assert.match(cookies[0], /HttpOnly/i)
  assert.doesNotMatch(cookies[0], /;\s*Domain=/i)
  sessions.set(port, cookies[0].split(';')[0])
}
try {
  let result = await request(4174, '/auth/start?next=%2F')
  assert.equal(result.status, 302)
  const authorize = new URL(result.headers.location)
  assert.equal(authorize.origin, 'http://localhost:4176')
  assert.equal(authorize.pathname, '/oauth/authorize')
  phase = 'login'
  result = await request(4176, '/api/v4/auth/login', { ...Object.fromEntries(authorize.searchParams), login: fixture.email, password: fixture.password, remember: false })
  assert.equal(result.status, 200); remember(4176, result)
  checks.push({ name: 'password-login-through-auth-proxy', status: 200 })
  const callback = new URL(result.body.data.redirect_to)
  assert.equal(callback.origin, 'http://localhost:4174')
  assert.equal(callback.pathname, '/auth/callback')
  phase = 'callback'
  result = await request(4174, callback.pathname + callback.search)
  assert.equal(result.status, 302); assert.equal(result.headers.location, '/'); remember(4174, result)
  checks.push({ name: 'code-exchange-through-trade-proxy', status: 302 })
  phase = 'session'
  result = await request(4174, '/api/v4/session')
  assert.equal(result.status, 200); assert.equal(result.body.data.user.id, String(fixture.userId))
  assert.equal(typeof result.body.data.csrf_token, 'string')
  checks.push({ name: 'authenticated-session-string-user-id', status: 200 })
  phase = 'account-reads'
  for (const path of ['/api/v4/trading-accounts', '/api/v4/observer-channels', '/api/v4/bridge/terminal-profiles']) {
    result = await request(4174, path)
    assert.equal(result.status, 200); assert.deepEqual(result.body.data.items, [])
    checks.push({ name: path, status: 200, items: 0 })
  }
} catch {
  failed = true
} finally {
  // Revoke only the sessions issued to this probe, retaining audit history and the reusable fixture.
  for (const port of [4174, 4176]) {
    if (!sessions.has(port)) continue
    try {
      const prefix = port === 4174 ? '/api/v4/session' : '/api/v4/auth'
      const sessionPath = port === 4174 ? prefix : prefix + '/session'
      const current = await request(port, sessionPath)
      assert.equal(current.status, 200)
      const logout = await request(port, prefix + '/logout', {}, current.body.data.csrf_token)
      assert.equal(logout.status, 204)
      // Keep sending the old cookie to prove server-side revocation.
      assert.equal((await request(port, sessionPath)).status, 401)
      checks.push({ name: `session-revocation-${port}`, logoutStatus: 204, replayStatus: 401 })
    } catch { failed = true; checks.push({ name: `session-revocation-${port}`, failed: true }) }
  }
  const report = { kind: 'local-account-sso/v1', observedAt: new Date().toISOString(), failed, phase, checks,
    scope: 'Real local Vite proxies, API, Redis and development MySQL using an existing synthetic user. Empty account reads only; no positive account/observer, browser, terminal or trading proof. Own sessions revoked; fixture and audit history retained.' }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close()
  console.log(JSON.stringify({ failed, phase, checks: checks.length }))
  if (failed) process.exitCode = 1
}
