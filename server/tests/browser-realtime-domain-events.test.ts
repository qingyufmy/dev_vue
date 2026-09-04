import { describe, expect, it } from 'vitest'
import type { Redis } from 'ioredis'
import type { Pool } from 'mysql2/promise'
import { CompositeOutboxPublisher, RedisOutboxRealtimePublisher } from '../src/outbox/index.js'
import type { ClaimedOutboxEvent, OutboxTaskPublisher } from '../src/outbox/index.js'
import { parseBrowserRealtimeEvent } from '../src/modules/trading/index.js'

const occurredAt = '2026-09-04T08:00:00.000Z'

describe('browser realtime domain projector', () => {
  it('projects small user and account events from committed rows and excludes full model and risk payloads', async () => {
    const redis = new FakeRedis()
    const publisher = new RedisOutboxRealtimePublisher(new FakePool() as unknown as Pool, redis as unknown as Redis)
    await publisher.publish(event('analysis.requested', { analysis_id: 'analysis-1' }))
    await publisher.publish(event('market_analysis.created', { market_analysis_id: 'market-1' }))
    await publisher.publish(event('trade_decision.created', { decision_id: 'decision-1', status: 'proposed' }))
    await publisher.publish(event('risk.summary.changed', { account_id: '7' }))
    await publisher.publish(event('operation.changed', { operation_id: 'operation-1' }))
    await publisher.publish(event('execution.intent.prepared', { intent_id: 'intent-1' }))

    const messages = redis.messages.map(item => JSON.parse(item) as Record<string, unknown>)
    expect(messages).toHaveLength(7)
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'market_analysis.created', accountId: null, userId: 42, resource: 'market_analysis',
      data: expect.objectContaining({ market_bias: 'bullish', opportunity: 'long_setup', confidence: 78 }),
    }))
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'trade_decision.created', accountId: '7', resource: 'trade_decision',
      data: expect.objectContaining({ action: 'market_order', side: 'buy', status: 'proposed' }),
    }))
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'risk.summary.changed', accountId: '7', resource: 'risk.summary',
      data: { account_id: '7', data_complete: true, revision: '6' },
    }))
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'operation.changed', accountId: '7', resource: 'operation',
      data: expect.objectContaining({ operation_id: 'operation-1', status: 'uncertain' }),
    }))
    expect(JSON.stringify(messages)).not.toMatch(/analysisBody|reasoning|approvedActions|policy_json|evaluation_json/)
    for (const raw of redis.messages) expect(parseBrowserRealtimeEvent(raw)).not.toBeNull()
  })

  it('requires every publisher to finish before an outbox row may be marked dispatched', async () => {
    const order: string[] = []
    const first: OutboxTaskPublisher = { async publish() { order.push('queue') } }
    const second: OutboxTaskPublisher = { async publish() { order.push('realtime'); throw new Error('redis_unavailable') } }
    await expect(new CompositeOutboxPublisher([first, second]).publish(
      event('analysis.requested', { analysis_id: 'analysis-1' }),
    )).rejects.toThrow('redis_unavailable')
    expect(order).toEqual(['queue', 'realtime'])
  })

  it('rejects events whose user or account scope disagrees with their event type', () => {
    const invalid = {
      eventId: 'event-invalid-scope', type: 'market_analysis.created', occurredAt, userId: 42,
      accountId: '7', terminalInstanceId: null, resource: 'market_analysis', resourceId: 'analysis-1',
      revision: 1, data: {},
    }
    expect(parseBrowserRealtimeEvent(JSON.stringify(invalid))).toBeNull()
  })
})

class FakeRedis {
  messages: string[] = []
  async publish(_channel: string, value: string) { this.messages.push(value); return 1 }
}

class FakePool {
  async execute(sql: string) {
    if (sql.includes('FROM ai_analysis_runs')) return [[{
      id: 'analysis-1', user_id: 42, strategy_id: 'strategy-1', standard_symbol: 'XAUUSD',
      status: 'queued', updated_at_utc: new Date(occurredAt), revision: 1,
    }], []]
    if (sql.includes('FROM market_analyses')) return [[{
      id: 'market-1', analysis_run_id: 'analysis-1', owner_user_id: 42, strategy_id: 'strategy-1',
      standard_symbol: 'XAUUSD', market_bias: 'bullish', opportunity: 'long_setup', confidence: '78',
      valid_until_utc: new Date('2026-09-04T08:05:00.000Z'), revision: 1,
      run_status: 'succeeded', run_updated_at_utc: new Date(occurredAt), run_revision: 3,
    }], []]
    if (sql.includes('FROM trade_decisions')) return [[{
      id: 'decision-1', user_id: 42, trading_account_id: '7', market_analysis_id: 'market-1',
      action_kind: 'market_order', side: 'buy', confidence: '72', status: 'proposed', stale_reason: null,
      revision: 1, trader_run_id: 'trader-1', task_mode: 'entry', run_status: 'succeeded',
      run_updated_at_utc: new Date(occurredAt), run_revision: 3,
    }], []]
    if (sql.includes('FROM account_risk_states')) return [[{
      user_id: 42, account_id: '7', data_complete: 1, revision: 6,
    }], []]
    if (sql.includes('FROM operations')) return [[{
      id: 'operation-1', user_id: 42, account_id: '7', kind: 'risk_decision_execution',
      status: 'uncertain', updated_at_utc: new Date(occurredAt), resource_id: 'ticket-8',
      error_code: 'terminal_result_unknown', revision: 4,
    }], []]
    throw new Error('unexpected_sql')
  }
}

function event(eventType: ClaimedOutboxEvent['eventType'], payload: Record<string, unknown>): ClaimedOutboxEvent {
  return { id: '1', eventId: 'event-12345678', eventType, occurredAt, payload, attempts: 1 }
}
