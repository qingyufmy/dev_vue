import { describe, expect, it, vi } from 'vitest'
import {
  BridgeGatewayQueryTransport, InProcessBridgeGatewayDirectory,
  type BridgeGatewayLeaseStore, type BridgeGatewayRoute, type BridgeGatewaySink,
} from '../src/modules/bridge/index.js'
import {
  TradeHistoryCollector, TradeHistoryScheduleService, decodeTerminalHistoryPage, projectMt4Trade, projectMt5Position,
  type TradeHistoryCollectorRepository, type TradeHistoryScheduleRepository,
} from '../src/modules/trade-history/index.js'
import { BullMqOutboxTaskPublisher } from '../src/outbox/index.js'
import type { RuntimeTaskQueues } from '../src/queue/task-queues.js'

const NOW = new Date('2026-09-04T08:00:00.000Z')
const route: BridgeGatewayRoute = {
  userId: 7, accountId: '42', platform: 'mt5', timezoneOffsetMinutes: 180, terminalProfileId: 'profile_12345678',
  terminalInstanceId: 'terminal_12345678', brokerServer: 'DPrimeVU-Demo 5', login: '8950701', connectionEpoch: 3,
  connectionId: 'connection_12345678', sessionId: 'session_12345678',
}

describe('Stage 12T Bridge history collection', () => {
  it('correlates a read-only query response to the exact live route', async () => {
    const leases = new MemoryLeases(route); const directory = new InProcessBridgeGatewayDirectory(); const sink = new MemorySink()
    directory.attach(route, sink)
    const transport = new BridgeGatewayQueryTransport(leases, directory, () => NOW)
    const pending = transport.query({ route, resource: 'history.deals', rangeStartUtcMsc: NOW.getTime() - 1_000,
      rangeEndUtcMsc: NOW.getTime(), limit: 500, cursor: null })
    await vi.waitFor(() => expect(sink.messages).toHaveLength(1))
    const request = sink.messages[0] as { type: string; message_id: string; payload: { request_id: string; resource: string } }
    expect(request.type).toBe('query.request')
    expect(JSON.stringify(request)).not.toContain('command.request')
    transport.receive(route, response(request, []))
    await expect(pending).resolves.toMatchObject({ type: 'query.response', payload: { resource: 'history.deals', has_more: false } })
  })

  it('rejects a response whose epoch or correlation does not match the pending request', async () => {
    const leases = new MemoryLeases(route); const directory = new InProcessBridgeGatewayDirectory(); const sink = new MemorySink()
    directory.attach(route, sink)
    const transport = new BridgeGatewayQueryTransport(leases, directory, () => NOW)
    const pending = transport.query({ route, resource: 'history.deals', rangeStartUtcMsc: NOW.getTime() - 1_000, rangeEndUtcMsc: NOW.getTime() })
    await vi.waitFor(() => expect(sink.messages).toHaveLength(1))
    const request = sink.messages[0] as Parameters<typeof response>[0]
    const mismatched = response(request, [])
    mismatched.route.connection_epoch += 1
    expect(() => transport.receive(route, mismatched)).toThrowError('bridge_query_result_correlation_invalid')
    await expect(pending).rejects.toThrowError('bridge_query_result_correlation_invalid')
  })

  it('pages MT5 orders and deals, persists each page, and publishes readiness only after both complete', async () => {
    const repository = new MemoryCollectorRepository()
    const calls: Array<{ resource: string; cursor: string | null }> = []
    const collector = new TradeHistoryCollector(repository, { async query(input) {
      calls.push({ resource: input.resource, cursor: input.cursor ?? null })
      const firstDeals = input.resource === 'history.deals' && input.cursor === null
      return responseFor(input.resource, firstDeals, firstDeals ? 'cursor-2' : null)
    } }, () => NOW)
    await expect(collector.collect(route)).resolves.toEqual({ status: 'ready', freshThroughUtcMsc: NOW.getTime() })
    expect(calls).toEqual([
      { resource: 'history.orders', cursor: null },
      { resource: 'history.deals', cursor: null },
      { resource: 'history.deals', cursor: 'cursor-2' },
    ])
    expect(repository.trace).toEqual(['begin', 'page:history.orders', 'page:history.deals', 'page:history.deals', 'complete'])
  })

  it('projects closed MT5 position episodes and MT4 closed trades without treating cash movements as trades', () => {
    const facts = decodeTerminalHistoryPage('history.deals', [
      { deal_ticket: '1001', order: '501', position_id: '9001', symbol: 'XAUUSD', type: 0, entry: 0, volume: '0.10', price: '2500.10', profit: '0', commission: '-1', swap: '0', fee: '0', time_utc_msc: NOW.getTime() - 60_000 },
      { deal_ticket: '1002', order: '502', position_id: '9001', symbol: 'XAUUSD', type: 1, entry: 1, volume: '0.10', price: '2510.10', profit: '100', commission: '-1', swap: '-2', fee: '0', time_utc_msc: NOW.getTime() },
      { deal_ticket: '1003', type: 'balance', profit: '1000', commission: '0', swap: '0', fee: '0', time_utc_msc: NOW.getTime() },
    ])
    const mt5 = projectMt5Position('9001', facts.filter(fact => fact.kind === 'deal'))
    expect(mt5).toMatchObject({ side: 'buy', volumeOpened: '0.1', entryPrice: '2500.1', exitPrice: '2510.1', netProfit: '96' })
    expect(projectMt5Position('missing', facts.filter(fact => fact.kind === 'deal'))).toBeNull()

    const mt4Fact = decodeTerminalHistoryPage('history.trades', [{ ticket: '7001', symbol: 'EURUSD', type: 1, lots: '0.20',
      open_price: '1.10000', close_price: '1.09000', profit: '200', commission: '-4', swap: '-1',
      open_time_utc_msc: NOW.getTime() - 120_000, close_time_utc_msc: NOW.getTime() }])[0]!
    expect(projectMt4Trade(mt4Fact.kind === 'deal' ? mt4Fact : never())).toMatchObject({ stableKey: 'mt4:ticket:7001', side: 'sell', netProfit: '195' })
  })

  it('fails closed when one terminal page contains conflicting facts for the same ticket', () => {
    expect(() => decodeTerminalHistoryPage('history.deals', [
      { deal_ticket: '1001', type: 'balance', profit: '10', time_utc_msc: NOW.getTime() },
      { deal_ticket: '1001', type: 'balance', profit: '11', time_utc_msc: NOW.getTime() },
    ])).toThrowError('trade_history_fact_conflict')
  })

  it('keeps due-work registration in the scheduler process and only places account IDs on the queue', async () => {
    const repository: TradeHistoryScheduleRepository = { scheduleDue: vi.fn(async () => ['42']) }
    const scheduler = new TradeHistoryScheduleService(repository)
    await expect(scheduler.schedule(20, NOW)).resolves.toEqual(['42'])
    expect(repository.scheduleDue).toHaveBeenCalledWith(20, NOW)
    expect(() => scheduler.schedule(0, NOW)).toThrowError('trade_history_schedule_limit_invalid')
  })

  it('accepts the numeric trading-account primary key when publishing the ID-only history job', async () => {
    const add = vi.fn(async () => undefined)
    const publisher = new BullMqOutboxTaskPublisher({ bridgeHistory: { add } } as unknown as RuntimeTaskQueues)
    await publisher.publish({
      id: '1', eventId: 'event-12345678', eventType: 'trade.history.requested', occurredAt: NOW.toISOString(),
      payload: { account_id: '42' }, attempts: 1,
    })
    expect(add).toHaveBeenCalledWith('trade.history.collect', { accountId: '42' }, { jobId: 'event-12345678' })
    await expect(publisher.publish({
      id: '2', eventId: 'event-87654321', eventType: 'trade.history.requested', occurredAt: NOW.toISOString(),
      payload: { account_id: 'account-42' }, attempts: 1,
    })).rejects.toThrowError('outbox_account_id_invalid')
    await expect(publisher.publish({
      id: '3', eventId: 'event-87654322', eventType: 'trade.history.requested', occurredAt: NOW.toISOString(),
      payload: { account_id: '18446744073709551616' }, attempts: 1,
    })).rejects.toThrowError('outbox_account_id_invalid')
  })

})

