import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAccountRootMigration } from '../scripts/lib/inplace-account-root-migration.mjs'
import { loadTerminalRouteMigration } from '../scripts/lib/inplace-terminal-route-migration.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

const root = new URL('../', import.meta.url)
test('terminal route registry preserves historical identities and appends two separately journaled steps', async () => {
  const historical = await loadAccountRootMigration(root)
  const next = await loadTerminalRouteMigration(root)
  assert.equal(next.steps.length, 150)
  assert.deepEqual(next.steps.slice(0, 148), historical.steps)
  assert.equal(new Set(next.steps.map(step => step.id)).size, 150)
  assert.equal(next.priorRegistryHash, hash(historical.steps.map(({ id, checksum }) => ({ id, checksum }))))
  assert.deepEqual(next.additions.map(step => step.table), ['terminal_account_bindings', 'bridge_connection_sessions'])
  assert.equal(new Set(next.additions.map(step => step.checksum)).size, 2)
  assert.deepEqual((await loadTerminalRouteMigration(root)).steps, next.steps)
})
