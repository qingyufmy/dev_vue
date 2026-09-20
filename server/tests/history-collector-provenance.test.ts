import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'
import { MysqlTradeHistoryCollectorRepository } from '../src/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'

const receivedAt = new Date('2026-09-09T00:00:00.000Z')
const route: BridgeGatewayRoute = { userId: 7, accountId: '42', platform: 'mt5', terminalInstanceId: 't1', terminalProfileId: 'p1', brokerServer: 'Broker',
  login: '123', connectionEpoch: 9, connectionId: 'c1', sessionId: 's1', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const raw = { ticket: '99', symbol: 'XAUUSD.a', type: 'buy_limit', state: 'cancelled' }
const response: BridgeQueryResponseEnvelope = { v: 4, type: 'query.response', message_id: 'm1', correlation_id: 'q1', sent_at_utc_msc: receivedAt.getTime(),
  route: { terminal_instance_id: 't1', account_ref: { broker_server: 'Broker', login: '123' }, connection_epoch: 9 },
  payload: { request_id: 'r1', resource: 'history.orders', observed_at_utc_msc: receivedAt.getTime() - 1, source_revision: '3', source: 'terminal', items: [raw], has_more: false, next_cursor: null } }

function fixture({ conflict = false, lostWrite = false } = {}) {
  const calls: string[] = []
  let factHash = '', provenanceHash: string | null = null
  const connection = {
    beginTransaction: vi.fn(async () => { calls.push('begin') }),
    commit: vi.fn(async () => { calls.push('commit') }),
    rollback: vi.fn(async () => { calls.push('rollback') }), release: vi.fn(),
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT trading_account_id FROM trade_history_sync_states_v4')) { calls.push('sync-lock'); return [[{ trading_account_id: '42' }]] }
      if (sql.includes('SELECT id,order_ticket ticket')) { calls.push('fact-lock'); return [[]] }
      if (sql.includes('INSERT IGNORE INTO terminal_history_orders_v4')) { calls.push('fact-write'); factHash = String(params[20]); return [{ affectedRows: 1 }] }
      if (sql.includes('SELECT id,evidence_sha256 FROM terminal_history_orders_v4')) return [[{ id: '00000000-0000-4000-8000-000000000001', evidence_sha256: factHash }]]
      if (sql.includes('SELECT id,provenance_sha256')) return [conflict ? [{ id: 'prior', provenance_sha256: 'wrong' }] : provenanceHash ? [{ id: 'prior', provenance_sha256: provenanceHash }] : []]
      if (sql.includes('INSERT INTO terminal_history_order_provenance_v4')) {
        calls.push('provenance-write')
        if (lostWrite) throw Error('connection_lost')
        provenanceHash = String(params[18]); return [{ affectedRows: 1 }]
      }
      if (sql.startsWith('UPDATE trade_history_sync_states_v4')) { calls.push('sync-update'); return [{ affectedRows: 1 }] }
      throw Error('unexpected_sql')
    }),
  }
  const guard = vi.fn(async () => { calls.push('route-guard') })
  const repository = new MysqlTradeHistoryCollectorRepository({ getConnection: async () => connection } as unknown as Pool, () => ({ assert: guard }))
  return { repository, connection, calls, guard }
}
it('commits order facts and provenance in the route-authorized page transaction', async () => {
  const f = fixture()
  await f.repository.persistPage(route, 'history.orders', response, receivedAt)
  expect(f.calls).toEqual(['begin', 'route-guard', 'sync-lock', 'fact-lock', 'fact-write', 'provenance-write', 'sync-update', 'commit'])
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it.each([{ conflict: true }, { lostWrite: true }])('rolls back the page without updating sync on provenance failure %j', async options => {
  const f = fixture(options)
  await expect(f.repository.persistPage(route, 'history.orders', response, receivedAt)).rejects.toThrow()
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.calls).not.toContain('sync-update')
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('replays the same response without writing another provenance receipt', async () => {
  const f = fixture()
  await f.repository.persistPage(route, 'history.orders', response, receivedAt)
  await f.repository.persistPage(route, 'history.orders', response, new Date(receivedAt.getTime() + 100))
  expect(f.calls.filter(call => call === 'provenance-write')).toHaveLength(1)
  expect(f.connection.commit).toHaveBeenCalledTimes(2)
})
it('freezes caller-owned route, response and received time before waiting for a connection', async () => {
  const f = fixture(), inputRoute = structuredClone(route), inputResponse = structuredClone(response), now = new Date(receivedAt)
  const work = f.repository.persistPage(inputRoute, 'history.orders', inputResponse, now)
  inputRoute.connectionEpoch++; inputResponse.route.connection_epoch++; now.setTime(0)
  await work
  expect(f.guard).toHaveBeenCalledWith(route)
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
