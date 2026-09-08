import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

export async function openLocalObserverRealtime(request, userId, observer, checks) {
  const session = await request(4174, '/api/v4/session')
  assert.equal(session.status, 200); assert.equal(session.body.data.user.id, String(userId))
  const ticket = await request(4174, '/api/v4/realtime/tickets', {}, session.body.data.csrf_token)
  assert.equal(ticket.status, 201)
  assert.equal(ticket.body.data.ws_url, '/realtime/v4'); assert.equal(ticket.body.data.protocol, 'aurum.realtime.v4')
  const cookies = ticket.headers['set-cookie']
  assert.equal(cookies?.length, 1); assert.match(cookies[0], /^aurum_dev_realtime_ticket=/)
  assert.match(cookies[0], /HttpOnly/); assert.doesNotMatch(cookies[0], /;\s*Domain=/i)
  checks.push({ name: 'realtime-ticket-issued-through-authenticated-http', passed: true })
  const messages = [], errors = []
  let closed = null, phase = 'welcome'
  const socket = new WebSocket('ws://127.0.0.1:4174/realtime/v4', 'aurum.realtime.v4', {
    handshakeTimeout: 3000, origin: 'http://localhost:4174',
    headers: { Host: 'localhost:4174', Cookie: cookies[0].split(';')[0] },
  })
  socket.on('message', raw => {
    try {
      assert.ok(raw.length < 65536 && messages.length < 32)
      const message = JSON.parse(raw.toString()); messages.push(message)
      if (message.type === 'protocol.error') errors.push('protocol_error')
    }
    catch { errors.push('invalid_message'); socket.terminate() }
  })
  socket.on('error', () => { errors.push('socket_error') })
  socket.on('unexpected-response', (_request, response) => {
    errors.push(`http_${response.statusCode}`)
    response.resume(); socket.terminate()
  })
  socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() } })
  const wait = async predicate => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (errors.length) throw Object.assign(Error('local_realtime_socket_failed'), { localRealtime: { phase, errors: [...errors], closed } })
      const result = predicate()
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw Object.assign(Error('local_realtime_verification_timeout'), { localRealtime: { phase, errors: [...errors], closed } })
  }
  try {
    const welcome = await wait(() => messages.find(message => message.type === 'system.welcome'))
    assert.equal(welcome.session.user_id, String(userId))
    phase = 'subscribe'
    const requestId = randomUUID()
    socket.send(JSON.stringify({ v: 4, type: 'subscription.subscribe', request_id: requestId,
      targets: [{ kind: 'account', resource_id: 'metrics', trading_account_id: observer.accountId, observer_channel_id: observer.channelId, after_revision: null }] }))
    const ready = await wait(() => messages.find(message => message.type === 'subscription.ready' && message.request_id === requestId))
    assert.ok(ready.subscriptions.length > 0)
    for (const subscription of ready.subscriptions) {
      assert.equal(subscription.target.trading_account_id, observer.accountId)
      assert.equal(subscription.target.observer_channel_id, observer.channelId)
    }
    checks.push({ name: 'real-websocket-ticket-and-observer-subscription-through-vite-proxy', passed: true })
    return {
      async expectRevoked() {
        phase = 'revocation'
        const resync = await wait(() => messages.find(message => message.type === 'subscription.resync_required'))
        assert.equal(resync.reason, 'authorization_changed')
        const result = await wait(() => closed)
        assert.equal(result.code, 4003); assert.equal(result.reason, 'authorization_changed')
        checks.push({ name: 'persisted-revocation-event-via-redis-resyncs-and-closes-real-websocket', passed: true })
      },
      close() { socket.terminate() },
    }
  } catch (error) { socket.terminate(); throw error }
}
