import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, it } from 'vitest'
import { assertQueryResultEnvelope, type BridgeGatewayRoute, type BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'
import { HistoryPageChain } from '../src/modules/trade-history/application/history-page-chain.js'
const schema = JSON.parse(readFileSync(new URL('../../contracts/bridge-v4.schema.json', import.meta.url), 'utf8'))
const validate = new Ajv2020({ strict: false }).compile({ $defs: schema.$defs, $ref: '#/$defs/QueryResponsePayload' })
const route = { userId: 7, accountId: '42', platform: 'mt5', timezoneOffsetMinutes: 180, terminalProfileId: 'profile_12345678',
  terminalInstanceId: 'terminal_12345678', brokerServer: 'Broker', login: '001', connectionEpoch: 3,
  connectionId: 'connection_12345678', sessionId: 'session_12345678' } satisfies BridgeGatewayRoute
const window = { rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000 }
function response(): BridgeQueryResponseEnvelope {
  return { v: 4, message_id: 'response_12345678', type: 'query.response', sent_at_utc_msc: 3000, correlation_id: 'message_12345678',
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: 3 },
    payload: { request_id: 'request_12345678', resource: 'history.deals', observed_at_utc_msc: 2500, source_revision: 'revision_1',
      source: 'local_projection', items: [], has_more: false, next_cursor: null,
      history_coverage: { version: 1, status: 'complete', range_start_utc_msc: 1000, range_end_utc_msc: 2000, source_revision: 'revision_1', collected_at_utc_msc: 2100 } } }
}
it('accepts explicit coverage and legacy omission in schema and receiver', () => {
  const value = response()
  expect(validate(value.payload)).toBe(true)
  expect(assertQueryResultEnvelope(value)).toBe(value)
  delete value.payload.history_coverage
  expect(validate(value.payload)).toBe(true)
  expect(assertQueryResultEnvelope(value).payload).not.toHaveProperty('history_coverage')
})
it.each([null, {}, { ...response().payload.history_coverage, version: 2 }, { ...response().payload.history_coverage, extra: true }])('rejects malformed coverage in schema and receiver', coverage => {
  const value = response()
  Object.assign(value.payload, { history_coverage: coverage })
  expect(validate(value.payload)).toBe(false)
  expect(() => assertQueryResultEnvelope(value)).toThrow('bridge_history_coverage_invalid')
})
it.each(['revision','future','end','instrument'])('rejects inconsistent coverage semantics: %s', kind => {
  const value = response(), coverage = value.payload.history_coverage!
  if (kind === 'revision') coverage.source_revision = 'other'
  if (kind === 'future') coverage.collected_at_utc_msc = 2501
  if (kind === 'end') coverage.range_end_utc_msc = 1000
  if (kind === 'instrument') value.payload.resource = 'market.instrument'
  expect(() => assertQueryResultEnvelope(value)).toThrow('bridge_history_coverage_invalid')
})
it.each(['missing','changed','added'])('rejects coverage changes between pages: %s', kind => {
  const chain = new HistoryPageChain(route, window, 'history.deals'), first = response()
  first.payload.has_more = true; first.payload.next_cursor = 'next'
  if (kind === 'added') delete first.payload.history_coverage
  chain.append(null, first)
  const last = response()
  if (kind === 'missing') delete last.payload.history_coverage
  if (kind === 'changed') last.payload.history_coverage!.collected_at_utc_msc++
  expect(() => chain.append('next', last)).toThrow('trade_history_coverage_changed')
})
it('rejects a coverage range different from the requested range', () => {
  const value = response(); value.payload.history_coverage!.range_start_utc_msc = 999
  expect(() => new HistoryPageChain(route, window, 'history.deals').append(null, value)).toThrow('trade_history_coverage_window_invalid')
})


it('returns frozen coverage with the completed chain and does not add it to legacy chains', () => {
  const value = response(), chain = new HistoryPageChain(route, window, 'history.deals')
  chain.append(null, value)
  const expected = structuredClone(value.payload.history_coverage)
  value.payload.history_coverage!.collected_at_utc_msc++
  const finished = chain.finish()
  expect(finished.historyCoverage).toEqual(expected)
  finished.historyCoverage!.collected_at_utc_msc++
  expect(chain.finish().historyCoverage).toEqual(expected)
  const old = response(); delete old.payload.history_coverage
  const legacy = new HistoryPageChain(route, window, 'history.deals'); legacy.append(null, old)
  expect(legacy.finish()).not.toHaveProperty('historyCoverage')
})
