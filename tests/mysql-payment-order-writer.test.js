import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { paymentOrderFields } from '../scripts/lib/v4-payment-order-source.mjs'
import { createPaymentOrderWriter } from '../scripts/lib/mysql-payment-order-writer.mjs'
import { paymentOrderFactFields, reconcilePaymentOrderFacts } from '../scripts/lib/v4-payment-order-fact-audit.mjs'
const source = { ...Object.fromEntries(Object.entries(paymentOrderFields).map(([key, [, nullable]]) => [key, nullable ? null : '0'])),
  id: '1', user_id: '2', order_no: "O'Brien", order_id: 'external', plan: 'plus', status: 'cancelled', currency: 'USD',
  amount: '300', amount_confirmed: '1', referral_credit_applied: '0', created_at: '2026-09-06 12:00:00' }
const options = () => ({ userIds: new Set(['2']), idMap: new Map([['1', '9']]),
  run: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
  evidenceCatalog: new Map([['fixture', 'b'.repeat(64)]]), timeBasis: { version: 'payment-order-time/v1', sourceTable: 'orders', sourceHash: hash([source]), sourceSnapshotId: 'fixture',
    resolutions: [{ sourceId: '1', sourceHash: hash(source), field: 'created_at', raw: source.created_at, offsetMinutes: 480, evidenceId: 'fixture', evidenceSha256: 'b'.repeat(64) }] } })
function database() {
  const data = new Map(), calls = []
  return { data, calls, async execute(sql, values) {
    calls.push(sql)
    if (sql.startsWith('INSERT')) {
      const fields = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',')
      const row = Object.fromEntries(fields.map((field, i) => [field, values[i]])); data.set(row.id, row)
      return [{ affectedRows: 1 }]
    }
    return [data.has(values[0]) ? [{ ...data.get(values[0]) }] : []]
  } }
}
it('inserts once using parameters then verifies an exact existing row without DML', async () => {
  const p = createPaymentOrderWriter([source], options()), db = database(), row = p.prepared.entries[0]
  expect((await p.write(db, row)).applied).toBe(true)
  expect((await p.write(db, row, { verifyOnly: true })).applied).toBe(false)
  expect(db.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1)
  expect(db.calls.some(sql => sql.includes("O'Brien") || /UPDATE |DELETE |REPLACE /.test(sql))).toBe(false)
})
it('refuses a conflicting existing row and a missing verify-only row', async () => {
  const p = createPaymentOrderWriter([source], options()), db = database(), row = p.prepared.entries[0]
  await expect(p.write(db, row, { verifyOnly: true })).rejects.toThrow('payment_order_writer_not_committed')
  expect(db.calls.some(sql => sql.startsWith('INSERT'))).toBe(false)
  await p.write(db, row); db.data.get('9').legacy_amount_confirmed = '300.00000000'
  await expect(p.write(db, row)).rejects.toThrow('payment_order_writer_target_conflict')
})
it('rejects modified prepared payload even with a recalculated public hash', async () => {
  const p = createPaymentOrderWriter([source], options()), row = p.prepared.entries[0], db = database()
  row.target.order_amount = '301.00000000'; row.targetHash = hash(row.target)
  await expect(p.write(db, row)).rejects.toThrow('payment_order_writer_input_changed')
  expect(db.calls).toHaveLength(0)
})
it('checks source facts independently and detects swapped independent amounts and ownership', () => {
  const p = createPaymentOrderWriter([source], options()), target = p.prepared.entries[0].target
  const actual = Object.fromEntries(paymentOrderFactFields.map(field => [field, target[field]]))
  expect(reconcilePaymentOrderFacts([source], [actual], new Set(['2'])).sourceFactsMatch).toBe(true)
  const result = reconcilePaymentOrderFacts([source], [{ ...actual, user_id: '3', order_amount: '1', legacy_amount_confirmed: '300' }], new Set(['2']))
  expect(result.differences.map(d => d.field)).toEqual(expect.arrayContaining(['user_id', 'order_amount', 'legacy_amount_confirmed']))
  expect(result.fullReconciliationComplete).toBe(false)
})
it('reports missing/extra source identities and refuses duplicate legacy rows', () => {
  const p = createPaymentOrderWriter([source], options()), target = p.prepared.entries[0].target
  const row = Object.fromEntries(paymentOrderFactFields.map(field => [field, target[field]]))
  const result = reconcilePaymentOrderFacts([source], [{ ...row, legacy_order_id: '7' }], new Set(['2']))
  expect(result.differences.map(d => d.code)).toEqual(['missing', 'unexpected'])
  expect(() => reconcilePaymentOrderFacts([source], [row, row], new Set(['2']))).toThrow('payment_order_audit_duplicate_legacy')
})
