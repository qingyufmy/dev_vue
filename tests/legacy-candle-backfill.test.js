import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { planLegacyCandleSources, planLegacyCandleConversion } from '../scripts/lib/legacy-candle-conversion.mjs'
import { backfillLegacyCandles, inspectLegacyCandleBackfill, validateLegacyCandleConversion } from '../scripts/lib/legacy-candle-backfill.mjs'

function fixture(empty = false) {
  const account = { entities: [{ targetAccountId: '1', brokerServerKey: 'DEMO', accountLogin: '42', platform: 'mt5', candidateKey: hash('account') }],
    mappings: [], settings: [{ targetAccountId: '1', sourceAccountId: '1', userId: '1' }] }
  account.mappingHash = hash(account)
  const source = planLegacyCandleSources([{ id: '1', userId: '1', server: 'Demo', login: '42' }], account)
  const row = { id: '1', source_id: '1', standard_symbol: 'XAUUSD', timeframe: 'M5', open_time_utc_msc: '1745600400123',
    open_price: '1234.1234567890', high_price: '1235', low_price: '1230', close_price: '1234', tick_volume: '42' }
  const plan = planLegacyCandleConversion(empty ? [] : [row, { ...row, id: '9', open_time_utc_msc: '1745600700123' },
    { ...row, id: '9007199254740993' }], source,
  { closedPolicy: 'legacy-closed-writer/v1', symbolPolicy: 'stored-standard-symbol/v1', writerHash: hash('writer'), revision: '1' })
  let data = null, orphan = false, fail = null, sourceChanged = false
  const commits = []
  const store = {
    async verifyPlan() { if (sourceChanged) throw Error('source_changed') },
    async readState() { return structuredClone(data) },
    async verifyEmpty() { if (orphan) throw Error('orphan_build_rows') },
    async applyBatch(_plan, previous, batch) {
      expect(previous.mappedRows).toBe(data?.mappings.length ?? 0)
      if (fail === 'before') { fail = null; throw Error('connection_lost') }
      const targets = new Map((data?.projections ?? []).map(row => [row.targetKeyHash, row]))
      for (const row of batch.projections) {
        if (targets.has(row.targetKeyHash)) expect(targets.get(row.targetKeyHash)).toEqual(row)
        targets.set(row.targetKeyHash, structuredClone(row))
      }
      data = { checkpoint: structuredClone(batch.checkpoint), status: 'filling',
        mappings: [...(data?.mappings ?? []), ...structuredClone(batch.mappings)], projections: [...targets.values()] }
      commits.push(batch.mappings.map(row => row.legacyCandleId))
      if (fail === 'after') { fail = null; throw Error('ack_lost') }
      if (fail === 'drift') sourceChanged = true
    },
    async markVerified() { data.status = 'verified'; if (fail === 'verify') { fail = null; throw Error('ack_lost') } },
  }
  return { plan, store, commits, setFail(value) { fail = value }, orphan() { orphan = true },
    mutate(fn) { fn(data) } }
}

it('defaults to inspection and atomically covers all legacy IDs across duplicate-key batches', async () => {
  const f = fixture()
  expect(await backfillLegacyCandles(f.store, f.plan)).toMatchObject({ status: 'pending', batches: 0 })
  expect(f.commits).toEqual([])
  expect(await backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 2 })).toMatchObject({ status: 'verified', batches: 2, mappedRows: 3, projectionRows: 2 })
  expect(f.commits).toEqual([['1', '9'], ['9007199254740993']])
  expect(await backfillLegacyCandles(f.store, f.plan, { apply: true })).toMatchObject({ status: 'verified', batches: 0 })
})

for (const failure of ['before', 'after']) it(`recovers ${failure}-commit uncertainty from actual persisted rows`, async () => {
  const f = fixture(); f.setFail(failure)
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 2 })).rejects.toThrow('commit_unknown')
  expect(await backfillLegacyCandles(f.store, f.plan)).toMatchObject({ mappedRows: failure === 'before' ? 0 : 2 })
  await backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 2 })
  expect(f.commits).toEqual([['1', '9'], ['9007199254740993']])
})

it('does not re-fill after a lost verified acknowledgement', async () => {
  const f = fixture(); f.setFail('verify')
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true })).rejects.toThrow('verify_unknown')
  expect(await backfillLegacyCandles(f.store, f.plan, { apply: true })).toMatchObject({ status: 'verified', batches: 0 })
  expect(f.commits).toHaveLength(1)
})

it('rejects persisted payload drift even when checkpoint counts match', async () => {
  const f = fixture(); await backfillLegacyCandles(f.store, f.plan, { apply: true })
  f.mutate(data => { data.projections[0].target.close_price = '9999.0000000000' })
  await expect(inspectLegacyCandleBackfill(f.store, f.plan)).rejects.toThrow('persisted_prefix_drift')
})

it('rejects a prefix hole, foreign checkpoint and orphan build rows', async () => {
  const f = fixture(); f.setFail('after')
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 2 })).rejects.toThrow('commit_unknown')
  f.mutate(data => { data.mappings[0] = f.plan.mappings[2] })
  await expect(inspectLegacyCandleBackfill(f.store, f.plan)).rejects.toThrow('persisted_prefix_drift')
  f.mutate(data => { data.checkpoint.planHash = hash('other') })
  await expect(inspectLegacyCandleBackfill(f.store, f.plan)).rejects.toThrow('foreign_plan')
  const g = fixture(); g.orphan()
  await expect(backfillLegacyCandles(g.store, g.plan, { apply: true })).rejects.toThrow('orphan_build_rows')
})

it('stops if source verification changes between batches', async () => {
  const f = fixture(); f.setFail('drift')
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 1 })).rejects.toThrow('source_changed')
  expect(f.commits).toEqual([['1']])
})

it('verifies an empty source explicitly and rejects invalid plans and batch budgets', async () => {
  const f = fixture(true)
  expect(await backfillLegacyCandles(f.store, f.plan, { apply: true })).toMatchObject({ status: 'verified', mappedRows: 0, projectionRows: 0 })
  expect(() => validateLegacyCandleConversion({ ...f.plan, mappingHash: hash('tampered') })).toThrow('plan_hash')
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 501 })).rejects.toThrow('batch_size')
})
