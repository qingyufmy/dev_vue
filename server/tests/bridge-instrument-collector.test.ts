import { expect, it, vi } from 'vitest'
import { BridgeInstrumentCollector } from '../src/modules/bridge/application/bridge-instrument-collector.js'
import type { BridgeGatewayRoute } from '../src/modules/bridge/domain/bridge-gateway.js'
import type { BridgeQueryResponseEnvelope } from '../src/modules/bridge/domain/bridge-query.js'

const collectionLease = { requestId: 'request-1', leaseToken: 'token-1' }
const now = new Date('2026-09-09T00:00:00.000Z')
const route: BridgeGatewayRoute = { userId: 7, accountId: '11', terminalProfileId: 'profile-1', terminalInstanceId: 'terminal-1',
  connectionEpoch: 3, connectionId: 'connection-1', installationId: 'installation-1', credentialGeneration: 2, ownershipRevision: '4',
  brokerServer: 'Broker', login: '123', platform: 'mt5', timezoneOffsetMinutes: 180, sessionId: 'session-1' }
const response: BridgeQueryResponseEnvelope = { v: 4, type: 'query.response', message_id: 'message-1', correlation_id: 'request-1', sent_at_utc_msc: now.getTime(),
  route: { terminal_instance_id: 'terminal-1', connection_epoch: 3, account_ref: { broker_server: 'Broker', login: '123' } },
  payload: { request_id: 'query-1', resource: 'market.instrument', observed_at_utc_msc: now.getTime(), source_revision: 'source-1',
    source: 'terminal', items: [{ name: 'XAUUSD' }], has_more: false, next_cursor: null } }
function fixture(value = response) {
  const read = vi.fn().mockResolvedValue(2)
  const queryInstrument = vi.fn().mockResolvedValue(value)
  const write = vi.fn().mockResolvedValue({ applied: true, revision: 3 })
  return { read, queryInstrument, write, collector: new BridgeInstrumentCollector({ queryInstrument }, { readRevision: read }, { write }, () => now) }
}
it('queries the terminal symbol, then reads its version and passes the frozen scope to the owner writer', async () => {
  const f = fixture()
  await expect(f.collector.collect({ collectionLease, route, symbol: 'XAUUSD' })).resolves.toEqual({ applied: true, revision: 3 })
  expect(f.write).toHaveBeenCalledWith({ collectionLease, route, symbol: 'XAUUSD', requestedSymbol: 'XAUUSD', raw: { name: 'XAUUSD' }, expectedRevision: 2,
    sourceRevision: 'source-1', observedAt: now.toISOString() })
  expect(f.queryInstrument.mock.invocationCallOrder[0]).toBeLessThan(f.read.mock.invocationCallOrder[0]!)
  expect(f.queryInstrument.mock.invocationCallOrder[0]).toBeLessThan(f.write.mock.invocationCallOrder[0]!)
})
it('does not query or write without the full device proof', async () => {
  const f = fixture()
  const { installationId: _, ...withoutProof } = route
  await expect(f.collector.collect({ collectionLease, route: withoutProof, symbol: 'XAUUSD' })).rejects.toThrow('bridge_instrument_route_proof_missing')
  expect(f.queryInstrument).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
})
it.each([{ observed_at_utc_msc: now.getTime() - 1 }, { observed_at_utc_msc: now.getTime() + 1 },
  { items: [] }, { has_more: true, next_cursor: 'next' }, { resource: 'history.orders' }])('rejects invalid or stale query payload %j', async patch => {
  const f = fixture({ ...response, payload: { ...response.payload, ...patch } } as BridgeQueryResponseEnvelope)
  await expect(f.collector.collect({ collectionLease, route, symbol: 'XAUUSD' })).rejects.toThrow()
  expect(f.write).not.toHaveBeenCalled()
})
it('keeps changed account routes out of persistence', async () => {
  const f = fixture({ ...response, route: { ...response.route, account_ref: { broker_server: 'Broker', login: '456' } } })
  await expect(f.collector.collect({ collectionLease, route, symbol: 'XAUUSD' })).rejects.toThrow('bridge_instrument_result_invalid')
  expect(f.write).not.toHaveBeenCalled()
})

it.each(['XAUUSD.s', 'XAUUSD.c', 'xauusdBrokerSuffix'])('preserves resolved terminal symbol %s while retaining the standard request lease', async symbol => {
  const f = fixture({ ...response, payload: { ...response.payload, items: [{ name: symbol }] } })
  await f.collector.collect({ collectionLease, route, symbol: 'XAUUSD' })
  expect(f.read).toHaveBeenCalledWith(route.accountId, symbol)
  expect(f.write).toHaveBeenCalledWith(expect.objectContaining({ symbol, requestedSymbol: 'XAUUSD', collectionLease, raw: { name: symbol } }))
})
it.each([{ name: 'EURUSD' }, { name: 'preXAUUSD' }, { name: 'XAUUSD.s', symbol: 'XAUUSD.c' }])('rejects unrelated or conflicting terminal symbols %j', async raw => {
  const f = fixture({ ...response, payload: { ...response.payload, items: [raw] } })
  await expect(f.collector.collect({ collectionLease, route, symbol: 'XAUUSD' })).rejects.toThrow('bridge_instrument_result_invalid')
  expect(f.write).not.toHaveBeenCalled()
})
