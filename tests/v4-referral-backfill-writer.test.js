import { expect, it } from 'vitest'
import { hash, streamIdentity, BackfillError } from '../scripts/lib/v4-backfill-contract.mjs'
import { createReferralBackfill } from '../scripts/lib/v4-referral-backfill-writer.mjs'
import { prepareBatch } from '../scripts/lib/v4-referral-backfill-contract.mjs'
import { referralSourceEvidence } from '../scripts/lib/mysql-referral-backfill.mjs'

const stamp = '2026-09-07T00:00:00.123Z'
const rows = ['2', '10'].map(id => ({ id, referral_code: "O'Brien", referred_by: null,
  referral_credit: '-0.00000001', created_at: null, updated_at: '2020-01-01 12:00:00' }))
function db() {
  const data = new Map(), calls = []
  return { data, calls, async execute(sql, values) {
    calls.push({ sql, values })
    if (sql.startsWith('INSERT')) {
      const columns = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',')
      const row = Object.fromEntries(columns.map((key, i) => [key, values[i]]))
      if (data.has(row.user_id)) throw new Error('duplicate')
      data.set(row.user_id, row); return [{ affectedRows: 1 }]
    }
    const row = data.get(values[0])
    return [row ? [{ ...row, updated_at_utc: row.updated_at_utc + '000' }] : []]
  } }
}
it('writes exact amounts and codes with parameters, then repeats without INSERT', async () => {
  const prepared = createReferralBackfill(rows, stamp, { batchSize: 1 }), store = db()
  for (const batch of prepared.batches) await prepared.writer.write(store, batch.rows[0])
  await prepared.writer.write(store, prepared.batches[0].rows[0])
  expect(store.calls.filter(c => c.sql.startsWith('INSERT'))).toHaveLength(2)
  expect(store.calls.every(c => !c.sql.includes("O'Brien"))).toBe(true)
  expect(store.data.get('2').referral_credit).toBe('-0.00000001')
  expect(prepared.batches[1].startCursor).toEqual(prepared.batches[0].endCursor)
})
it('rejects existing changed balances rather than overwriting', async () => {
  const p = createReferralBackfill(rows, stamp), store = db(), row = p.batches[0].rows[0]
  await p.writer.write(store, row)
  store.data.get('2').referral_credit = '1.00000000'
  await expect(p.writer.write(store, row)).rejects.toThrow('referral_writer_target_conflict')
  expect(store.calls.some(c => /UPDATE |DELETE |REPLACE /.test(c.sql))).toBe(false)
})
it('rejects tampering even when the caller recalculates its hashes', async () => {
  const p = createReferralBackfill(rows, stamp), row = p.batches[0].rows[0]
  row.payload.target.referral_credit = '2.00000000'
  row.transformedHash = hash({ payload: row.payload, targets: row.targets })
  await expect(p.writer.write(db(), row)).rejects.toThrow('referral_writer_row_mismatch')
})
it('preserves the exact source projection and registration provenance', () => {
  const p = createReferralBackfill(rows, stamp), row = p.batches[0].rows[0]
  const evidence = referralSourceEvidence(streamIdentity(p.stream), row)
  expect(evidence.source).toEqual(rows[0]); expect(evidence.historicalTimeConverted).toBe(false)
  row.payload.provenance.source.updated_at = null
  expect(() => referralSourceEvidence(streamIdentity(p.stream), row)).toThrow('backfill_referral_evidence_mismatch')
})
it('accepts only the referral storage mode, stream and target', () => {
  const p = createReferralBackfill(rows, stamp), h = 'a'.repeat(64)
  const spec = { runId: '11111111-1111-4111-8111-111111111111', admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', mirrorDatabase: 'mirror', targetDatabase: 'dev_vue',
    targetServerUuid: '11111111-1111-4111-8111-111111111111', snapshotHash: h, schemaHash: h, manifestHash: h,
    transformHash: p.transformHash, streams: [p.stream], storageMode: 'inplace-referral-v1' } }
  expect(prepareBatch(spec, p.batches[0]).requestHash).toBe(hash(p.batches[0]))
  const changed = structuredClone(p.batches[0]); changed.rows[0].targets[0].table = 'users'
  expect(() => prepareBatch(spec, changed)).toThrow('backfill_inplace_target_invalid')
  spec.bindings.storageMode = 'inplace-account-v2'
  expect(() => prepareBatch(spec, p.batches[0])).toThrow(BackfillError)
})
