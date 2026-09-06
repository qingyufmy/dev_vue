import { expect, it, vi } from 'vitest'
import { canonical, hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareBatch } from '../scripts/lib/v4-settings-backfill-contract.mjs'
import { createSettingsBackfill } from '../scripts/lib/v4-settings-backfill.mjs'
import { MysqlSettingsBackfillRepository } from '../scripts/lib/mysql-settings-backfill.mjs'
import { settingsFixture } from './fixtures/settings-fixture.mjs'
function setup() {
  const f = settingsFixture(), p = createSettingsBackfill([f.row], f.options), row = p.batches[0].rows[0], stream = streamIdentity(p.stream)
  const spec = { runId: p.runId, admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror',
    targetServerUuid: p.runId, snapshotHash: p.sourceHash, schemaHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64),
    transformHash: p.transformHash, storageMode: 'inplace-settings-v1', streams: [p.stream] } }
  const c = { query: vi.fn(async () => [[]]), execute: vi.fn(async sql => sql.startsWith('SELECT source_bytes')
    ? [[{ source_bytes_sha256: row.sourceHash, source_payload_json: canonical(p.sourceEvidence(stream, row)) }]] : [{ affectedRows: 1 }]),
  beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const repo = new MysqlSettingsBackfillRepository({ getConnection: async () => c }, p.sourceEvidence)
  return { f, p, row, stream, spec, c, repo, write: tx => tx.insertReceipt(p.runId, stream, p.batches[0].batchId, row) }
}
it('binds the eight source fields and complete resolution to the settings source key', () => {
  const { f, p, row, stream, spec } = setup()
  expect(prepareBatch(spec, p.batches[0]).requestHash).toBe(hash(p.batches[0]))
  expect(row.targets).toEqual([{ table: 'system_settings', pk: [{ type: 'integer', value: f.row.id }] }])
  expect(row.idMaps[0]).toMatchObject({ entityKind: 'settings', sourceTable: 'system_config' })
  expect(p.sourceEvidence(stream, row)).toMatchObject({ source: f.row, resolution: f.options.basis.resolutions[0], basisHash: hash(f.options.basis) })
})
it('rejects unrelated streams, target tables and rewritten resolution evidence', async () => {
  const { p, row, stream, spec } = setup()
  const changed = structuredClone(p.batches[0]); changed.rows[0].targets[0].table = 'system_config'
  expect(() => prepareBatch(spec, changed)).toThrow('backfill_inplace_target_invalid')
  expect(() => p.sourceEvidence('other', row)).toThrow('settings_evidence_stream')
  row.payload.resolution.createdAt.offsetMinutes = 180
  row.transformedHash = hash({ payload: row.payload, targets: row.targets })
  expect(() => p.sourceEvidence(stream, row)).toThrow('settings_batch_row_changed')
  await expect(p.writer.write({}, row)).rejects.toThrow('settings_batch_row_changed')
})
it('writes receipt and full evidence on the same connection and checks readback before commit', async () => {
  const { repo, write, c, p, row, stream } = setup()
  await repo.transaction(write)
  expect(c.execute.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['INSERT', 'INSERT', 'SELECT'])
  expect(c.execute.mock.calls[1][1][4]).toBe(canonical(p.sourceEvidence(stream, row)))
  expect(c.commit).toHaveBeenCalledOnce()
})
it('rolls back when source evidence differs and refuses another run before writes', async () => {
  const { repo, write, c } = setup()
  c.execute.mockImplementation(async sql => sql.startsWith('SELECT') ? [[{ source_bytes_sha256: 'wrong', source_payload_json: '{}' }]] : [{ affectedRows: 1 }])
  await expect(repo.transaction(write)).rejects.toThrow('backfill_settings_evidence_readback')
  expect(c.rollback).toHaveBeenCalledOnce(); expect(c.commit).not.toHaveBeenCalled()
  const second = setup()
  await expect(second.repo.transaction(tx => tx.insertReceipt('other', second.stream, 'batch', second.row))).rejects.toThrow('backfill_settings_run_mismatch')
  expect(second.c.execute).not.toHaveBeenCalled()
})
