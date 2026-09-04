import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './index'

describe('audit API client', () => {
  it('encodes filters and source identifiers on V4 audit routes', async () => {
    const now = '2026-09-04T08:00:00.000Z'
    const meta = { request_id: 'request-1', generated_at: now }
    const event = { source_kind: 'operation', source_id: 'operation/1', account_id: '42', category: 'execution', actor: 'system',
      action: 'position.close', status: 'succeeded', title: '交易操作', summary: 'ticket-1', reason_code: null, symbol: 'XAUUSD',
      occurred_at: now, terminal_timezone_offset_minutes: null, correlation_id: 'operation/1' }
    const responses = [
      { data: { captured_end: now, items: [event], next_cursor: null, has_more: false,
        summary: { total: 1, succeeded: 1, rejected: 0, failed: 0, uncertain: 0, active: 0 } }, meta },
      { data: { event, trace: [], evidence: [], links: [] }, meta },
    ]
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }))
    const client = createApiClient({ fetchImpl })
    await client.listAuditEvents({ accountId: 'account/1', category: 'execution', status: 'succeeded', actor: 'system',
      from: '2026-09-01T00:00:00.000Z', to: now, query: 'ticket 1', pageSize: 25, cursor: 'cursor/1' })
    await client.getAuditEvent('operation', 'operation/1')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/audit/events?page_size=25&account_id=account%2F1&category=execution&status=succeeded&actor=system&from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-04T08%3A00%3A00.000Z&q=ticket+1&cursor=cursor%2F1')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/audit/events/operation/operation%2F1')
  })
})