class MemorySink implements BridgeGatewaySink {
  messages: unknown[] = []
  send(message: unknown) { this.messages.push(message) }
  close() {}
}
class MemoryLeases implements BridgeGatewayLeaseStore {
  constructor(private currentRoute: BridgeGatewayRoute | null) {}
  async claim() { return { replacedConnectionId: null } }
  async renew() { return true }
  async release() { this.currentRoute = null }
  async current(accountId: string) { return this.currentRoute?.accountId === accountId ? this.currentRoute : null }
}
class MemoryCollectorRepository implements TradeHistoryCollectorRepository {
  trace: string[] = []
  async begin() { this.trace.push('begin'); return { rangeStartUtcMsc: NOW.getTime() - 1_000, rangeEndUtcMsc: NOW.getTime() } }
  async persistPage(_route: BridgeGatewayRoute, resource: 'history.orders' | 'history.trades' | 'history.deals') { this.trace.push(`page:${resource}`) }
  async complete() { this.trace.push('complete') }
  async fail() { this.trace.push('fail') }
}

function response(request: { message_id: string; payload: { request_id: string; resource: string } }, items: Record<string, unknown>[]) {
  return { v: 4 as const, message_id: 'response_12345678', type: 'query.response' as const, sent_at_utc_msc: NOW.getTime(), correlation_id: request.message_id,
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch },
    payload: { request_id: request.payload.request_id, resource: request.payload.resource as 'history.deals', observed_at_utc_msc: NOW.getTime(), source_revision: 'revision_12345678', source: 'local_projection' as const, items, has_more: false, next_cursor: null } }
}
function responseFor(resource: 'history.orders' | 'history.trades' | 'history.deals', hasMore: boolean, nextCursor: string | null) {
  return { v: 4 as const, message_id: 'response_12345678', type: 'query.response' as const, sent_at_utc_msc: NOW.getTime(), correlation_id: 'message_12345678',
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch },
    payload: { request_id: 'request_12345678', resource, observed_at_utc_msc: NOW.getTime(), source_revision: 'revision_12345678', source: 'local_projection' as const,
      items: [], has_more: hasMore, next_cursor: nextCursor } }
}
function never(): never { throw new Error('unreachable') }
