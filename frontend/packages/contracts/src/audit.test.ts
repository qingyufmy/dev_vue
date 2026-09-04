import { describe, expect, it } from 'vitest'
import { auditEventDetailResponseSchema, auditEventPageResponseSchema, browserRealtimeEventSchema } from './index'

const now = '2026-09-04T08:00:00.000Z'
const meta = { request_id: 'request-1', generated_at: now }
const event = {
  source_kind: 'operation', source_id: 'operation-1', account_id: '42', category: 'execution', actor: 'system',
  action: 'position.close', status: 'succeeded', title: '交易操作', summary: 'ticket-1', reason_code: null,
  symbol: 'XAUUSD', occurred_at: now, terminal_timezone_offset_minutes: 180, correlation_id: 'operation-1',
}

describe('audit contracts', () => {
  it('normalizes frozen pages without accepting raw payload fields', () => {
    const parsed = auditEventPageResponseSchema.parse({ data: { captured_end: now, items: [event], next_cursor: null,
      has_more: false, summary: { total: 1, succeeded: 1, rejected: 0, failed: 0, uncertain: 0, active: 0 } }, meta })
    expect(parsed.data.items[0]).toMatchObject({ sourceKind: 'operation', sourceId: 'operation-1', accountId: '42' })
    expect(auditEventPageResponseSchema.safeParse({ data: { captured_end: now, items: [{ ...event, payload_json: {} }], next_cursor: null,
      has_more: false, summary: { total: 1, succeeded: 1, rejected: 0, failed: 0, uncertain: 0, active: 0 } }, meta }).success).toBe(false)
  })

  it('parses an exact execution trace and stable evidence links', () => {
    const parsed = auditEventDetailResponseSchema.parse({ data: { event, trace: [{ stage: 'bridge', status: 'succeeded',
      source_kind: 'bridge_command', source_id: 'command-1', title: 'Bridge 指令', detail: 'position.close', reason_code: null,
      occurred_at: now }], evidence: [{ label: '交易账户', value: '42' }], links: [{ kind: 'operation', id: 'operation-1', label: '查看执行操作' }] }, meta })
    expect(parsed.data.trace[0]).toMatchObject({ stage: 'bridge', sourceKind: 'bridge_command' })
  })

  it('accepts user-scoped lightweight audit invalidation only', () => {
    const message = { v: 4, event_id: 'event-1', type: 'audit.changed', occurred_at: now, sequence: 1,
      scope: { user_id: '7', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null },
      resource: { kind: 'audit', id: 'all' }, revision: '3', data: { source_type: 'operation.changed', source_id: 'operation-1' }, correlation_id: null }
    expect(browserRealtimeEventSchema.safeParse(message).success).toBe(true)
    expect(browserRealtimeEventSchema.safeParse({ ...message, scope: { ...message.scope, observer_channel_id: 'observer-1' } }).success).toBe(false)
  })
})
