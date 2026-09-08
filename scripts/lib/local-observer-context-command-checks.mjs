import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function verifyLocalObserverContextCommands(request, userId, observer, checks) {
  const session = await request(4174, '/api/v4/session')
  assert.equal(session.status, 200); assert.equal(session.body.data.user.id, String(userId))
  const csrf = session.body.data.csrf_token
  const current = async () => {
    const response = await request(4174, '/api/v4/trading-context')
    assert.equal(response.status, 200); return response.body.data
  }
  const receipt = async key => {
    const response = await request(4174, `/api/v4/trading-context/commands/${key}`)
    assert.equal(response.status, 200); return response.body.data
  }
  const before = await current(), revision = BigInt(before.revision)
  assert.equal(before.mode, 'full'); assert.notEqual(before.account_id, observer.accountId)
  const forbiddenKey = randomUUID()
  const forbidden = await request(4174, '/api/v4/trading-context',
    { mode: 'full', account_id: observer.accountId, expected_revision: String(revision) }, csrf,
    { method: 'PUT', headers: { 'Idempotency-Key': forbiddenKey } })
  assert.equal(forbidden.status, 403); assert.equal(await receipt(forbiddenKey), null)
  assert.deepEqual(await current(), before)
  assert.equal((await request(4174, `/api/v4/trading-accounts/${observer.accountId}/snapshot`)).status, 403)
  checks.push({ name: 'observer-grant-does-not-confer-source-ownership', passed: true })
  const key = randomUUID()
  const body = { mode: 'observer', observer_channel_id: observer.channelId, expected_revision: String(revision) }
  const enter = () => request(4174, '/api/v4/trading-context', body, csrf, { method: 'PUT', headers: { 'Idempotency-Key': key } })
  const entered = await enter()
  assert.equal(entered.status, 200); assert.equal(entered.body.data.mode, 'observer')
  assert.equal(entered.body.data.observer_channel_id, observer.channelId); assert.equal(entered.body.data.read_only, true)
  assert.equal(entered.body.data.revision, String(revision + 1n))
  assert.deepEqual((await enter()).body.data, entered.body.data)
  assert.deepEqual((await receipt(key)).result, entered.body.data)
  assert.deepEqual(await current(), entered.body.data)
  checks.push({ name: 'enter-assigned-observer-and-replay-same-command', passed: true })
  const source = await request(4174, `/api/v4/trading-accounts/${observer.accountId}/snapshot?observer_channel_id=${observer.channelId}`)
  assert.equal(source.status, 200)
  assert.equal(source.body.data.account.id, observer.accountId)
  assert.equal(source.body.data.account.trade_permission, false)
  assert.equal(source.body.data.account.terminal_profile_id, null)
  assert.equal(source.body.data.snapshot, null)
  assert.deepEqual(source.body.data.positions.items, [])
  assert.deepEqual(source.body.data.pending_orders.items, [])
  const wrongSource = await request(4174, `/api/v4/trading-accounts/${before.account_id}/snapshot?observer_channel_id=${observer.channelId}`)
  assert.equal(wrongSource.status, 403)
  checks.push({ name: 'observer-publication-matches-exact-source-and-is-read-only', passed: true })
  const leaveKey = randomUUID()
  const left = await request(4174, `/api/v4/trading-context/observer?expected_revision=${revision + 1n}`, undefined, csrf,
    { method: 'DELETE', headers: { 'Idempotency-Key': leaveKey } })
  assert.equal(left.status, 200); assert.equal(left.body.data.mode, 'full')
  assert.notEqual(left.body.data.account_id, observer.accountId)
  assert.equal(left.body.data.observer_channel_id, null)
  assert.equal(left.body.data.revision, String(revision + 2n))
  assert.deepEqual(await current(), left.body.data)
  assert.equal((await receipt(key)).result.mode, 'observer')
  checks.push({ name: 'leave-observer-restores-owned-context-without-replaying-old-result', passed: true })
  return { priorRevision: String(revision), finalRevision: String(revision + 2n), committedCommands: 2,
    channelId: observer.channelId, sourceAccountId: observer.accountId, restoredAccountId: left.body.data.account_id }
}
