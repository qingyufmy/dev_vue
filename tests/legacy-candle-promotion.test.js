import { expect, it, vi } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { legacyCandleRenameSql } from '../scripts/lib/legacy-candle-promotion.mjs'
import { loadLegacyCandlePromotion, prepareLegacyCandlePromotionProof, coordinateLegacyCandlePromotion } from '../scripts/lib/inplace-legacy-candle-promotion.mjs'
import { loadLegacyCandleBuildMigration } from '../scripts/lib/inplace-legacy-candle-build-migration.mjs'

const journal = step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:01Z' })
function fixture() {
  const base = { id: 'base', checksum: hash('base') }, step = { id: 'promotion', checksum: hash('promotion'), sql: legacyCandleRenameSql() }
  const plan = { prior: { steps: [base] }, priorRegistryHash: hash('prior'), step, steps: [base, step] }
  const identity = { database: 'restore', serverUuid: 'uuid' }
  const tables = ['database_upgrade_steps_v4', 'users', 'market_data_sources', 'market_candles', 'market_candles_build_v4', 'legacy_candle_mappings_v4', 'legacy_candle_backfill_v4'].map(name => ({ name,
    ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`, rows: 3, rowsSha256: hash(name) }))
  const proof = prepareLegacyCandlePromotionProof(plan, identity, tables, hash('backfill'), [{ path: 'tool', sha256: hash('tool') }])
  let history = [journal(base)], actual = structuredClone(proof.before)
  const store = { history: async () => structuredClone(history), proof: async () => structuredClone(proof), identity: async () => identity,
    verifyTools: vi.fn(async () => {}), verifyBackfillProof: vi.fn(async () => {}), verifyPrior: vi.fn(async () => {}), snapshot: async () => structuredClone(actual),
    begin: vi.fn(async () => { history.push({ ...journal(step), status: 'started', completedAt: null }) }),
    execute: vi.fn(async sql => { expect(sql).toBe(legacyCandleRenameSql()); actual = structuredClone(proof.after) }),
    complete: vi.fn(async () => { history[1] = journal(step) }),
  }
  return { plan, proof, store, get history() { return history }, set history(value) { history = value }, get actual() { return actual }, set actual(value) { actual = value } }
}

it('appends one immutable rename after the complete 163-step registry', async () => {
  const root = new URL('../', import.meta.url), prior = await loadLegacyCandleBuildMigration(root), plan = await loadLegacyCandlePromotion(root)
  expect(plan.steps).toHaveLength(164); expect(plan.steps.slice(0, 163)).toEqual(prior.steps)
  expect(plan.step.sql).toBe(legacyCandleRenameSql())
})
it('defaults to readonly and reenters a completed promotion without another rename', async () => {
  const f = fixture()
  expect(await coordinateLegacyCandlePromotion(f.store, f.plan)).toEqual({ status: 'pending', ddlCount: 0 })
  expect(f.store.execute).not.toHaveBeenCalled()
  expect(await coordinateLegacyCandlePromotion(f.store, f.plan, { apply: true })).toEqual({ status: 'applied', ddlCount: 1 })
  expect(await coordinateLegacyCandlePromotion(f.store, f.plan, { apply: true })).toEqual({ status: 'completed', ddlCount: 0 })
  expect(f.store.execute).toHaveBeenCalledTimes(1)
  expect(f.store.verifyPrior).toHaveBeenCalledWith('promoted', [journal(f.plan.prior.steps[0])])
})
for (const action of ['begin', 'execute', 'complete']) it(`recovers lost ${action} acknowledgement from observed state`, async () => {
  const f = fixture(), run = f.store[action].getMockImplementation()
  f.store[action].mockImplementationOnce(async (...args) => { await run(...args); throw Error('lost') })
  await expect(coordinateLegacyCandlePromotion(f.store, f.plan, { apply: true })).rejects.toThrow('_unknown')
  await coordinateLegacyCandlePromotion({ ...f.store }, f.plan, { apply: true })
  expect(f.store.execute).toHaveBeenCalledTimes(1)
})
for (const fault of ['unrecorded_after', 'unknown_history', 'prior_missing', 'schema_changed', 'backfill_changed', 'tool_changed']) it(`rejects ${fault}`, async () => {
  const f = fixture()
  if (fault === 'unrecorded_after') f.actual = structuredClone(f.proof.after)
  if (fault === 'unknown_history') f.history.push(journal({ id: 'unknown', checksum: hash('unknown') }))
  if (fault === 'prior_missing') f.history = []
  if (fault === 'schema_changed') f.actual[0].schemaSha256 = hash('changed')
  if (fault === 'backfill_changed') f.store.verifyBackfillProof.mockRejectedValue(Error('changed'))
  if (fault === 'tool_changed') f.store.verifyTools.mockRejectedValue(Error('changed'))
  await expect(coordinateLegacyCandlePromotion(f.store, f.plan, { apply: true })).rejects.toThrow()
  expect(f.store.execute).not.toHaveBeenCalled()
})
it('allows new V4 rows after completion but protects legacy rows, source identities and mapping receipts', async () => {
  const f = fixture(); await coordinateLegacyCandlePromotion(f.store, f.plan, { apply: true })
  f.actual.find(row => row.name === 'market_candles').rows++
  expect((await coordinateLegacyCandlePromotion(f.store, f.plan)).status).toBe('completed')
  for (const name of ['market_candles_legacy_v3', 'market_data_sources', 'legacy_candle_mappings_v4', 'legacy_candle_backfill_v4']) {
    const row = f.actual.find(row => row.name === name); row.rows++
    await expect(coordinateLegacyCandlePromotion(f.store, f.plan)).rejects.toThrow('completed_state_conflict')
    row.rows--
  }
})
it('does not complete the journal if the transformed historical verifier refuses the result', async () => {
  const f = fixture()
  f.store.verifyPrior.mockImplementation(async state => { if (state === 'promoted') throw Error('history_drift') })
  await expect(coordinateLegacyCandlePromotion(f.store, f.plan, { apply: true })).rejects.toThrow('history_drift')
  expect(f.store.complete).not.toHaveBeenCalled()
})
