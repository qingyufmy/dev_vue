import { expect, it } from 'vitest'
import { historyDealProvenance } from '../src/modules/trade-history/application/history-deal-provenance.js'
import { decodeTerminalHistoryPage, type TerminalDealFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'

const now = new Date('2026-09-09T00:00:00.000Z')
const route: BridgeGatewayRoute = { userId: 7, accountId: '42', platform: 'mt5', terminalInstanceId: 't1', terminalProfileId: 'p1',
  brokerServer: 'Broker', login: '123', connectionEpoch: 9, connectionId: 'c1', sessionId: 's1', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const raw = { ticket: '99', symbol: 'XAUUSD.a', type: 'buy', entry: 'in', volume: '1', price: '2500', time_msc: now.getTime() - 1000 }
const response: BridgeQueryResponseEnvelope = { v: 4, type: 'query.response', message_id: 'm1', correlation_id: 'q1', sent_at_utc_msc: now.getTime(),
  route: { terminal_instance_id: 't1', account_ref: { broker_server: 'Broker', login: '123' }, connection_epoch: 9 },
  payload: { request_id: 'r1', resource: 'history.deals', observed_at_utc_msc: now.getTime() - 1, source_revision: '3', source: 'terminal', items: [raw], has_more: false, next_cursor: null } }
const input = { route, response, dealId: '00000000-0000-4000-8000-000000000001',
  fact: decodeTerminalHistoryPage('deals', [raw])[0] as TerminalDealFact, receivedAt: now }
it('records exact immutable route, response correlation and raw fact hash', () => {
  const result = historyDealProvenance(input)
  expect(result).toMatchObject({ accountId: '42', terminalInstanceId: 't1', connectionEpoch: '9', queryMessageId: 'q1', factHash: input.fact.evidenceHash })
  expect(result.provenanceHash).toMatch(/^[0-9a-f]{64}$/)
})
it('keeps evidence hash stable across receipt retries', () => {
  expect(historyDealProvenance({ ...input, receivedAt: new Date(now.getTime() + 5000) }).provenanceHash).toBe(historyDealProvenance(input).provenanceHash)
})
it.each([{ terminalInstanceId: 't2' }, { brokerServer: 'broker' }, { login: '124' }, { connectionEpoch: 10 }, { ownershipRevision: '0' }])(
  'rejects mismatched or invalid route %j', patch => {
    expect(() => historyDealProvenance({ ...input, route: { ...route, ...patch } })).toThrow('trade_history_deal_provenance_invalid')
  })
it('refuses a fact not present in this response', () => {
  expect(() => historyDealProvenance({ ...input, response: { ...response, payload: { ...response.payload, items: [] } } })).toThrow('trade_history_deal_provenance_invalid')
})
it('rejects future observations rather than manufacturing an adjusted time', () => {
  expect(() => historyDealProvenance({ ...input, response: { ...response, payload: { ...response.payload, observed_at_utc_msc: now.getTime() + 1 } } })).toThrow('trade_history_deal_provenance_invalid')
})

it.each([{ accountId: '18446744073709551616' }, { ownershipRevision: '18446744073709551616' }, { ownershipRevision: undefined }])(
  'rejects missing or overflowing database identity %j', patch => {
    const altered = { ...route, ...patch }
    if (altered.ownershipRevision === undefined) delete altered.ownershipRevision
    expect(() => historyDealProvenance({ ...input, route: altered as BridgeGatewayRoute })).toThrow('trade_history_deal_provenance_invalid')
  })
it('rejects raw evidence JSON inconsistent with its digest', () => {
  expect(() => historyDealProvenance({ ...input, fact: { ...input.fact, evidenceJson: '{}' } })).toThrow('trade_history_deal_provenance_invalid')
})
it('keeps MT4 and MT5 resource identities separate', () => {
  const mt4 = { ...route, platform: 'mt4' as const }
  expect(() => historyDealProvenance({ ...input, route: mt4 })).toThrow('trade_history_deal_provenance_invalid')
  const mt4Response = { ...response, payload: { ...response.payload, resource: 'history.trades' as const } }
  expect(historyDealProvenance({ ...input, route: mt4, response: mt4Response }).platform).toBe('mt4')
  expect(() => historyDealProvenance({ ...input, response: mt4Response })).toThrow('trade_history_deal_provenance_invalid')
})
