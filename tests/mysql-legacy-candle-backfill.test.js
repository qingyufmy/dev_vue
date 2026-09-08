import { expect, it, vi } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { planLegacyCandleSources, planLegacyCandleConversion } from '../scripts/lib/legacy-candle-conversion.mjs'
import { backfillLegacyCandles, inspectLegacyCandleBackfill, validateLegacyCandleConversion } from '../scripts/lib/legacy-candle-backfill.mjs'

function planFixture(empty = false) {
  const account = { entities: [{ targetAccountId: '1', brokerServerKey: 'DEMO', accountLogin: '42', platform: 'mt5', candidateKey: hash('account') }],
    mappings: [], settings: [{ targetAccountId: '1', sourceAccountId: '1', userId: '1' }] }
  account.mappingHash = hash(account)
  const source = planLegacyCandleSources([{ id: '1', userId: '1', server: 'Demo', login: '42' }], account)
  const row = { id: '1', source_id: '1', standard_symbol: 'XAUUSD', timeframe: 'M5', open_time_utc_msc: '1745600400123',
    open_price: '1234.1234567890', high_price: '1235', low_price: '1230', close_price: '1234', tick_volume: '42' }
  const plan = planLegacyCandleConversion(empty ? [] : [row, { ...row, id: '9', open_time_utc_msc: '1745600700123' },
    { ...row, id: '9007199254740993' }], source,
  { closedPolicy: 'legacy-closed-writer/v1', symbolPolicy: 'stored-standard-symbol/v1', writerHash: hash('writer'), revision: '1' })
  return plan
}

import { mysqlLegacyCandleBackfillStore, decodeLegacyCandleProjection } from '../scripts/lib/mysql-legacy-candle-backfill.mjs'

function fixture(empty = false) {
  const plan = planFixture(empty)
  let db = { runs: [], candles: [], mappings: [] }, saved = null, fail = null
  const events = []
  const fields = ['trading_account_id', 'symbol', 'timeframe', 'open_time_utc', 'open_price', 'high_price', 'low_price', 'close_price', 'tick_volume', 'closed', 'revision']
  const connection = {
    async beginTransaction() { events.push('begin'); saved = structuredClone(db) },
    async commit() { events.push('commit'); saved = null; if (fail === 'commit') { fail = null; throw Error('ack_lost') } },
    async rollback() { events.push('rollback'); if (saved) db = saved; saved = null },
    async query(sql) {
      if (sql.startsWith('START TRANSACTION')) { saved = structuredClone(db); return [] }
      if (sql.includes('FROM legacy_candle_backfill_v4')) return [structuredClone(db.runs)]
      if (sql.includes('FROM market_candles_build_v4')) return [structuredClone(db.candles)]
      if (sql.includes('FROM legacy_candle_mappings_v4')) return [structuredClone(db.mappings)]
      throw Error('unexpected_query')
    },
    async execute(sql, p) {
      if (sql.startsWith('SELECT')) {
        const keys = []; for (let i = 0; i < p.length; i += 4) keys.push(JSON.stringify(p.slice(i, i + 4)))
        return [structuredClone(db.candles.filter(row => keys.includes(JSON.stringify(fields.slice(0, 4).map(field => row[field])))))]
      }
      events.push(sql.split(' ').slice(0, 3).join(' '))
      if (sql.startsWith('INSERT INTO legacy_candle_backfill_v4')) {
        db.runs.push({ id: 1, conversion_plan_hash: p[0], source_plan_hash: p[1], source_rows_hash: p[2], mapping_hash: p[3], projection_hash: p[4],
          expected_source_rows: String(p[5]), expected_projection_rows: String(p[6]), mapped_rows: '0', projection_rows: '0', last_legacy_id: '0', status: 'filling' })
      } else if (sql.startsWith('INSERT INTO market_candles_build_v4')) {
        for (let i = 0; i < p.length; i += 11) db.candles.push(Object.fromEntries(fields.map((field, j) => [field, p[i + j]])))
      } else if (sql.startsWith('INSERT INTO legacy_candle_mappings_v4')) {
        if (fail === 'mapping') throw Error('mapping_insert_failed')
        const names = ['legacy_candle_id', 'run_id', 'source_id', 'trading_account_id', 'symbol', 'timeframe', 'open_time_utc', 'target_key_hash', 'payload_hash', 'source_hash']
        for (let i = 0; i < p.length; i += 10) db.mappings.push(Object.fromEntries(names.map((field, j) => [field, p[i + j]])))
      } else if (sql.startsWith('UPDATE legacy_candle_backfill_v4 SET mapped_rows')) {
        if (fail === 'cas') return [{ affectedRows: 0 }]
        const run = db.runs[0]
        if (run.conversion_plan_hash !== p[3] || run.mapped_rows !== String(p[4]) || run.projection_rows !== String(p[5]) || run.last_legacy_id !== p[6]) return [{ affectedRows: 0 }]
        run.mapped_rows = String(p[0]); run.projection_rows = String(p[1]); run.last_legacy_id = p[2]
      } else if (sql.startsWith("UPDATE legacy_candle_backfill_v4 SET status='verified'")) db.runs[0].status = 'verified'
      else throw Error('unexpected_write')
      return [{ affectedRows: 1 }]
    },
  }
  const guards = { assertIdentity: vi.fn(async () => {}), verifySource: vi.fn(async () => plan.planHash) }
  const store = mysqlLegacyCandleBackfillStore(connection, plan, guards)
  return { plan, store, guards, events, get db() { return db }, fail(value) { fail = value } }
}

