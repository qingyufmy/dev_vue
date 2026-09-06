import { expect, it } from 'vitest'
import { hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { sourceEvidencePayload, insertSourceEvidence } from '../scripts/lib/v4-source-row-evidence.mjs'
import { MysqlInplaceAccountBackfillRepository } from '../scripts/lib/mysql-inplace-account-backfill.mjs'
const stream = streamIdentity({ sourceTable: 'mt5_account_ownership_history', role: 'ownership-interval-grants-v1' })
const source = { id: '1', broker_server_key: 'BROKER', login_account: '00123', user_id: '1', trading_account_id: '2',
  started_at: '2020-01-01 00:00:00', ended_at: null, end_reason: null, created_at: '2020-01-01 00:00:00', updated_at: '2020-01-01 00:00:00' }
const row = () => ({ pk: [{ type: 'integer', value: '1' }], sourceHash: hash(source), payload: { provenance: { source: { ...source }, timeBasisHash: 'a'.repeat(64) } } })
it('preserves exact original fields, NULLs, leading zeros and the time basis', () => {
  const value = sourceEvidencePayload(stream, row())
  expect(value.source).toEqual(source); expect(value.timeBasisHash).toBe('a'.repeat(64))
  expect(() => sourceEvidencePayload('b'.repeat(64), row())).toThrow('backfill_source_evidence_stream_invalid')
})
it('rejects missing fields, changed original bytes and mismatched source IDs', () => {
  const missing = row(); delete missing.payload.provenance.source.end_reason
  expect(() => sourceEvidencePayload(stream, missing)).toThrow('backfill_shape_invalid')
  const changed = row(); changed.payload.provenance.source.login_account = '123'
  expect(() => sourceEvidencePayload(stream, changed)).toThrow('backfill_source_evidence_mismatch')
  const wrongId = row(); wrongId.pk[0].value = '2'
  expect(() => sourceEvidencePayload(stream, wrongId)).toThrow('backfill_source_evidence_mismatch')
})
it('readbacks canonical JSON and refuses a storage mismatch', async () => {
  let values
  const connection = { async execute(sql, input) {
    if (sql.startsWith('INSERT')) { values = input; return [{ affectedRows: 1 }] }
    return [[{ source_bytes_sha256: values[3], source_payload_json: values[4] }]]
  } }
  await insertSourceEvidence(connection, 'run', stream, row())
  expect(JSON.parse(values[4]).source.login_account).toBe('00123')
  connection.execute = async sql => sql.startsWith('INSERT') ? [{ affectedRows: 1 }]
    : [[{ source_bytes_sha256: '0'.repeat(64), source_payload_json: values[4] }]]
  await expect(insertSourceEvidence(connection, 'run', stream, row())).rejects.toThrow('backfill_source_evidence_readback_mismatch')
})
it('inserts evidence after its receipt on the same connection and rolls back when evidence fails', async () => {
  const calls = []
  const connection = { query: async () => [[]], beginTransaction: async () => {}, release() {}, destroy() {},
    commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'),
    async execute(sql) { calls.push(sql); if (sql.startsWith('INSERT INTO data_migration_source_rows')) throw Error('fixture_failure'); return [{ affectedRows: 1 }] } }
  const repository = new MysqlInplaceAccountBackfillRepository({ getConnection: async () => connection }, { sourceEvidence: true })
  const input = { ...row(), transformedHash: 'b'.repeat(64), targets: [{ table: 'trading_account_ownership_intervals', pk: [{ type: 'text', value: 'fixture' }] }] }
  await expect(repository.transaction(tx => tx.insertReceipt('run', stream, 'batch', input))).rejects.toThrow('backfill_storage_failed')
  expect(calls[0]).toContain('INSERT INTO data_migration_row_receipts')
  expect(calls[1]).toContain('INSERT INTO data_migration_source_rows')
  expect(calls.at(-1)).toBe('rollback'); expect(calls).not.toContain('commit')
})
