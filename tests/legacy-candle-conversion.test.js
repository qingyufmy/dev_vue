import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { planLegacyCandleSources, planLegacyCandleConversion } from '../scripts/lib/legacy-candle-conversion.mjs'

function fixture() {
  const accounts = { entities: [{ targetAccountId: '1', brokerServerKey: 'BROKER-DEMO', accountLogin: '42', platform: 'mt5', candidateKey: hash('account') }], mappings: [],
    settings: [{ userId: '1', targetAccountId: '1', sourceAccountId: '1' }, { userId: '2', targetAccountId: '1', sourceAccountId: '2' }] }
  accounts.mappingHash = hash(accounts)
  const sources = [{ id: '5', userId: '1', server: 'Broker-Demo', login: '42' }, { id: '8', userId: '2', server: 'Broker-Demo', login: '42' }]
  const sourcePlan = planLegacyCandleSources(sources, accounts)
  const basis = { closedPolicy: 'legacy-closed-writer/v1', symbolPolicy: 'stored-standard-symbol/v1', writerHash: hash('writer'), revision: '1' }
  const first = { id: '9007199254740993', source_id: '5', standard_symbol: 'XAUUSD', timeframe: 'M5', open_time_utc_msc: '1745600400123',
    open_price: '1234.1234567890', high_price: '1235.0000000000', low_price: '1230.0000000000', close_price: '1234.1234567890',
    tick_volume: '42', broker_symbol: 'XAUUSD.a', broker_time: 'legacy text', spread: '7' }
  const second = { ...first, id: '4', source_id: '8', broker_symbol: 'XAUUSD.raw', spread: '8' }
  return { accounts, sources, sourcePlan, basis, first, second }
}

it('retains each old row mapping while coalescing identical projections deterministically', () => {
  const f = fixture(), result = planLegacyCandleConversion([f.first, f.second], f.sourcePlan, f.basis)
  expect(result).toMatchObject({ inputRows: 2, outputRows: 1, duplicateRows: 1 })
  expect(result.mappings.map(row => row.legacyCandleId)).toEqual(['4', '9007199254740993'])
  expect(result.mappings[0].sourceHash).not.toBe(result.mappings[1].sourceHash)
  expect(result.projections[0].representativeId).toBe('4')
  expect(result.projections[0].target).toMatchObject({ open_time_utc: '2025-04-25T17:00:00.123Z', open_price: '1234.1234567890', tick_volume: '42.00000000', closed: true, revision: '1' })
  expect(planLegacyCandleConversion([f.second, f.first], f.sourcePlan, f.basis)).toEqual(result)
})

it('does not merge distinct binary symbols or distinct candle times', () => {
  const f = fixture()
  expect(planLegacyCandleConversion([f.first, { ...f.second, standard_symbol: 'xauusd' }], f.sourcePlan, f.basis).outputRows).toBe(2)
  expect(planLegacyCandleConversion([f.first, { ...f.second, open_time_utc_msc: '1745600400124' }], f.sourcePlan, f.basis).outputRows).toBe(2)
})

for (const field of ['open_price', 'high_price', 'low_price', 'close_price', 'tick_volume']) it(`rejects duplicate keys with different ${field}`, () => {
  const f = fixture()
  expect(() => planLegacyCandleConversion([f.first, { ...f.second, [field]: '99' }], f.sourcePlan, f.basis)).toThrow('duplicate_payload_conflict')
})

for (const [field, value, code] of [
  ['id', '0', 'row_id'], ['source_id', '999', 'row_source_unmapped'], ['timeframe', 'M2', 'timeframe'],
  ['standard_symbol', ' XAUUSD', 'symbol'], ['open_time_utc_msc', '1745600400.123', 'utc_milliseconds'],
  ['open_time_utc_msc', '253402300800000', 'utc_milliseconds'], ['open_price', '1e3', 'decimal_invalid'],
  ['open_price', '100000000000000.0000000000', 'decimal_overflow'], ['tick_volume', '10000000000000000', 'decimal_overflow'],
]) it(`rejects unrepresentable ${field}=${value}`, () => {
  const f = fixture()
  expect(() => planLegacyCandleConversion([{ ...f.first, [field]: value }], f.sourcePlan, f.basis)).toThrow(code)
})

it('does not default missing platform, owner or ambiguous source identity', () => {
  const f = fixture()
  expect(() => planLegacyCandleSources([{ ...f.sources[0], userId: '3' }], f.accounts)).toThrow('source_owner_unresolved')
  const withoutPlatform = { ...f.accounts, entities: [{ ...f.accounts.entities[0], platform: null }] }
  withoutPlatform.mappingHash = hash({ entities: withoutPlatform.entities, mappings: withoutPlatform.mappings, settings: withoutPlatform.settings })
  expect(() => planLegacyCandleSources(f.sources, withoutPlatform)).toThrow('source_platform')
  const ambiguous = { ...f.accounts, entities: [...f.accounts.entities, { ...f.accounts.entities[0], platform: 'mt4', targetAccountId: '3' }] }
  ambiguous.mappingHash = hash({ entities: ambiguous.entities, mappings: ambiguous.mappings, settings: ambiguous.settings })
  expect(() => planLegacyCandleSources(f.sources, ambiguous)).toThrow('source_account_ambiguous')
})

it('requires explicit source and closure evidence and unique legacy row identities', () => {
  const f = fixture()
  expect(() => planLegacyCandleConversion([f.first], { ...f.sourcePlan, accountMappingHash: hash('other') }, f.basis)).toThrow('source_plan_hash')
  expect(() => planLegacyCandleConversion([f.first], f.sourcePlan, { ...f.basis, closedPolicy: 'guess-from-current-time' })).toThrow('basis')
  expect(() => planLegacyCandleConversion([f.first, f.first], f.sourcePlan, f.basis)).toThrow('row_id')
})
