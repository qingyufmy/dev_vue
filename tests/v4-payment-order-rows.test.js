import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { paymentOrderFields } from '../scripts/lib/v4-payment-order-source.mjs'
import { preparePaymentOrderRows } from '../scripts/lib/v4-payment-order-rows.mjs'
const source = () => ({ ...Object.fromEntries(Object.entries(paymentOrderFields).map(([key, [, nullable]]) => [key, nullable ? null : '0'])),
  id: '1', user_id: '2', order_no: 'order', order_id: 'external', plan: 'plus', period: 'monthly', status: 'paid',
  currency: 'USD', amount: '5', amount_confirmed: '0', referral_credit_applied: '5', created_at: '2026-09-06 12:00:00', paid_at: '2026-09-06 12:01:00' })
function options(row) {
  return { userIds: new Set(['2']), idMap: new Map([['1', '9007199254740993']]),
    run: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture-snapshot', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
    evidenceCatalog: new Map([['fixture-proof', 'b'.repeat(64)]]),
    timeBasis: { version: 'payment-order-time/v1', sourceTable: 'orders', sourceSnapshotId: 'fixture-snapshot', sourceHash: hash([row]),
      resolutions: ['created_at', 'paid_at'].filter(field => row[field] !== null).map(field => ({ sourceId: '1', sourceHash: hash(row), field, raw: row[field], offsetMinutes: 480, evidenceId: 'fixture-proof', evidenceSha256: 'b'.repeat(64) })) } }
}
it('prepares exact target fields, preserving zero, raw period and import side-effect boundary', () => {
  const row = source(), result = preparePaymentOrderRows([row], options(row)), entry = result.entries[0]
  expect(entry.target.id).toBe('9007199254740993')
  expect(entry.target.created_at_utc).toBe('2026-09-06 04:00:00.000')
  expect(entry.target.imported_at_utc).toBe('2026-09-07 00:00:00.000')
  expect(entry.target.legacy_amount_confirmed).toBe('0.00000000')
  expect(entry.target.billing_period_code).toBe('monthly')
  expect(entry.provenance.source).toEqual(row)
  expect(Object.keys(entry.target)).toHaveLength(23)
  expect(result.businessWritesEnabled).toBe(false)
  expect(result.balanceDeltaOnImport).toBe('0.00000000')
})
it.each(['snapshot', 'row_hash', 'raw', 'field', 'catalog', 'missing', 'duplicate', 'offset'])('rejects a stale, unapproved or incomplete time binding: %s', kind => {
  const row = source(), o = options(row), r = o.timeBasis.resolutions[0]
  if (kind === 'snapshot') o.timeBasis.sourceSnapshotId = 'other'
  if (kind === 'row_hash') r.sourceHash = 'c'.repeat(64)
  if (kind === 'raw') r.raw = '2026-09-06 13:00:00'
  if (kind === 'field') r.field = 'crypto_expires_at'
  if (kind === 'catalog') o.evidenceCatalog.clear()
  if (kind === 'missing') o.timeBasis.resolutions.pop()
  if (kind === 'duplicate') o.timeBasis.resolutions.push({ ...r })
  if (kind === 'offset') r.offsetMinutes = 841
  expect(() => preparePaymentOrderRows([row], o)).toThrow('payment_order_time_')
})
it('does not replace missing required historical dates with registration time', () => {
  for (const field of ['created_at', 'paid_at']) {
    const row = { ...source(), [field]: null }
    expect(() => preparePaymentOrderRows([row], options(row))).toThrow('payment_order_required_time_missing')
  }
})
it('allows absent paid time on cancelled orders and preserves an independent historical amount', () => {
  const row = { ...source(), status: 'cancelled', paid_at: null, amount: '300', amount_confirmed: '1', referral_credit_applied: '0' }
  const target = preparePaymentOrderRows([row], options(row)).entries[0].target
  expect(target.paid_at_utc).toBeNull()
  expect(target.order_amount).toBe('300.00000000')
  expect(target.legacy_amount_confirmed).toBe('1.00000000')
})
it('rejects a target ID outside the explicit source mapping and a changed source set', () => {
  const row = source(), o = options(row)
  o.idMap = new Map([['99', '1']])
  expect(() => preparePaymentOrderRows([row], o)).toThrow()
  const changed = { ...row, plan_label: 'changed' }
  expect(() => preparePaymentOrderRows([changed], options(row))).toThrow('payment_order_time_scope')
})
