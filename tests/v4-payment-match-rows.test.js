import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { paymentMatchFixture as fixture } from './fixtures/payment-match-fixture.mjs'
import { preparePaymentMatchRows } from '../scripts/lib/v4-payment-match-rows.mjs'
it('uses order creation as the window start while preserving the independent watch timestamp and provenance', () => {
  const f = fixture(), result = preparePaymentMatchRows([f.watch], [f.order], f.options), entry = result.entries[0]
  expect(entry.target.window_start_at_utc).toBe('2026-09-06 04:00:00.000')
  expect(entry.target.created_at_utc).toBe('2026-09-06 04:00:05.000')
  expect(entry.target.expires_at_utc).toBe('2026-09-06 05:00:00.000')
  expect(entry.target.payment_order_id).toBe('10')
  expect(entry.provenance.source).toEqual(f.watch)
  expect(entry.provenance.orderSource).toEqual(f.order)
  expect(Object.keys(entry.target)).toHaveLength(21)
  expect(result.transactions).toEqual([])
  expect(result.activatesWatches).toBe(false)
})
it.each(['snapshot', 'sourceHash', 'address', 'contract', 'catalog', 'offset', 'window', 'duplicate'])('rejects mismatched or incomplete basis: %s', kind => {
  const f = fixture(), r = f.options.basis.records[0]
  if (kind === 'snapshot') f.options.basis.sourceSnapshotId = 'other'
  if (kind === 'sourceHash') r.sourceHash = 'd'.repeat(64)
  if (kind === 'address') r.address = 'other'
  if (kind === 'contract') r.assetContract = '非 ASCII'
  if (kind === 'catalog') f.options.evidenceCatalog.delete('asset')
  if (kind === 'offset') r.offsetMinutes = 900
  if (kind === 'window') r.offsetMinutes = 600
  if (kind === 'duplicate') f.options.basis.records.push({ ...r })
  expect(() => preparePaymentMatchRows([f.watch], [f.order], f.options)).toThrow('payment_match_')
})
it('does not manufacture a transaction from an existing source hash', () => {
  const f = fixture(); f.watch.tx_hash = 'observed'
  expect(() => preparePaymentMatchRows([f.watch], [f.order], f.options)).toThrow('payment_match_chain_evidence_required')
})
it('rejects an unverified TIMESTAMP session and keeps absent watch creation NULL', () => {
  const f = fixture(); f.options.sessionOffset = '+08:00'
  expect(() => preparePaymentMatchRows([f.watch], [f.order], f.options)).toThrow('payment_watch_utc_session_required')
  const g = fixture(); g.watch.created_at = null; g.options.basis.sourceHash = hash([g.watch]); g.options.basis.records[0].sourceHash = hash(g.watch)
  expect(preparePaymentMatchRows([g.watch], [g.order], g.options).entries[0].target.created_at_utc).toBeNull()
})
