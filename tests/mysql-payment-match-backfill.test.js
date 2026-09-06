import { expect, it, vi } from 'vitest'
import { canonical, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { MysqlPaymentMatchBackfillRepository } from '../scripts/lib/mysql-payment-match-backfill.mjs'
import { createPaymentMatchBackfill } from '../scripts/lib/v4-payment-match-backfill.mjs'
import { paymentMatchFixture } from './fixtures/payment-match-fixture.mjs'

function setup() {
  const f = paymentMatchFixture(), p = createPaymentMatchBackfill([f.watch], [f.order], f.options)
  const row = p.batches[0].rows[0], stream = streamIdentity(p.stream)
  const c = { query: vi.fn(async () => [[]]), execute: vi.fn(async sql => sql.startsWith('SELECT source_bytes')
    ? [[{ source_bytes_sha256: row.sourceHash, source_payload_json: canonical(p.sourceEvidence(stream, row)) }]] : [{ affectedRows: 1 }]),
  beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const repo = new MysqlPaymentMatchBackfillRepository({ getConnection: async () => c }, p.sourceEvidence)
  return { p, row, stream, c, repo, write: tx => tx.insertReceipt(p.runId, stream, p.batches[0].batchId, row) }
}
it('persists and reads back full source evidence on the receipt transaction connection', async () => {
  const { repo, write, c, p, stream, row } = setup()
  await repo.transaction(write)
  expect(c.execute.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['INSERT', 'INSERT', 'SELECT'])
  expect(c.execute.mock.calls[0][0]).toContain('data_migration_row_receipts')
  expect(c.execute.mock.calls[1][0]).toContain('data_migration_source_rows')
  expect(c.execute.mock.calls[1][1][4]).toBe(canonical(p.sourceEvidence(stream, row)))
  expect(c.commit).toHaveBeenCalledOnce()
})
it('rolls back a receipt when source evidence readback differs', async () => {
  const { repo, write, c } = setup()
  c.execute.mockImplementation(async sql => sql.startsWith('SELECT')
    ? [[{ source_bytes_sha256: 'wrong', source_payload_json: '{}' }]] : [{ affectedRows: 1 }])
  await expect(repo.transaction(write)).rejects.toThrow('backfill_payment_match_evidence_readback')
  expect(c.rollback).toHaveBeenCalledOnce()
  expect(c.commit).not.toHaveBeenCalled()
})
it('rejects another run before any receipt or evidence write', async () => {
  const { repo, c, stream, row } = setup()
  await expect(repo.transaction(tx => tx.insertReceipt('other', stream, 'batch', row))).rejects.toThrow('backfill_payment_match_run_mismatch')
  expect(c.execute).not.toHaveBeenCalled()
  expect(c.rollback).toHaveBeenCalledOnce()
})
