import { expect, it } from 'vitest'
import { createReferralBackfill } from '../scripts/lib/v4-referral-backfill-writer.mjs'
import { canonical, hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { auditReferralLedger } from '../scripts/lib/v4-referral-ledger-audit.mjs'

function fixture() {
  const p = createReferralBackfill(['1', '12'].map(id => ({ id, referral_code: null, referred_by: null,
    referral_credit: '80.00000000', created_at: null, updated_at: null })), '2026-09-07T00:00:00.000Z', { batchSize: 1 })
  const spec = { runId: '11111111-1111-4111-8111-111111111111', admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'referral:fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror',
    targetServerUuid: '11111111-1111-4111-8111-111111111111', storageMode: 'inplace-referral-v1',
    snapshotHash: hash('snapshot'), schemaHash: hash('schema'), manifestHash: hash('manifest'), transformHash: p.transformHash, streams: [p.stream] } }
  const stream = streamIdentity(p.stream)
  const state = {
    data_migration_runs: [{ bindings_sha256: hash(spec.bindings), bindings_json: canonical(spec.bindings) }],
    data_migration_checkpoints: [{ stream_id: stream, sequence_number: '2', cursor_json: canonical(p.batches.at(-1).endCursor), processed_rows: '2' }],
    data_migration_batches: p.batches.map(b => ({ batch_id: b.batchId, stream_id: stream, sequence_number: b.sequence,
      request_sha256: hash(b), row_count: b.rows.length, end_cursor_json: canonical(b.endCursor) })),
    data_migration_id_maps: p.batches.flatMap(b => b.rows.flatMap(r => r.idMaps.map(m => ({ logical_source_id: spec.bindings.logicalSourceId,
      entity_kind: m.entityKind, source_table: m.sourceTable, source_pk_sha256: hash(m.sourcePk), source_pk_json: canonical(m.sourcePk),
      target_json: canonical(m.target), created_run_id: spec.runId })))) }
  const connection = { execute: async sql => { expect(sql.startsWith('SELECT ')).toBe(true); return [state[/FROM (\w+)/.exec(sql)[1]]] } }
  return { p, spec, state, connection }
}
it('independently verifies every run, batch, mapping and checkpoint', async () => {
  const f = fixture()
  expect(await auditReferralLedger(f.connection, f.spec, f.p)).toMatchObject({ mappingsVerified: 2, batchesVerified: 2, databaseWrites: 0 })
})
it.each([
  s => { s.data_migration_runs[0].bindings_sha256 = 'changed' },
  s => { s.data_migration_checkpoints[0].processed_rows = '1' },
  s => { s.data_migration_checkpoints[0].cursor_json = 'null' },
  s => { s.data_migration_batches[0].request_sha256 = 'changed' },
  s => { s.data_migration_batches.pop() },
  s => { s.data_migration_id_maps[0].target_json = s.data_migration_id_maps[1].target_json },
  s => { s.data_migration_id_maps[0].created_run_id = 'another' },
  s => { s.data_migration_id_maps.push(s.data_migration_id_maps[0]) },
])('rejects corrupted or incomplete persisted bookkeeping %#', async mutate => {
  const f = fixture(); mutate(f.state)
  await expect(auditReferralLedger(f.connection, f.spec, f.p)).rejects.toThrow('referral_audit_')
})
