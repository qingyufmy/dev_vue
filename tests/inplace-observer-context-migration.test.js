import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTerminalRouteMigration } from '../scripts/lib/inplace-terminal-route-migration.mjs'
import { loadObserverContextMigration } from '../scripts/lib/inplace-observer-context-migration.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

test('observer context registry preserves 150 executed steps and appends four dependency-ordered identities', async () => {
  const root = new URL('../', import.meta.url)
  const prior = await loadTerminalRouteMigration(root), next = await loadObserverContextMigration(root)
  assert.equal(next.steps.length, 154)
  assert.deepEqual(next.steps.slice(0, 150), prior.steps)
  assert.equal(new Set(next.steps.map(step => step.id)).size, 154)
  assert.equal(next.priorRegistryHash, hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))))
  assert.deepEqual(next.additions.map(step => step.table), ['observer_sources', 'observer_channels', 'observer_channel_accesses', 'trading_contexts'])
  const available = new Set(['users', 'strategies', 'trading_accounts'])
  for (const step of next.additions) {
    for (const reference of step.sql.matchAll(/REFERENCES `([a-z_]+)`/g)) assert.ok(available.has(reference[1]), reference[1])
    available.add(step.table)
  }
  assert.deepEqual((await loadObserverContextMigration(root)).steps, next.steps)
})
