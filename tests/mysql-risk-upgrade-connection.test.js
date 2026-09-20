import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRiskUpgradeConnection } from '../scripts/lib/mysql-risk-structure-store.mjs'

function fixture(patch = {}, lock = '7', clients = 0) {
  const state = { db: 'dev_vue', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104', timezone: '+00:00', connectionId: 7, principal: 'root@localhost', ...patch }
  const calls = []
  return { state, calls, async query(sql) { calls.push(sql); return [[sql.includes('PROCESSLIST') ? { n: clients } : state]] },
    async execute(sql) { calls.push(sql); return [[{ owner: lock }]] } }
}
test('requires the current connection to own the upgrade lock and be the only client', async () => {
  const f = fixture()
  assert.equal((await assertRiskUpgradeConnection(f)).database, 'dev_vue')
  f.state.connectionId = 8
  await assert.rejects(assertRiskUpgradeConnection(f), /lock_lost/)
})
test('rejects another schema/server/timezone or an account without full client visibility', async () => {
  for (const patch of [{ db: 'other' }, { serverUuid: 'other' }, { timezone: 'SYSTEM' }, { principal: 'dev_vue@localhost' }]) {
    const f = fixture(patch)
    await assert.rejects(assertRiskUpgradeConnection(f), /identity|administrative_connection_required/)
    assert.equal(f.calls.length, 1)
  }
})
test('does not acquire a missing lock or disconnect another application client', async () => {
  for (const f of [fixture({}, null), fixture({}, '8'), fixture({}, '7', 1)]) {
    await assert.rejects(assertRiskUpgradeConnection(f), /lock_lost|other_clients/)
    assert.ok(f.calls.every(sql => sql.startsWith('SELECT ')))
  }
})
