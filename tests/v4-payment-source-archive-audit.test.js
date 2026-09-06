import { expect, it } from 'vitest'
import { hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { createPaymentOrderBackfill } from '../scripts/lib/v4-payment-order-backfill.mjs'
import { createPaymentMatchBackfill } from '../scripts/lib/v4-payment-match-backfill.mjs'
import { auditPaymentSourceArchives } from '../scripts/lib/v4-payment-source-archive-audit.mjs'
import { paymentMatchFixture } from './fixtures/payment-match-fixture.mjs'
function fixture() {
  const f = paymentMatchFixture()
  const order = createPaymentOrderBackfill([f.order], f.options.orderOptions)
  const match = createPaymentMatchBackfill([f.watch], [f.order], f.options)
  const archives = recipe => recipe.batches.flatMap(batch => batch.rows.map(row => ({ sourceId: row.payload.entry.sourceId,
    runId: recipe.runId, sourceHash: row.sourceHash, sourcePkHash: hash(row.pk), payload: recipe.sourceEvidence(streamIdentity(recipe.stream), row) })))
  return { orders: [f.order], watches: [f.watch], userIds: new Set(['2']), sessionOffset: '+00:00',
    sourceSnapshotId: 'fixture', orderRunId: order.runId, matchRunId: match.runId,
    orderArchives: archives(order), matchArchives: archives(match) }
}
it('independently verifies every original order and watch field without granting business acceptance', () => {
  const result = auditPaymentSourceArchives(fixture())
  expect(result).toMatchObject({ sourceValuesPreserved: true, orderFields: 23, watchFields: 13,
    historicalTimeValidated: false, deletionAuthorized: false, fullPaymentConverted: false })
})
it('detects alteration of each of the 36 source fields even with a recomputed stored hash', () => {
  for (const table of ['orderArchives', 'matchArchives']) for (const field of Object.keys(fixture()[table][0].payload.source)) {
    const f = fixture(), row = f[table][0]
    row.payload.source[field] = row.payload.source[field] === null ? '' : null
    row.sourceHash = hash(row.payload.source)
    expect(auditPaymentSourceArchives(f).differences).toContainEqual(expect.objectContaining({ field, code: 'source_value_mismatch' }))
  }
})
it('detects missing, extra, duplicate archives, wrong run and wrong primary-key binding', () => {
  const f = fixture(); f.orderArchives = []
  expect(auditPaymentSourceArchives(f).differences[0].code).toBe('missing')
  const g = fixture(); g.orderArchives.push({ ...g.orderArchives[0], sourceId: '9' })
  expect(auditPaymentSourceArchives(g).differences.some(d => d.code === 'unexpected')).toBe(true)
  const h = fixture(); h.orderArchives.push(h.orderArchives[0])
  expect(() => auditPaymentSourceArchives(h)).toThrow('payment_archive_duplicate_source')
  for (const field of ['runId', 'sourcePkHash']) {
    const a = fixture(); a.matchArchives[0][field] = 'wrong'
    expect(auditPaymentSourceArchives(a).sourceValuesPreserved).toBe(false)
  }
})
it('rejects snapshot scope and altered parent evidence independently of matching hashes', () => {
  const f = fixture(); f.matchArchives[0].payload.orderSource.crypto_confirmations = '99'
  expect(auditPaymentSourceArchives(f).differences.some(d => d.code === 'parent_source_mismatch')).toBe(true)
  const g = fixture(); g.matchArchives[0].payload.sourceSnapshotId = 'other'
  expect(auditPaymentSourceArchives(g).differences.some(d => d.code === 'payload_scope_mismatch')).toBe(true)
})
