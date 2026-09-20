import test from 'node:test'
import assert from 'node:assert/strict'
import { hash } from './v4-backfill-contract.mjs'
import { legacyStrategyFields } from './v4-strategy-source-review.mjs'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'
import { createStrategySourceBatch } from './strategy-source-batch.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'

const options = { runId: '11111111-1111-1111-1111-111111111111', logicalSourceId: 'reference',
  bindings: { logicalSourceId: 'reference' }, sequence: 1, startCursor: null }
test('strategy v1 stream and batch hashes remain identical to the pre-extraction implementation', () => {
  const source = Object.fromEntries(legacyStrategyFields.map(field => [field, null])); source.id = '1'; source.version = '44'
  const roles = Object.fromEntries(['analysis', 'trader'].map((kind, i) => {
    const identity = strategyRoleLegacyIdentity('1', '44', kind), time = '2026-09-09 00:00:00.123'
    return [kind, { strategy: { id: String(i + 1), kind, scope: 'platform', owner_user_id: null, name: 'fixture', description: '', status: 'draft',
      active_version_id: String(i + 11), revision: '1', legacy_source_table: identity.sourceTable, legacy_id: identity.strategy.legacyId,
      created_at_utc: time, updated_at_utc: time, deleted_at_utc: null },
    version: { id: String(i + 11), strategy_id: String(i + 1), version_number: '44', prompt_text: 'fixture', prompt_sha256: 'a'.repeat(64),
      input_contract_version: 'fixture/v1', output_contract_version: 'fixture/v1', config_json: {}, created_by_user_id: '7',
      legacy_source_table: identity.sourceTable, legacy_id: identity.version.legacyId, created_at_utc: time } }]
  }))
  const batch = createStrategySourceBatch([{ source, sourceHash: hash(source), roles }], options)
  assert.equal(batch.batchId, '9b6d5c10c0d1e4f1ee88f8d8c71da0396877e1f04f496cde11a58cd257cb907d')
  assert.equal(batch.streamId, '4b5d5ec870df37dce90dc5c177016d93f8bf0ccb364a8c2fa8a2da1d6de80ca5')
})

const projectRow = entry => ({ pk: [{ type: 'integer', value: entry.source.id }], sourceHash: hash(entry.source),
  transformedHash: hash(entry.source), targets: [], source: entry.source })
const adapter = { sourceTable: 'strategy_subscriptions', role: 'fixture', errorPrefix: 'fixture',
  createWriter: () => ({ async write() {} }), projectRow }
test('bounded batch rejects empty, oversized, unordered and cursor-overlapping work', () => {
  assert.throws(() => createFrozenSourceBatch([], options, adapter), { code: 'fixture_batch_options' })
  assert.throws(() => createFrozenSourceBatch(Array.from({ length: 101 }, (_, i) => ({ source: { id: String(i + 1) } })), options, adapter), { code: 'fixture_batch_options' })
  assert.throws(() => createFrozenSourceBatch([{ source: { id: '2' } }, { source: { id: '1' } }], options, adapter), { code: 'fixture_batch_order' })
  assert.throws(() => createFrozenSourceBatch([{ source: { id: '1' } }], { ...options, startCursor: [{ type: 'integer', value: '1' }] }, adapter), { code: 'fixture_batch_order' })
  assert.throws(() => createFrozenSourceBatch([{ source: { id: '1', payload: 'x'.repeat(2 * 1024 * 1024) } }], options, adapter), { code: 'fixture_batch_byte_limit' })
})

function replayFixture(checkpoint) {
  const entry = { source: { id: '1' } }, row = projectRow(entry)
  let writes = 0
  const batch = createFrozenSourceBatch([entry], options, { ...adapter, createWriter: () => ({ async write(_, __, mode) {
    assert.equal(mode.verifyOnly, true); writes++
  } }) })
  const tx = { async findRun() { return { bindingsHash: hash(options.bindings), bindings: options.bindings } },
    async findBatch() { return { requestHash: batch.batchId, sequence: 1, rows: 1 } },
    async findCheckpoint() { return checkpoint }, connection: { async execute() { return [[{
      batch_id: batch.batchId, source_pk_json: row.pk, source_bytes_sha256: row.sourceHash, archive_sha256: row.sourceHash,
      transformed_sha256: row.transformedHash, targets_json: [], source_payload_json: row.source,
    }]] } } }
  return { batch, tx, writes: () => writes }
}
test('saved receipt cannot bypass a missing, regressed or inconsistent checkpoint', async () => {
  for (const checkpoint of [null, { sequence: 0, processedRows: '1', cursor: [{ type: 'integer', value: '1' }] },
    { sequence: 1, processedRows: '0', cursor: [{ type: 'integer', value: '1' }] },
    { sequence: 1, processedRows: '1', cursor: [{ type: 'integer', value: '2' }] },
    { sequence: 2, processedRows: '2', cursor: [{ type: 'integer', value: '1' }] }]) {
    const f = replayFixture(checkpoint)
    await assert.rejects(f.batch.execute(f.tx), { code: 'fixture_batch_checkpoint_conflict' })
    assert.equal(f.writes(), 0)
  }
})
test('replay remains valid when later batches have advanced the same stream', async () => {
  const f = replayFixture({ sequence: 2, processedRows: '2', cursor: [{ type: 'integer', value: '2' }] })
  assert.equal((await f.batch.execute(f.tx)).replayed, true)
  assert.equal(f.writes(), 1)
})
