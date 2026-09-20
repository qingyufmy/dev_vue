import test from 'node:test'
import assert from 'node:assert/strict'
import { hash } from './v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields } from './v4-strategy-source-review.mjs'
import { createStrategySourceArchiveBatch } from './strategy-source-archive-batch.mjs'

const options = { runId: '11111111-1111-1111-1111-111111111111', logicalSourceId: 'dev_vue', bindings: { logicalSourceId: 'dev_vue' }, sequence: 1, startCursor: null }
const entry = fields => { const source = Object.fromEntries(fields.map(field => [field, null])); source.id = '1'; return { source, sourceHash: hash(source) } }
test('rejects non-source tables, incomplete rows, numeric coercion and changed hashes', () => {
  assert.throws(() => createStrategySourceArchiveBatch('users', [], options), { code: 'strategy_archive_table_invalid' })
  for (const corrupt of [value => { delete value.source.title }, value => { value.source.version = 1 }, value => { value.source.title = 'changed' }]) {
    const value = entry(legacyStrategyFields); corrupt(value)
    assert.throws(() => createStrategySourceArchiveBatch('auto_prompt_types', [value], options))
  }
})
test('creates separate immutable streams for strategy and subscription preservation', () => {
  const value = entry(legacyStrategyFields), frozen = structuredClone(value)
  const first = createStrategySourceArchiveBatch('auto_prompt_types', [value], options)
  value.source.title = 'caller-changed'
  assert.equal(first.batchId, createStrategySourceArchiveBatch('auto_prompt_types', [frozen], options).batchId)
  assert.notEqual(first.streamId, createStrategySourceArchiveBatch('strategy_subscriptions', [entry(legacySubscriptionFields)], options).streamId)
})
test('locks and verifies the current source before any archive or receipt write', async () => {
  for (const [table, fields] of [['auto_prompt_types', legacyStrategyFields], ['strategy_subscriptions', legacySubscriptionFields]]) {
    const value = entry(fields), batch = createStrategySourceArchiveBatch(table, [value], options)
    const tx = { async findRun() { return { bindings: options.bindings, bindingsHash: hash(options.bindings) } },
      async findBatch() { return null }, async findCheckpoint() { return { sequence: 0, cursor: null, processedRows: '0' } },
      async insertBatch() {}, async findReceipt() { return null },
      async insertReceipt() { assert.fail('receipt written after source conflict') },
      connection: { async execute(sql, params) { assert.ok(sql.includes('FOR UPDATE')); assert.deepEqual(params, ['1']); return [[{ ...value.source, id: '2' }]] } } }
    await assert.rejects(batch.execute(tx), { code: 'strategy_archive_source_changed' })
  }
})
