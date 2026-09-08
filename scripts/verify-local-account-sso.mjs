import { verifyLocalContextCommands } from './lib/local-context-command-checks.mjs'
import { verifyLocalOwnedContextCommands } from './lib/local-owned-context-command-checks.mjs'
import { verifyLocalObserverContextCommands } from './lib/local-observer-context-command-checks.mjs'
import { createLocalObserverAccessControl } from './lib/local-observer-access-control.mjs'
import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import http from 'node:http'

// Requires a private, explicitly provisioned synthetic user; never accepts real credentials on argv.
const [fixturePath, destination, mode, intentPath, observerPath, operatorJournalPath, runtimeConfigPath] = process.argv.slice(2)
const contextCommands = mode === '--context-commands'
const realtime = mode === '--observer-realtime'
const observerRevocation = mode === '--observer-revocation' || realtime
const observerCommands = mode === '--observer-channel' || observerRevocation
const ownedCommands = mode === '--owned-accounts' || observerCommands
assert.ok((observerCommands ? process.argv.length === (realtime ? 9 : observerRevocation ? 8 : 7) && isAbsolute(intentPath) && isAbsolute(observerPath) && (!observerRevocation || isAbsolute(operatorJournalPath)) && (!realtime || isAbsolute(runtimeConfigPath)) : ownedCommands ? process.argv.length === 6 && isAbsolute(intentPath) : contextCommands ? process.argv.length === 5 : process.argv.length === 4 && mode === undefined) && isAbsolute(fixturePath) && isAbsolute(destination) && fixturePath !== destination)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1')
assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0 && fixture.password.length >= 32)
const intent = ownedCommands ? JSON.parse(await readFile(intentPath, 'utf8')) : null
if (intent) {
  assert.equal(intent.kind, 'local-owned-accounts-intent/v1'); assert.equal(intent.db, 'dev_vue')
  assert.equal(intent.userId, fixture.userId)
  assert.match(intent.brokerServer, /^V4-LOCAL-[a-f0-9-]{36}$/)
  assert.deepEqual(intent.logins, ['900000001', '900000002'])
}
const observer = observerCommands ? JSON.parse(await readFile(observerPath, 'utf8')) : null
if (observer) {
  assert.equal(observer.kind, 'local-observer-fixture/v1'); assert.equal(observer.passed, true)
  assert.equal(observer.identity.db, 'dev_vue'); assert.equal(observer.viewerUserId, fixture.userId)
  assert.notEqual(observer.actorUserId, fixture.userId)
  for (const id of [observer.accountId, observer.channelId]) assert.match(id, /^[1-9][0-9]{0,19}$/)
}
const output = await open(destination, 'wx', 0o600)
const sessions = new Map()
const checks = []
let phase = 'start', failed = false, contextResult = null, accessControl, realtimeFailure

function request(port, path, body, csrf, options = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? (data === null ? 'GET' : 'POST'),
      headers: { Host: `localhost:${port}`, ...(options.headers ?? {}), ...(sessions.has(port) ? { Cookie: sessions.get(port) } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...((options.method && options.method !== 'GET') || data !== null ? { Origin: `http://localhost:${port}` } : {}),
        ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, res => {
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
  if (observerRevocation) {
    phase = 'observer-fixture-control'
    accessControl = await createLocalObserverAccessControl(fixture, observer, operatorJournalPath, runtimeConfigPath)
  }
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
    assert.equal(result.status, 200)
    if (ownedCommands && path === '/api/v4/trading-accounts') {
      const items = result.body.data.items
      assert.equal(items.length, 2)
      assert.deepEqual(items.map(item => item.login).sort(), intent.logins)
      for (const item of items) {
        assert.equal(item.server, intent.brokerServer); assert.equal(item.trade_permission, false)
        assert.equal(item.bridge_state, 'offline'); assert.equal(item.terminal_profile_id, null)
      }
    } else if (observerCommands && path === '/api/v4/observer-channels') {
      assert.equal(result.body.data.items.length, 1)
      assert.equal(result.body.data.items[0].id, observer.channelId)
      assert.equal(result.body.data.items[0].source_account_id, observer.accountId)
    } else assert.deepEqual(result.body.data.items, [])
    checks.push({ name: path, status: 200, items: result.body.data.items.length })
  }
  if (contextCommands) {
    phase = 'context-commands'
    contextResult = await verifyLocalContextCommands(request, fixture.userId, checks)
  }
  if (ownedCommands) {
    phase = 'owned-context-commands'
    contextResult = await verifyLocalOwnedContextCommands(request, fixture.userId, intent, checks)
  }
  if (observerCommands) {
    phase = 'observer-context-commands'
    contextResult = { owned: contextResult, observer: await verifyLocalObserverContextCommands(request, fixture.userId, observer, checks, accessControl, realtime) }
  }
} catch (error) {
  failed = true
  realtimeFailure = error.localRealtime
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
  if (accessControl) {
    try { await accessControl.close() }
    catch { failed = true; checks.push({ name: 'observer-control-cleanup', failed: true }) }
  }
  const report = { kind: realtime ? 'local-observer-realtime-revocation/v1' : observerRevocation ? 'local-observer-revocation-http/v1' : observerCommands ? 'local-observer-account-context-http/v1' : ownedCommands ? 'local-owned-account-context-http/v1' : contextCommands ? 'local-account-context-http/v1' : 'local-account-sso/v1', observedAt: new Date().toISOString(), failed, phase, checks, contextResult, realtimeFailure, accessControl: accessControl?.report(),
    scope: realtime ? 'Exercises real HTTP, Vite WebSocket proxy, browser realtime role, Redis and dev_vue; individual checks determine completion. Publishes only the exact persisted synthetic revocation event via the compiled publisher; does not claim/ack outbox or run the dispatcher. Not Chrome UI, general dispatcher, lost ACK or terminal proof.' : observerRevocation ? 'Real local HTTP/API/Redis/dev_vue: observer revoke and explicit regrant via compiled management with durable keys, HTTP directory/context/publication denial and historical receipt isolation. Synthetic history retained; sessions revoked. No browser/realtime delivery, actual lost commit ACK or terminal proof.' : observerCommands ? 'Real local HTTP/API/Redis/dev_vue: owned account switching plus assigned observer entry/exit, source ownership rejection and publication scope isolation. Synthetic data and receipts retained; sessions revoked. No revocation, browser, lost commit ACK or terminal proof.' : ownedCommands ? 'Real local HTTP/API/Redis/dev_vue: two synthetic offline owned accounts, switching, replay, conflicts, CSRF and receipts. Context and history retained; own sessions revoked. No observer, browser, lost commit ACK or terminal proof.' : contextCommands ? 'Real local proxies/API/Redis/development MySQL: synthetic user blocked-context commands, replay, concurrency, CSRF and receipt reads. Context revisions and audit receipts retained; own sessions revoked. No positive owned-account/observer-channel, browser, lost MySQL commit ACK or terminal proof.' : 'Real local Vite proxies, API, Redis and development MySQL using an existing synthetic user. Empty account reads only; no positive account/observer, browser, terminal or trading proof. Own sessions revoked; fixture and audit history retained.' }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close()
  console.log(JSON.stringify({ failed, phase, checks: checks.length }))
  if (failed) process.exitCode = 1
}
