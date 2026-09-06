import { expect, it } from 'vitest'
import { hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { createPaymentMatchBackfill } from '../scripts/lib/v4-payment-match-backfill.mjs'
import { prepareBatch } from '../scripts/lib/v4-payment-match-backfill-contract.mjs'
import { createPaymentOrderWriter } from '../scripts/lib/mysql-payment-order-writer.mjs'
import { paymentMatchFixture } from './fixtures/payment-match-fixture.mjs'

function setup() {
  const f = paymentMatchFixture(), p = createPaymentMatchBackfill([f.watch], [f.order], f.options, { batchSize: 1 })
  const spec = { runId: p.runId, admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror',
    targetServerUuid: p.runId, snapshotHash: p.sourceHash, schemaHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64),
    transformHash: p.transformHash, storageMode: 'inplace-payment-match-v1', streams: [p.stream] } }
  return { f, p, spec }
}
it('binds the full watch, parent source, asset and both time resolutions to batch evidence', () => {
  const { f, p, spec } = setup(), row = p.batches[0].rows[0]
  expect(prepareBatch(spec, p.batches[0]).requestHash).toBe(hash(p.batches[0]))
  const evidence = p.sourceEvidence(streamIdentity(p.stream), row)
  expect(evidence.source).toEqual(f.watch)
  expect(evidence.orderSource).toEqual(f.order)
  expect(evidence.basisRecord).toEqual(f.options.basis.records[0])
  expect(evidence.parentTimeResolutions).toEqual(f.options.orderOptions.timeBasis.resolutions)
  expect(evidence.parentTimeBasisHash).toBe(hash(f.options.orderOptions.timeBasis))
  expect(row.idMaps[0]).toMatchObject({ entityKind: 'payment-match', sourceTable: 'crypto_watch_list', target: { table: 'payment_matches' } })
})
it('rejects altered evidence even when callers recalculate public hashes', async () => {
  const { p } = setup(), row = p.batches[0].rows[0]
  row.payload.parentTimeResolutions[0].offsetMinutes = 180
  row.transformedHash = hash({ payload: row.payload, targets: row.targets })
  expect(() => p.sourceEvidence(streamIdentity(p.stream), row)).toThrow('payment_match_batch_row_changed')
  await expect(p.writer.write({}, row)).rejects.toThrow('payment_match_batch_row_changed')
  expect(() => p.sourceEvidence('wrong', row)).toThrow('payment_match_evidence_stream')
})
it('limits batches to the watch stream and match target', () => {
  const { p, spec } = setup(), batch = structuredClone(p.batches[0])
  batch.rows[0].targets[0].table = 'payment_orders'
  expect(() => prepareBatch(spec, batch)).toThrow('backfill_inplace_target_invalid')
  spec.bindings.streams[0].sourceTable = 'orders'
  expect(() => prepareBatch(spec, batch)).toThrow('backfill_payment_match_stream_invalid')
})
it('batch writer requires the committed parent and never creates one', async () => {
  const { f, p } = setup(), calls = [], data = new Map()
  let parent = null
  const db = { async execute(sql, values) {
    calls.push(sql)
    if (sql.includes('FROM payment_orders')) return [parent ? [{ ...parent }] : []]
    if (sql.startsWith('INSERT')) {
      const columns = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',')
      data.set(values[0], Object.fromEntries(columns.map((field, i) => [field, values[i]])))
      return [{ affectedRows: 1 }]
    }
    return [data.has(values[0]) ? [{ ...data.get(values[0]) }] : []]
  } }
  const row = p.batches[0].rows[0]
  await expect(p.writer.write(db, row)).rejects.toThrow('payment_order_writer_not_committed')
  expect(calls.some(sql => sql.startsWith('INSERT'))).toBe(false)
  parent = createPaymentOrderWriter([f.order], f.options.orderOptions).prepared.entries[0].target
  expect(await p.writer.write(db, row)).toEqual({ transformedHash: row.transformedHash })
  await p.writer.write(db, row)
  expect(calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1)
  expect(calls.find(sql => sql.startsWith('INSERT'))).toContain('INSERT INTO payment_matches')
})
