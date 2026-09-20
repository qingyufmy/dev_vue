import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'
import type { OwnershipInterval } from '../src/modules/trading/index.js'
import { resolveTradeRecordOwner } from '../src/modules/trade-history/application/trade-record-owner.js'
import { decodeTerminalHistoryPage, projectMt4Trade } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import { MysqlTradeHistoryCollectorRepository } from '../src/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'
import { MysqlTradeHistoryRepository } from '../src/modules/trade-history/infrastructure/mysql-trade-history-repository.js'
import { provenHistoryRecordSql } from '../src/modules/trade-history/infrastructure/trade-history-ownership-sql.js'
import { TradeHistoryService } from '../src/modules/trade-history/application/trade-history-service.js'

const at = (hour: number) => new Date(`2026-09-05T${String(hour).padStart(2, '0')}:00:00.000Z`)
const now = at(12)
const terminalTrade = { ticket: '7001', symbol: 'EURUSD', type: 1, lots: '0.20',
  open_price: '1.10000', close_price: '1.09000', profit: '200', commission: '-4', swap: '-1',
  open_time_utc_msc: at(8).getTime(), close_time_utc_msc: at(9).getTime() }
const fact = decodeTerminalHistoryPage('mt4_closed_trades', [terminalTrade])[0]!
if (fact.kind !== 'deal') throw new Error('test_fact_invalid')
const projection = projectMt4Trade(fact)!
const route: BridgeGatewayRoute = { userId: 2, accountId: '42', platform: 'mt4', timezoneOffsetMinutes: 180,
  terminalProfileId: 'profile_12345678', terminalInstanceId: 'terminal_12345678', brokerServer: 'Demo', login: '123',
  connectionEpoch: 3, connectionId: 'connection_12345678', sessionId: 'session_12345678', ownershipRevision: '3' }
const interval = (userId = 1, start = 7, end: number | null = 10): OwnershipInterval => ({
  id: `00000000-0000-4000-8000-${String(userId).padStart(12, '0')}`, userId, accountId: '42', role: 'owner',
  startedAtUtc: at(start).toISOString(), endedAtUtc: end === null ? null : at(end).toISOString(),
  originKind: 'runtime', originRef: `change:${userId}`,
})

describe('P3 complete lifecycle ownership resolution', () => {
  it('assigns an old trade to its former owner, not the currently collecting user', () => {
    expect(resolveTradeRecordOwner('42', projection, [interval(), interval(2, 10, null)], now))
      .toEqual({ userId: 1, intervalId: interval().id })
  })
  it('resolves each A to B to A segment without collapsing the first A interval', () => {
    const first = interval(1, 7, 9)
    const second = interval(2, 9, 10)
    const third = { ...interval(1, 10, null), id: interval(3).id, originRef: 'change:3' }
    const timeline = [first, second, third]
    expect(resolveTradeRecordOwner('42', { ...projection, closedAtUtcMsc: at(9).getTime() - 1 }, timeline, now)?.intervalId).toBe(first.id)
    expect(resolveTradeRecordOwner('42', { ...projection, openedAtUtcMsc: at(9).getTime(), closedAtUtcMsc: at(10).getTime() - 1 }, timeline, now)?.userId).toBe(2)
    expect(resolveTradeRecordOwner('42', { ...projection, openedAtUtcMsc: at(10).getTime(), closedAtUtcMsc: at(11).getTime() }, timeline, now)?.intervalId).toBe(third.id)
  })
  it('isolates boundary-spanning, missing, overlapping, incomplete and future evidence', () => {
    expect(resolveTradeRecordOwner('42', projection, [], now)).toBeNull()
    expect(resolveTradeRecordOwner('99', projection, [interval()], now)).toBeNull()
    expect(resolveTradeRecordOwner('42', projection, [interval(1, 7, 9), interval(2, 9, null)], now)).toBeNull()
    expect(resolveTradeRecordOwner('42', projection, [interval(), interval(2, 8, 11)], now)).toBeNull()
    expect(resolveTradeRecordOwner('42', { ...projection, evidenceStatus: 'partial' }, [interval()], now)).toBeNull()
    expect(resolveTradeRecordOwner('42', { ...projection, openedAtUtcMsc: at(10).getTime() }, [interval()], now)).toBeNull()
    expect(resolveTradeRecordOwner('42', { ...projection, closedAtUtcMsc: at(13).getTime() }, [interval(1, 7, null)], now)).toBeNull()
  })
})

