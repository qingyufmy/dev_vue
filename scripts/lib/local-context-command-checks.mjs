import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Called only after the private fixture has authenticated and all three directories are empty.
export async function verifyLocalContextCommands(request, userId, checks) {
  const session = await request(4174, '/api/v4/session')
  assert.equal(session.status, 200)
  assert.equal(session.body.data.user.id, String(userId))
  const csrf = session.body.data.csrf_token
  const current = async () => {
    const response = await request(4174, '/api/v4/trading-context')
    assert.equal(response.status, 200)
    const value = response.body.data
    assert.equal(value.user_id, String(userId))
    assert.equal(value.mode, 'blocked')
    assert.equal(value.account_id, null)
    assert.equal(value.observer_channel_id, null)
    assert.equal(value.read_only, true)
    assert.match(value.revision, /^(0|[1-9][0-9]*)$/)
    return value
  }
  const initial = await current()
  const revision = BigInt(initial.revision)
  const leave = (key, prior, token = csrf) => request(4174,
    `/api/v4/trading-context/observer?expected_revision=${prior}`, undefined, token,
    { method: 'DELETE', headers: { 'Idempotency-Key': key } })
  const receipt = async key => {
    const result = await request(4174, `/api/v4/trading-context/commands/${key}`)
    assert.equal(result.status, 200)
    return result.body.data
  }
  const deniedKey = randomUUID()
  assert.equal((await leave(deniedKey, revision, '')).status, 403)
  assert.equal(await receipt(deniedKey), null)
  assert.equal((await current()).revision, initial.revision)
  checks.push({ name: 'missing-csrf-does-not-write', passed: true })

  const firstKey = randomUUID()
  const first = await leave(firstKey, revision)
  assert.equal(first.status, 200)
  assert.equal(first.body.data.revision, String(revision + 1n))
  assert.deepEqual((await leave(firstKey, revision)).body.data, first.body.data)
  const confirmed = await receipt(firstKey)
  assert.equal(confirmed.request_id, firstKey)
  assert.equal(confirmed.prior_revision, String(revision))
  assert.deepEqual(confirmed.result, first.body.data)
  assert.match(confirmed.recorded_at, /^\d{4}-\d{2}-\d{2}T.*Z$/)
  checks.push({ name: 'commit-replay-and-utc-receipt', passed: true })

  const changed = await leave(firstKey, revision + 1n)
  assert.equal(changed.status, 409)
  assert.equal(changed.body.code, 'trading_context_idempotency_conflict')
  const staleKey = randomUUID()
  const stale = await leave(staleKey, revision)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'revision_conflict')
  assert.equal(await receipt(staleKey), null)
  checks.push({ name: 'changed-body-and-stale-revision-rejected', passed: true })

  const sameKey = randomUUID()
  const same = await Promise.all([leave(sameKey, revision + 1n), leave(sameKey, revision + 1n)])
  assert.ok(same.every(result => result.status === 200))
  assert.deepEqual(same[0].body.data, same[1].body.data)
  assert.equal(same[0].body.data.revision, String(revision + 2n))
  checks.push({ name: 'concurrent-same-key-one-revision', passed: true })

  const keys = [randomUUID(), randomUUID()]
  const competing = await Promise.all(keys.map(key => leave(key, revision + 2n)))
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409])
  const rejectedIndex = competing.findIndex(result => result.status === 409)
  assert.equal(competing[rejectedIndex].body.code, 'revision_conflict')
  assert.equal(await receipt(keys[rejectedIndex]), null)
  assert.equal((await current()).revision, String(revision + 3n))
  checks.push({ name: 'concurrent-different-keys-one-winner', passed: true })

  // Read an old command after newer writes: recovery must not roll back the current projection.
  assert.equal((await receipt(firstKey)).result.revision, String(revision + 1n))
  assert.equal((await current()).revision, String(revision + 3n))
  checks.push({ name: 'historical-receipt-kept-separate-from-current-context', passed: true })
  return { priorRevision: String(revision), finalRevision: String(revision + 3n), committedCommands: 3,
    retained: 'synthetic-user context and audit receipts', businessAccountWrites: 0 }
}
