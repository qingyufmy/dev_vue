import { expect, it } from 'vitest'
import { hash, validateSpec, prepareBatch } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareBackfillRun, executeBackfillBatch } from '../scripts/lib/v4-backfill-runner.mjs'
import { inplaceAccountTable } from '../scripts/lib/mysql-inplace-account-backfill.mjs'
function fixture() {
  const stream = { sourceTable: 'trading_accounts', role: 'account' }, pk = [{ type: 'integer', value: '1' }]
  const spec = { runId: '11111111-1111-1111-1111-111111111111', admission: { approved: true, blockers: [] },
    bindings: { logicalSourceId: 'dev_vue', sourceDatabase: 'dev_vue', mirrorDatabase: 'frozen', snapshotHash: 'a'.repeat(64),
      targetServerUuid: '22222222-2222-2222-2222-222222222222', targetDatabase: 'dev_vue', schemaHash: 'b'.repeat(64),
      manifestHash: 'c'.repeat(64), transformHash: 'd'.repeat(64), streams: [stream], storageMode: 'inplace-account-v1' } }
  const targets = [{ table: 'trading_accounts', pk }], payload = { value: 'fixture' }
  const batch = { batchId: hash('batch'), stream, sequence: 1, startCursor: null, endCursor: pk,
    rows: [{ pk, sourceHash: hash('source'), transformedHash: hash({ targets, payload }), targets, payload,
      idMaps: [{ entityKind: 'trading_account', sourceTable: 'trading_accounts', sourcePk: pk, target: targets[0] }] }] }
  return { spec, batch }
}
it('requires explicit same-database mode and a different frozen mirror', () => {
  const { spec } = fixture()
  expect(() => validateSpec(spec)).not.toThrow()
  delete spec.bindings.storageMode
  expect(() => validateSpec(spec)).toThrow('backfill_target_is_source')
  spec.bindings.storageMode = 'inplace-account-v1'; spec.bindings.mirrorDatabase = 'dev_vue'
  expect(() => validateSpec(spec)).toThrow('backfill_inplace_scope_invalid')
})
it('rejects unknown modes, source streams and writes outside the four logical targets', () => {
  const { spec, batch } = fixture()
  expect(() => prepareBatch(spec, batch)).not.toThrow()
  spec.bindings.storageMode = 'arbitrary'
  expect(() => validateSpec(spec)).toThrow('backfill_inplace_scope_invalid')
  spec.bindings.storageMode = 'inplace-account-v1'; spec.bindings.streams[0].sourceTable = 'users'
  expect(() => validateSpec(spec)).toThrow('backfill_inplace_stream_invalid')
  spec.bindings.streams[0].sourceTable = 'trading_accounts'; batch.rows[0].targets[0].table = 'users'
  expect(() => prepareBatch(spec, batch)).toThrow('backfill_inplace_target_invalid')
  expect(inplaceAccountTable('trading_accounts')).toBe('trading_accounts_v4_build')
  expect(() => inplaceAccountTable('users')).toThrow('backfill_inplace_target_invalid')
})
it('rejects a generic writer before entering an in-place transaction', async () => {
  const { spec, batch } = fixture()
  const repository = { transaction: () => { throw new Error('must_not_run') } }
  await expect(executeBackfillBatch(repository, spec, batch, { transformHash: spec.bindings.transformHash, write() {} }))
    .rejects.toThrow('backfill_writer_storage_mode_mismatch')
})
it('rejects a generic schema identity before preparing an in-place ledger run', async () => {
  const { spec } = fixture()
  const repository = { transaction: work => work({ targetIdentity: async () => ({ serverUuid: spec.bindings.targetServerUuid,
    database: spec.bindings.targetDatabase, schemaHash: spec.bindings.schemaHash }) }) }
  await expect(prepareBackfillRun(repository, spec)).rejects.toThrow('backfill_storage_mode_mismatch')
})
