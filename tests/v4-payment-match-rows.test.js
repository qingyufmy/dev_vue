import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { paymentOrderFields } from '../scripts/lib/v4-payment-order-source.mjs'
import { preparePaymentMatchRows } from '../scripts/lib/v4-payment-match-rows.mjs'
function fixture() {
  const order = { ...Object.fromEntries(Object.entries(paymentOrderFields).map(([key, [, nullable]]) => [key, nullable ? null : '0'])),
    id: '1', user_id: '2', order_no: 'old', order_id: 'external', plan: 'plus', status: 'expired', currency: 'USD', amount: '1', amount_confirmed: '1',
    referral_credit_applied: '0', created_at: '2026-09-06 12:00:00', crypto_chain: 'TRON', crypto_address: 'address', crypto_amount: '1',
    crypto_expires_at: '2026-09-06 13:00:00' }
  const watch = { id: '3', order_id: 'external', user_id: '2', chain: 'TRON', address: 'address', expected_amount: '1', status: 'expired',
    tx_hash: null, confirmations: '0', required_confirmations: '19', wallet_index: '0', created_at: '2026-09-06 04:00:05', expires_at: order.crypto_expires_at }
  const run = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture', registeredAtUtc: '2026-09-07T00:00:00.000Z' }
  const catalog = new Map([['time', 'b'.repeat(64)], ['asset', 'c'.repeat(64)]])
  const options = { orderOptions: { run, userIds: new Set(['2']), idMap: new Map([['1', '10']]), evidenceCatalog: catalog,
    timeBasis: { version: 'payment-order-time/v1', sourceTable: 'orders', sourceHash: hash([order]), sourceSnapshotId: 'fixture', resolutions: [
      { sourceId: '1', sourceHash: hash(order), field: 'created_at', raw: order.created_at, offsetMinutes: 480, evidenceId: 'time', evidenceSha256: 'b'.repeat(64) }] } },
    run, idMap: new Map([['3', '20']]), evidenceCatalog: catalog, sessionOffset: '+00:00',
    basis: { version: 'payment-match-basis/v1', sourceHash: hash([watch]), sourceSnapshotId: 'fixture', records: [{ sourceId: '3', sourceHash: hash(watch),
      chain: 'TRON', address: 'address', assetContract: 'fixture-contract', assetCode: 'USDT', assetEvidenceId: 'asset', assetEvidenceSha256: 'c'.repeat(64),
      expiresAtRaw: watch.expires_at, offsetMinutes: 480, timeEvidenceId: 'time', timeEvidenceSha256: 'b'.repeat(64) }] } }
  return { order, watch, options }
}
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