describe('P3 MySQL adapter statements using offline fixtures (not a SQL engine)', () => {
  it('binds explicit MT4 record currency to both raw and projected rows', async () => {
    const f = collectorFixture([interval()])
    const page = response()
    page.payload.items = page.payload.items.map(item => ({ ...item, account_currency: 'EUR', currency_evidence: 'explicit_record' }))
    await new MysqlTradeHistoryCollectorRepository(f.pool, () => ({ assert: async () => { f.calls.push({ sql: 'route guard', params: [] }) } })).persistPage(route, 'history.trades', page, now)
    for (const table of ['terminal_history_deals_v4', 'account_trade_records_v4']) {
      const insert = f.calls.find(call => call.sql.includes('INSERT') && call.sql.includes(`INTO ${table}`))!
      expect(insert.params.slice(-2)).toEqual(['EUR', 'explicit_record'])
      expect(insert.sql.match(/\?/g)?.length ?? 0).toBe(insert.params.length)
    }
    expect(f.committed()).toBe(true)
  })
  it('persists old facts with the proven old owner and checks account lock before sync lock', async () => {
    const f = collectorFixture([interval()])
    await new MysqlTradeHistoryCollectorRepository(f.pool, () => ({ assert: async () => { f.calls.push({ sql: 'route guard', params: [] }) } })).persistPage(route, 'history.trades', response(), now)
    const insert = f.calls.find(call => call.sql.includes('INSERT INTO account_trade_records_v4'))!
    expect(insert.params[1]).toBe(1)
    expect(insert.params.at(-3)).toBe(interval().id)
    expect(insert.params.slice(-2)).toEqual([null, 'unknown'])
    for (const call of f.calls.filter(call => call.sql.includes('INSERT'))) {
      expect(call.sql.match(/\?/g)?.length ?? 0).toBe(call.params.length)
    }
    const dealInsert = f.calls.find(call => call.sql.includes('INSERT IGNORE INTO terminal_history_deals_v4'))!
    expect(dealInsert.params.slice(-2)).toEqual([null, 'unknown'])
    expect(f.calls[0]!.sql).toBe('route guard')
    expect(f.calls[1]!.sql).toContain('trade_history_sync_states_v4')
    expect(f.calls.find(call => call.sql.includes('FROM trading_account_ownership_intervals'))?.sql).toContain('LIMIT 2 FOR SHARE')
    expect(insert.sql).toContain('user_id=COALESCE(user_id,VALUES(user_id))')
    expect(insert.sql).toContain('IF(user_id IS NULL OR user_id=VALUES(user_id),VALUES(ownership_interval_id),NULL)')
    expect(f.committed()).toBe(true)
  })
  it('retains terminal facts and a null-owner projection instead of assigning unresolved history to the route user', async () => {
    const f = collectorFixture([])
    await new MysqlTradeHistoryCollectorRepository(f.pool, () => ({ assert: async () => { f.calls.push({ sql: 'route guard', params: [] }) } })).persistPage(route, 'history.trades', response(), now)
    expect(f.calls.some(call => call.sql.includes('INSERT IGNORE INTO terminal_history_deals_v4'))).toBe(true)
    const insert = f.calls.find(call => call.sql.includes('INSERT INTO account_trade_records_v4'))!
    expect(insert.params[1]).toBeNull()
    expect(insert.params.at(-3)).toBeNull()
    expect(f.committed()).toBe(true)
  })
  it('keeps history access independent of current owner and restricts all list/summary/freshness queries', async () => {
    const calls: string[] = []
    const pool = { execute: async (sql: string, params: unknown[]) => {
      calls.push(sql)
      expect(params).not.toContain(undefined)
      return [sql.startsWith('SELECT 1 FROM users') ? [{ allowed: 1 }] : [], []]
    } } as unknown as Pool
    const service = new TradeHistoryService(new MysqlTradeHistoryRepository(pool), () => now)
    const page = await service.records(1, { accountId: '42' })
    expect(page.items).toEqual([])
    expect(calls[0]).toContain('trading_account_ownership_intervals')
    expect(calls[0]).not.toContain('revoked_at_utc')
    expect(calls).toHaveLength(5)
    expect(calls[2]).toContain('NULL fresh_through_utc,NULL last_success_at_utc')
    expect(calls[2]).not.toContain('trade_history_sync_states_v4')
    for (const sql of calls.slice(1)) {
      expect(sql).toContain(provenHistoryRecordSql())
      expect(sql).toContain('r.user_id=?')
      expect(sql).toContain('r.trading_account_id=?')
      expect(sql).not.toContain('SELECT *')
    }
  })
  it('uses the same proof for details, deal links and attribution links, without querying another account facts', async () => {
    const calls: string[] = []
    const pool = { execute: async (sql: string) => { calls.push(sql); return [[], []] } } as unknown as Pool
    expect(await new MysqlTradeHistoryRepository(pool).find(1, 'record-1')).toBeNull()
    expect(calls).toHaveLength(3)
    for (const sql of calls) expect(sql).toContain(provenHistoryRecordSql())
    expect(calls[1]).toContain('d.trading_account_id=r.trading_account_id')
    expect(calls[1]).toContain('d.occurred_at_utc>=r.opened_at_utc')
    expect(calls[1]).toContain('d.occurred_at_utc<=r.closed_at_utc')
  })
  it('rebuilds only derived totals and does not filter historical owners to the collector user', async () => {
    const f = collectorFixture([])
    await new MysqlTradeHistoryCollectorRepository(f.pool, () => ({ assert: async () => { f.calls.push({ sql: 'route guard', params: [] }) } })).complete(route, now.getTime(), now,
      [{ resource: 'history.trades', rangeStartUtcMsc: 1000, rangeEndUtcMsc: now.getTime(), source: 'terminal', sourceRevision: 'revision', pageCount: 1, itemCount: 0, pageChainHash: 'a'.repeat(64) }])
    const rebuild = f.calls.find(call => call.sql.includes('INSERT INTO account_trade_daily_summaries_v4'))!
    expect(rebuild.sql).toContain(provenHistoryRecordSql())
    expect(rebuild.sql).not.toContain('r.user_id=?')
    expect(rebuild.sql).toContain('MIN(r.terminal_timezone_offset_minutes)')
    expect(rebuild.sql).toContain('HAVING COUNT(DISTINCT r.terminal_timezone_offset_minutes)=1 AND COUNT(r.terminal_timezone_offset_minutes)=COUNT(*)')
    expect(rebuild.params).toEqual([now, '42'])
    const deletes = f.calls.filter(call => /^DELETE/.test(call.sql))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.sql).toBe('DELETE FROM account_trade_daily_summaries_v4 WHERE trading_account_id=?')
    expect(deletes[0]!.params).toEqual(['42'])
  })
})

