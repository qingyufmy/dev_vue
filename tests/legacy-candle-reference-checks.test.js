import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyLegacyCandleReference } from '../scripts/lib/legacy-candle-reference-checks.mjs'

test('reference constraint writer rejects non-reference names before accessing MySQL', async () => {
  let calls = 0
  await assert.rejects(verifyLegacyCandleReference({ query() { calls++ } }, 'dev_vue'))
  assert.equal(calls, 0)
})
test('reference constraint writer rejects a mismatched selected database before mutation', async () => {
  const queries = []
  await assert.rejects(verifyLegacyCandleReference({ async query(sql) { queries.push(sql); return [[{ db: 'dev_vue' }]] } }, 'dev_vue_candle_reference_' + 'a'.repeat(24)))
  assert.deepEqual(queries, ['SELECT DATABASE() db'])
})