it('writes projection, mapping and checkpoint together and reuses a duplicate across batches', async () => {
  const f = fixture()
  expect(await backfillLegacyCandles(f.store, f.plan)).toMatchObject({ status: 'pending' })
  expect(f.events.filter(item => item.startsWith('INSERT'))).toEqual([])
  expect(await backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 2 })).toMatchObject({ status: 'verified', projectionRows: 2, mappedRows: 3 })
  expect(f.db.candles).toHaveLength(2); expect(f.db.mappings).toHaveLength(3)
  expect(f.guards.verifySource.mock.calls.filter(([, options]) => options.lock)).toHaveLength(3)
  const before = f.events.length
  await backfillLegacyCandles(f.store, f.plan, { apply: true })
  expect(f.events.slice(before).filter(item => item.startsWith('INSERT') || item === 'commit')).toEqual([])
})

for (const failure of ['mapping', 'cas']) it(`rolls the whole transaction back on ${failure} failure`, async () => {
  const f = fixture(); f.fail(failure)
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true })).rejects.toThrow('commit_unknown')
  expect(f.db).toEqual({ runs: [], candles: [], mappings: [] })
  expect(f.events).not.toContain('commit')
})

it('resumes from committed rows after COMMIT acknowledgement loss', async () => {
  const f = fixture(); f.fail('commit')
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 2 })).rejects.toThrow('commit_unknown')
  expect(f.db.mappings).toHaveLength(2)
  expect(await backfillLegacyCandles(f.store, f.plan, { apply: true, batchSize: 2 })).toMatchObject({ status: 'verified', batches: 1 })
  expect(f.db.mappings).toHaveLength(3)
})

it('refuses source changes under lock before inserting anything', async () => {
  const f = fixture()
  f.guards.verifySource.mockImplementation(async (_, { lock }) => lock ? hash('changed') : f.plan.planHash)
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true })).rejects.toThrow('commit_unknown')
  expect(f.db.runs).toEqual([]); expect(f.events.some(item => item.startsWith('INSERT'))).toBe(false)
})

it('requires the identity lock before transaction and again before commit', async () => {
  const f = fixture()
  f.guards.assertIdentity.mockRejectedValue(Error('lock_lost'))
  await expect(backfillLegacyCandles(f.store, f.plan, { apply: true })).rejects.toThrow('lock_lost')
  expect(f.events).toEqual([])
  const g = fixture()
  g.guards.assertIdentity.mockImplementation(async () => { if (g.db.mappings.length) throw Error('lock_lost') })
  await expect(backfillLegacyCandles(g.store, g.plan, { apply: true })).rejects.toThrow('commit_unknown')
  expect(g.db.runs).toEqual([])
})

it('rejects metadata and persisted target changes with matching row counts', async () => {
  const f = fixture(); await backfillLegacyCandles(f.store, f.plan, { apply: true })
  f.db.runs[0].source_rows_hash = hash('other')
  await expect(inspectLegacyCandleBackfill(f.store, f.plan)).rejects.toThrow('run_metadata')
  f.db.runs[0].source_rows_hash = f.plan.sourceRowsHash
  f.db.candles[0].close_price = '2.0000000000'
  await expect(inspectLegacyCandleBackfill(f.store, f.plan)).rejects.toThrow('persisted_prefix_drift')
})

it('normalizes DATETIME milliseconds and explicitly verifies an empty plan', async () => {
  const f = fixture(true)
  expect(await backfillLegacyCandles(f.store, f.plan, { apply: true })).toMatchObject({ status: 'verified', mappedRows: 0 })
  const row = { trading_account_id: '1', symbol: 'XAUUSD', timeframe: 'M5', open_time_utc: '2026-09-08 00:00:00',
    open_price: '1.0000000000', high_price: '1.0000000000', low_price: '1.0000000000', close_price: '1.0000000000', tick_volume: '1.00000000', closed: 1, revision: '1' }
  expect(decodeLegacyCandleProjection(row).target.open_time_utc).toBe('2026-09-08T00:00:00.000Z')
  expect(() => decodeLegacyCandleProjection({ ...row, closed: 2 })).toThrow('closed')
})