function collectorFixture(intervals: OwnershipInterval[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let committed = false
  let storedFactHash = ''
  const connection = {
    beginTransaction: async () => {}, commit: async () => { committed = true }, rollback: async () => {}, release: () => {},
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      expect((sql.match(/\?/g) ?? []).length).toBe(params.length)
      if (sql.startsWith('SELECT id FROM trading_accounts')) return [[{ id: '42' }], []]
      if (sql.startsWith('SELECT trading_account_id FROM trade_history_sync_states_v4')) return [[{ trading_account_id: '42' }], []]
      if (sql.startsWith('SELECT trading_account_id,status FROM trade_history_sync_states_v4')) return [[{ trading_account_id: '42', status: 'syncing' }], []]
      if (sql.startsWith('INSERT IGNORE INTO terminal_history_deals_v4')) { storedFactHash = String(params[21]); return [{ affectedRows: 1 }, []] }
      if (sql.startsWith('SELECT id,evidence_sha256 FROM terminal_history_deals_v4')) return [[{ id: '00000000-0000-4000-8000-000000000001', evidence_sha256: storedFactHash }], []]
      if (sql.startsWith('INSERT INTO terminal_history_deal_provenance_v4')) return [{ affectedRows: 1 }, []]
      if (sql.startsWith('SELECT history_revision')) return [[{ history_revision: 2 }], []]
      if (sql.startsWith('INSERT INTO terminal_history_collection_receipts_v4')) return [{ affectedRows: 1 }, []]
      if (sql.includes('FROM trading_account_ownership_intervals')) return [intervals.map(i => ({
        id: i.id, user_id: i.userId, trading_account_id: i.accountId, role: i.role,
        started_at_utc: new Date(i.startedAtUtc), ended_at_utc: i.endedAtUtc ? new Date(i.endedAtUtc) : null,
        origin_kind: i.originKind, origin_ref: i.originRef,
      })), []]
      if (sql.startsWith('SELECT id FROM account_trade_records_v4')) return [[{ id: 'record-1' }], []]
      if (sql.startsWith('SELECT id FROM terminal_history_deals_v4')) return [[{ id: 'deal-1' }], []]
      return [[], []]
    },
  }
  return { calls, committed: () => committed, pool: { getConnection: async () => connection } as unknown as Pool }
}

function response(): BridgeQueryResponseEnvelope {
  return { v: 4, message_id: 'response_12345678', type: 'query.response', sent_at_utc_msc: now.getTime(), correlation_id: 'request_12345678',
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch },
    payload: { request_id: 'request_12345678', resource: 'history.trades', observed_at_utc_msc: now.getTime(), source_revision: 'source_12345678', source: 'local_projection',
      items: [terminalTrade], has_more: false, next_cursor: null } }
}
