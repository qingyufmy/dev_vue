import { expect, it } from 'vitest'
import { historyOrderProvenance } from '../src/modules/trade-history/application/history-order-provenance.js'
import { decodeTerminalHistoryPage, type TerminalOrderFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'

const now = new Date('2026-09-09T00:00:00.000Z')
const route: BridgeGatewayRoute = { userId: 7, accountId: '42', platform: 'mt5', terminalInstanceId: 't1', terminalProfileId: 'p1',
  brokerServer: 'Broker', login: '123', connectionEpoch: 9, connectionId: 'c1', sessionId: 's1', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const raw = { ticket: '99', symbol: 'XAUUSD.a', type: 'buy_limit', state: 'cancelled' }
const response: BridgeQueryResponseEnvelope = { v: 4, type: 'query.response', message_id: 'm1', correlation_id: 'q1', sent_at_utc_msc: now.getTime(),
  route: { terminal_instance_id: 't1', account_ref: { broker_server: 'Broker', login: '123' }, connection_epoch: 9 },
  payload: { request_id: 'r1', resource: 'history.orders', observed_at_utc_msc: now.getTime() - 1, source_revision: '3', source: 'terminal', items: [raw], has_more: false, next_cursor: null } }
const input = { route, response, orderId: '00000000-0000-4000-8000-000000000001',
  fact: decodeTerminalHistoryPage('orders', [raw])[0] as TerminalOrderFact, receivedAt: now }
it('records exact immutable route, response correlation and raw fact hash', () => {
  const result = historyOrderProvenance(input)
  expect(result).toMatchObject({ accountId: '42', terminalInstanceId: 't1', connectionEpoch: '9', queryMessageId: 'q1', factHash: input.fact.evidenceHash })
  expect(result.provenanceHash).toMatch(/^[0-9a-f]{64}$/)
})
it('keeps evidence hash stable across receipt retries', () => {
  expect(historyOrderProvenance({ ...input, receivedAt: new Date(now.getTime() + 5000) }).provenanceHash).toBe(historyOrderProvenance(input).provenanceHash)
})
it.each([{ terminalInstanceId: 't2' }, { brokerServer: 'broker' }, { login: '124' }, { connectionEpoch: 10 }, { ownershipRevision: '0' }])(
  'rejects mismatched or invalid route %j', patch => {
    expect(() => historyOrderProvenance({ ...input, route: { ...route, ...patch } })).toThrow('trade_history_order_provenance_invalid')
  })
it('refuses a fact not present in this response', () => {
  expect(() => historyOrderProvenance({ ...input, response: { ...response, payload: { ...response.payload, items: [] } } })).toThrow('trade_history_order_provenance_invalid')
})
it('rejects future observations rather than manufacturing an adjusted time', () => {
  expect(() => historyOrderProvenance({ ...input, response: { ...response, payload: { ...response.payload, observed_at_utc_msc: now.getTime() + 1 } } })).toThrow('trade_history_order_provenance_invalid')
})
