import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinateObserverRegistrySeed, loadObserverRegistrySeed } from '../scripts/lib/observer-registry-seed.mjs'

const plan = { prior: { steps: [{ id: 'old', checksum: 'old' }] }, step: { id: 'new', checksum: 'new', sql: 'INSERT SEED' } }
function fixture(revision = null) {
  let committed = { history: [{ id: 'old', checksum: 'old', status: 'completed' }], registry: revision === null ? [] : [{ id: 1, revision }],
    counts: { sources: 0, channels: 0, grants: 0, operations: 0, events: 0 } }, pending
  let failLedger = false, loseAck = false, writes = 0
  const c = {
    async beginTransaction() { pending = structuredClone(committed) },
    async rollback() { pending = null },
    async commit() { committed = pending; pending = null; if (loseAck) throw Error('commit_ack_lost') },
    async query(sql) {
      if (sql.startsWith('SET TRANSACTION')) return []
      if (sql.includes('FROM database_upgrade_steps_v4')) return [pending.history]
      if (sql.includes('FROM observer_management_registry')) return [pending.registry]
      if (sql.includes('COUNT(*)')) return [[pending.counts]]
      if (sql === 'INSERT SEED') { writes++; pending.registry = [{ id: 1, revision: '0' }]; return [] }
      throw Error('unexpected SQL')
    },
    async execute() { writes++; if (failLedger) throw Error('ledger_failed'); pending.history.push({ id: 'new', checksum: 'new', status: 'completed' }); return [] },
  }
  return { c, state: () => committed, writes: () => writes, failLedger: () => { failLedger = true }, loseAck: () => { loseAck = true } }
}

test('registration retains the complete 165-step prior chain', async () => {
  const result = await loadObserverRegistrySeed(new URL('../', import.meta.url))
  assert.equal(result.prior.steps.length, 165); assert.equal(result.step.id, 'inplace_042_01_observer_management_registry_seed')
})
test('inspect writes nothing; apply seeds and journals once; repeated apply preserves revision', async () => {
  const f = fixture()
  assert.equal((await coordinateObserverRegistrySeed(f.c, plan)).state, 'pending'); assert.equal(f.writes(), 0)
  assert.equal((await coordinateObserverRegistrySeed(f.c, plan, { apply: true })).inserted, true)
  f.state().registry[0].revision = '17'
  const replay = await coordinateObserverRegistrySeed(f.c, plan, { apply: true })
  assert.equal(replay.revision, '17'); assert.equal(f.writes(), 2)
})
test('preexisting nonzero seed is preserved while recording the missing upgrade receipt', async () => {
  const f = fixture('29'); f.state().counts.operations = 29
  const result = await coordinateObserverRegistrySeed(f.c, plan, { apply: true })
  assert.equal(result.inserted, false); assert.equal(result.revision, '29'); assert.equal(f.writes(), 1)
})
test('missing registry with prior observer data or completed ledger rejects without writes', async () => {
  for (const field of ['sources', 'channels', 'grants', 'operations', 'events']) {
    const f = fixture(); f.state().counts[field] = 1
    await assert.rejects(coordinateObserverRegistrySeed(f.c, plan, { apply: true }), /observer_seed_missing_with_history/)
    assert.equal(f.writes(), 0)
  }
  const f = fixture(); f.state().history.push({ id: 'new', checksum: 'new', status: 'completed' })
  await assert.rejects(coordinateObserverRegistrySeed(f.c, plan, { apply: true }), /observer_seed_completed_row_missing/)
})
test('ledger failure rolls back the seed together with the new ledger row', async () => {
  const f = fixture(); f.failLedger()
  await assert.rejects(coordinateObserverRegistrySeed(f.c, plan, { apply: true }), /ledger_failed/)
  assert.deepEqual(f.state().registry, []); assert.equal(f.state().history.length, 1)
})
test('lost commit acknowledgement is resolved by inspection without replaying a write', async () => {
  const f = fixture(); f.loseAck()
  await assert.rejects(coordinateObserverRegistrySeed(f.c, plan, { apply: true }), /commit_ack_lost/)
  assert.equal((await coordinateObserverRegistrySeed(f.c, plan)).state, 'complete'); assert.equal(f.writes(), 2)
})
