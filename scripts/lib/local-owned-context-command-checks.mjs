import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function verifyLocalOwnedContextCommands(request, userId, intent, checks) {
  const session = await request(4174, '/api/v4/session')
  assert.equal(session.status, 200); assert.equal(session.body.data.user.id, String(userId))
  const csrf = session.body.data.csrf_token
  const directory = await request(4174, '/api/v4/trading-accounts')
  assert.equal(directory.status, 200)
  const accounts = directory.body.data.items.sort((a, b) => a.login.localeCompare(b.login))
  assert.equal(accounts.length, 2)
  assert.deepEqual(accounts.map(account => account.login), intent.logins)
  for (const account of accounts) assert.equal(account.server, intent.brokerServer)
  const [a, b] = accounts.map(account => account.id)
  const current = async () => {
    const response = await request(4174, '/api/v4/trading-context')
    assert.equal(response.status, 200); assert.equal(response.body.data.user_id, String(userId))
    assert.equal(response.body.data.read_only, true)
    return response.body.data
  }
  const select = (id, revision, key, token = csrf) => request(4174, '/api/v4/trading-context',
    { mode: 'full', account_id: id, expected_revision: String(revision) }, token,
    { method: 'PUT', headers: { 'Idempotency-Key': key } })
  const receipt = async key => {
    const response = await request(4174, `/api/v4/trading-context/commands/${key}`)
    assert.equal(response.status, 200); return response.body.data
  }
  const initial = await current(), revision = BigInt(initial.revision)
  const denied = randomUUID()
  assert.equal((await select(a, revision, denied, '')).status, 403)
  assert.equal(await receipt(denied), null); assert.deepEqual(await current(), initial)
  checks.push({ name: 'owned-switch-requires-csrf-without-changing-context', passed: true })
  const firstKey = randomUUID(), first = await select(a, revision, firstKey)
  assert.equal(first.status, 200); assert.equal(first.body.data.mode, 'full')
  assert.equal(first.body.data.account_id, a); assert.equal(first.body.data.read_only, true)
  assert.equal(first.body.data.revision, String(revision + 1n))
  assert.deepEqual((await select(a, revision, firstKey)).body.data, first.body.data)
  assert.deepEqual((await receipt(firstKey)).result, first.body.data)
  assert.deepEqual(await current(), first.body.data)
  checks.push({ name: 'select-first-owned-account-and-replay-one-revision', passed: true })
  const changed = await select(b, revision, firstKey)
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'trading_context_idempotency_conflict')
  const staleKey = randomUUID(), stale = await select(b, revision, staleKey)
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'revision_conflict')
  assert.equal(await receipt(staleKey), null)
  checks.push({ name: 'changed-account-body-and-stale-revision-rejected', passed: true })
  const secondKey = randomUUID()
  const second = await select(b, revision + 1n, secondKey)
  assert.equal(second.status, 200); assert.equal(second.body.data.account_id, b)
  assert.equal(second.body.data.revision, String(revision + 2n))
  assert.deepEqual(await current(), second.body.data)
  assert.equal((await receipt(firstKey)).result.account_id, a)
  assert.equal((await current()).account_id, b)
  checks.push({ name: 'switch-second-account-and-keep-historical-receipt-separate', passed: true })
  const keys = [randomUUID(), randomUUID()]
  const competing = await Promise.all([select(a, revision + 2n, keys[0]), select(b, revision + 2n, keys[1])])
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409])
  const winner = competing.find(result => result.status === 200)
  assert.equal(competing.find(result => result.status === 409).body.code, 'revision_conflict')
  assert.deepEqual(await current(), winner.body.data)
  assert.equal((await current()).revision, String(revision + 3n))
  assert.equal(await receipt(keys[competing.findIndex(result => result.status === 409)]), null)
  checks.push({ name: 'concurrent-account-switches-have-one-winner', passed: true })
  return { priorRevision: String(revision), finalRevision: String(revision + 3n), committedCommands: 3,
    accountIds: [a, b], finalAccountId: winner.body.data.account_id, retained: 'synthetic offline accounts, context and command receipts' }
}
