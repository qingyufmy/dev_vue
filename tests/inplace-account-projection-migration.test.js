import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { loadObserverContextMigration } from '../scripts/lib/inplace-observer-context-migration.mjs'
import { loadAccountProjectionMigration } from '../scripts/lib/inplace-account-projection-migration.mjs'
import { splitSqlStatements } from '../scripts/lib/v4-migration-plan.mjs'

test('projection registry preserves 154 identities and excludes the legacy candle name collision', async () => {
  const root = new URL('../', import.meta.url)
  const prior = await loadObserverContextMigration(root), next = await loadAccountProjectionMigration(root)
  assert.equal(next.steps.length, 160)
  assert.deepEqual(next.steps.slice(0,154), prior.steps)
  assert.equal(new Set(next.steps.map(step => step.id)).size, 160)
  assert.equal(next.additions.some(step => step.table === 'market_candles'), false)
  const available = new Set(['users', 'trading_accounts', 'trading_account_ownership_intervals', 'terminal_profiles'])
  for (const step of next.additions) {
    for (const reference of step.sql.matchAll(/REFERENCES `?([a-z_]+)`? /g)) assert.ok(available.has(reference[1]), reference[1])
    available.add(step.table)
  }
  assert.deepEqual((await loadAccountProjectionMigration(root)).steps, next.steps)
})

test('incremental projections retain original V4 SQL semantics without seeding trusted facts', async () => {
  const root = new URL('../', import.meta.url), next = await loadAccountProjectionMigration(root)
  const sources = (await Promise.all(['20260903_003_trading_context_and_market_projection.sql', '20260905_020_account_projection_and_history_provenance.sql']
    .map(async name => splitSqlStatements(await readFile(new URL('server/db/migrations/'+name, root),'utf8'))))).flat()
  for (const step of next.additions) {
    const original = sources.find(sql => new RegExp('^CREATE TABLE (?:IF NOT EXISTS )?' + step.table + ' \\(').test(sql))
    assert.ok(original, step.table)
    assert.equal(step.sql, original.replace(new RegExp('^CREATE TABLE (?:IF NOT EXISTS )?' + step.table + ' \\('), 'CREATE TABLE `' + step.table + '` ('))
  }
})
