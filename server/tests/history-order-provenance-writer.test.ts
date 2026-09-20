import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'
import { decodeTerminalHistoryPage, type TerminalOrderFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import { historyOrderProvenance } from '../src/modules/trade-history/application/history-order-provenance.js'
import { persistHistoryOrderProvenance } from '../src/modules/trade-history/infrastructure/mysql-history-order-provenance-writer.js'

const receivedAt = new Date('2026-09-09T00:00:00.000Z')
const route: BridgeGatewayRoute = { userId: 7, accountId: '42', platform: 'mt5', terminalInstanceId: 't1', terminalProfileId: 'p1', brokerServer: 'Broker',
  login: '123', connectionEpoch: 9, connectionId: 'c1', sessionId: 's1', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const raw = { ticket: '99', symbol: 'XAUUSD.a', type: 'buy_limit', state: 'cancelled' }
const response: BridgeQueryResponseEnvelope = { v: 4, type: 'query.response', message_id: 'm1', correlation_id: 'q1', sent_at_utc_msc: receivedAt.getTime(),
  route: { terminal_instance_id: 't1', account_ref: { broker_server: 'Broker', login: '123' }, connection_epoch: 9 },
  payload: { request_id: 'r1', resource: 'history.orders', observed_at_utc_msc: receivedAt.getTime() - 1, source_revision: '3', source: 'terminal', items: [raw], has_more: false, next_cursor: null } }
const input = { route, response, receivedAt, fact: decodeTerminalHistoryPage('orders', [raw])[0] as TerminalOrderFact }
const order = { id: '00000000-0000-4000-8000-000000000001', evidence_sha256: input.fact.evidenceHash }
function fixture(existing: unknown[] = []) {
  const execute = vi.fn().mockResolvedValueOnce([[order], []]).mockResolvedValueOnce([existing, []]).mockResolvedValueOnce([{ affectedRows: 1 }, []])
  return { execute, write: () => persistHistoryOrderProvenance({ execute } as unknown as PoolConnection, input) }
}
it('writes matching fact provenance with parameterized SQL and exact dates', async () => {
  const { write, execute } = fixture()
  expect(await write()).toMatchObject({ created: true })
  const [sql, params] = execute.mock.calls[2]!
  expect((sql as string).match(/\?/g)).toHaveLength(params.length)
  expect(params[params.length - 1]).toEqual(receivedAt)
  expect(sql).not.toMatch(/IGNORE|DUPLICATE/)
})
it('replays identical evidence without a second write', async () => {
  const value = historyOrderProvenance({ ...input, orderId: order.id })
  const { write, execute } = fixture([{ id: 'prior', provenance_sha256: value.provenanceHash }])
  expect(await write()).toEqual({ id: 'prior', created: false })
  expect(execute).toHaveBeenCalledTimes(2)
})
it('rejects changed provenance for the same response key', async () => {
  const { write, execute } = fixture([{ id: 'prior', provenance_sha256: 'wrong' }])
  await expect(write()).rejects.toThrow('trade_history_provenance_conflict')
  expect(execute).toHaveBeenCalledTimes(2)
})
it('rejects an unmatched stored raw fact before reading provenance', async () => {
  const { write, execute } = fixture()
  execute.mockReset().mockResolvedValueOnce([[{ ...order, evidence_sha256: 'wrong' }], []])
  await expect(write()).rejects.toThrow('trade_history_provenance_fact_mismatch')
  expect(execute).toHaveBeenCalledTimes(1)
})
it('propagates a lost insert acknowledgement to the transaction owner', async () => {
  const { write, execute } = fixture()
  execute.mockReset().mockResolvedValueOnce([[order], []]).mockResolvedValueOnce([[], []]).mockRejectedValueOnce(new Error('connection lost'))
  await expect(write()).rejects.toThrow('connection lost')
})
