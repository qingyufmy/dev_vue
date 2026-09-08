import assert from 'node:assert/strict'
import test from 'node:test'
import { loadLegacyCandlePromotion } from '../scripts/lib/inplace-legacy-candle-promotion.mjs'
import { loadTradingContextChanges } from '../scripts/lib/inplace-trading-context-changes.mjs'

test('context receipt registration appends one table without changing 164 historical steps', async () => {
  const root = new URL('../', import.meta.url)
  const previous = await loadLegacyCandlePromotion(root), next = await loadTradingContextChanges(root)
  assert.deepEqual(next.steps.slice(0, 164), previous.steps)
  assert.equal(next.steps.length, 165)
  assert.equal(new Set(next.steps.map(step => step.id)).size, 165)
  assert.deepEqual((await loadTradingContextChanges(root)).steps, next.steps)
  assert.deepEqual(next.additions.map(step => step.table), ['trading_context_changes_v4'])
  assert.doesNotMatch(next.additions[0].sql, /\b(?:IF NOT EXISTS|DROP TABLE|ALTER TABLE|RENAME TABLE|INSERT INTO)\b/)
})
