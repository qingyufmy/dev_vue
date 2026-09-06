import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { createPaymentMatchWriter } from '../scripts/lib/mysql-payment-match-writer.mjs'
import { createPaymentOrderWriter } from '../scripts/lib/mysql-payment-order-writer.mjs'
import { paymentMatchFactFields, reconcilePaymentMatchFacts } from '../scripts/lib/v4-payment-match-fact-audit.mjs'
import { paymentMatchFixture } from './fixtures/payment-match-fixture.mjs'

function setup() {
  const f = paymentMatchFixture(), writer = createPaymentMatchWriter([f.watch], [f.order], f.options)
  const parent = createPaymentOrderWriter([f.order], f.options.orderOptions).prepared.entries[0].target
  const data = new Map(), calls = []
  const db = { parent, data, calls, async execute(sql, values) {
    calls.push(sql)
    if (sql.includes('FROM payment_orders')) return [this.parent ? [{ ...this.parent }] : []]
    if (sql.startsWith('INSERT')) {
      const columns = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',')
      data.set(values[0], Object.fromEntries(columns.map((field, i) => [field, values[i]])))
      return [{ affectedRows: 1 }]
    }
    return [data.has(values[0]) ? [{ ...data.get(values[0]) }] : []]
  } }
  return { f, writer, db, entry: writer.prepared.entries[0] }
}
it('locks and verifies the parent before inserting a match, then repeats without INSERT', async () => {
  const { writer, db, entry } = setup()
  expect((await writer.write(db, entry)).applied).toBe(true)
  expect(db.calls[0]).toContain('FROM payment_orders')
  expect(db.calls[1]).toContain('FROM payment_matches')
  expect((await writer.write(db, entry, { verifyOnly: true })).applied).toBe(false)
  expect(db.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1)
})
it('refuses missing or changed parent rows before a child write', async () => {
  const a = setup(); a.db.parent = null
  await expect(a.writer.write(a.db, a.entry)).rejects.toThrow('payment_order_writer_not_committed')
  const b = setup(); b.db.parent.user_id = '3'
  await expect(b.writer.write(b.db, b.entry)).rejects.toThrow('payment_order_writer_target_conflict')
  expect([...a.db.calls, ...b.db.calls].some(sql => sql.startsWith('INSERT'))).toBe(false)
})
it('refuses missing verify-only rows and mismatched existing matching facts', async () => {
  const { writer, db, entry } = setup()
  await expect(writer.write(db, entry, { verifyOnly: true })).rejects.toThrow('payment_match_writer_not_committed')
  await writer.write(db, entry); db.data.get('20').expected_amount = '2.00000000'
  await expect(writer.write(db, entry)).rejects.toThrow('payment_match_writer_target_conflict')
  expect(db.calls.some(sql => /UPDATE |DELETE |REPLACE /.test(sql))).toBe(false)
})
it('rejects entry tampering even if its public target hash is recomputed', async () => {
  const { writer, db, entry } = setup(); entry.target.asset_contract = 'other'; entry.targetHash = hash(entry.target)
  await expect(writer.write(db, entry)).rejects.toThrow('payment_match_writer_input_changed')
  expect(db.calls).toHaveLength(0)
})
it('audits source facts independently and reports amount, wallet and owner differences', () => {
  const { f, entry } = setup(), row = Object.fromEntries(paymentMatchFactFields.map(field => [field, entry.target[field]]))
  expect(reconcilePaymentMatchFacts([f.watch], [f.order], [row], '+00:00').sourceFactsMatch).toBe(true)
  const audit = reconcilePaymentMatchFacts([f.watch], [f.order], [{ ...row, user_id: '3', expected_amount: '2', legacy_wallet_index: '1' }], '+00:00')
  expect(audit.differences.map(d => d.field)).toEqual(expect.arrayContaining(['user_id', 'expected_amount', 'legacy_wallet_index']))
  expect(audit.fullReconciliationComplete).toBe(false)
})
it('reports missing/extra rows and rejects duplicate legacy identities', () => {
  const { f, entry } = setup(), row = Object.fromEntries(paymentMatchFactFields.map(field => [field, entry.target[field]]))
  const audit = reconcilePaymentMatchFacts([f.watch], [f.order], [{ ...row, legacy_watch_id: '4' }], '+00:00')
  expect(audit.differences.map(d => d.code)).toEqual(['missing', 'unexpected'])
  expect(() => reconcilePaymentMatchFacts([f.watch], [f.order], [row, row], '+00:00')).toThrow('payment_match_audit_duplicate_legacy')
})
