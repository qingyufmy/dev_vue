import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { loadAccountProjectionMigration } from '../scripts/lib/inplace-account-projection-migration.mjs'
import { loadLegacyCandleBuildMigration } from '../scripts/lib/inplace-legacy-candle-build-migration.mjs'
import { splitSqlStatements } from '../scripts/lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
test('candle build appends three steps without altering the completed 160-step registry', async () => {
  const previous = await loadAccountProjectionMigration(root), next = await loadLegacyCandleBuildMigration(root)
  assert.deepEqual(next.steps.slice(0, 160), previous.steps)
  assert.equal(next.steps.length, 163)
  assert.equal(new Set(next.steps.map(step => step.id)).size, 163)
  assert.deepEqual(next.steps, (await loadLegacyCandleBuildMigration(root)).steps)
  const available = new Set(['trading_accounts', 'market_candles', 'market_data_sources'])
  for (const step of next.additions) {
    assert.match(step.sql, /^CREATE TABLE `/)
    assert.doesNotMatch(step.sql, /\b(?:IF NOT EXISTS|INSERT INTO|RENAME TABLE|DROP TABLE|ALTER TABLE)\b/)
    for (const match of step.sql.matchAll(/REFERENCES ([a-z_0-9]+) /g)) assert.ok(available.has(match[1]), match[1])
    available.add(step.table)
  }
})

test('candle build preserves the exact V4 target schema apart from its temporary name', async () => {
  const next = await loadLegacyCandleBuildMigration(root)
  const originals = splitSqlStatements(await readFile(new URL('server/db/migrations/20260903_003_trading_context_and_market_projection.sql', root), 'utf8'))
  const candle = originals.find(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS market_candles ('))
  assert.ok(candle)
  assert.equal(next.additions[1].sql, candle.replace('CREATE TABLE IF NOT EXISTS market_candles (', 'CREATE TABLE `market_candles_build_v4` ('))
})
