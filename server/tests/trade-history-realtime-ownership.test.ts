import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import { RedisOutboxRealtimePublisher } from '../src/outbox/infrastructure/redis-outbox-realtime-publisher.js'
import type { ClaimedOutboxEvent } from '../src/outbox/application/outbox-ports.js'

const event: ClaimedOutboxEvent = { id: '1', eventId: 'event_12345678', eventType: 'trade.history.changed',
  occurredAt: '2026-09-05T12:00:00.000Z', payload: { account_id: '42' }, attempts: 1 }

describe('P3 history invalidation audiences', () => {
  it('notifies former and current historical owners without forwarding the current owner sync time', async () => {
    const execute = vi.fn(async () => [[1, 2].map(userId => ({ user_id: userId, account_id: '42', history_revision: 6 })), []])
    const publish = vi.fn(async () => 1)
    await new RedisOutboxRealtimePublisher({ execute } as unknown as Pool, { publish } as unknown as Redis).publish(event)
    const histories = publish.mock.calls.map(call => JSON.parse((call as unknown as [string, string])[1])).filter(value => value.type === 'trade.history.changed')
    expect(histories.map(value => value.userId)).toEqual([1, 2])
    const audits = publish.mock.calls.map(call => JSON.parse((call as unknown as [string, string])[1])).filter(value => value.type === 'audit.changed')
    expect(audits.map(value => value.userId)).toEqual([1, 2])
    for (const value of histories) expect(value.data).toEqual({ status: 'stale', history_revision: '6', fresh_through: null })
    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('trading_account_ownership_intervals')
    expect(sql).not.toContain('revoked_at_utc')
    expect(sql).toContain('hi.user_id>? ORDER BY hi.user_id LIMIT 100')
    expect(params).toEqual(['42', 0])
  })
  it('uses keyset pages, never duplicates users across page boundaries and sends nothing for no recipients', async () => {
    const execute = vi.fn(async () => [[...Array.from({ length: 100 }, (_, i) => ({ user_id: i + 1, account_id: '42', history_revision: 7 }))], []])
    execute.mockResolvedValueOnce([Array.from({ length: 100 }, (_, i) => ({ user_id: i + 1, account_id: '42', history_revision: 7 })), []])
    execute.mockResolvedValueOnce([[{ user_id: 105, account_id: '42', history_revision: 7 }], []])
    const publish = vi.fn(async () => 1)
    await new RedisOutboxRealtimePublisher({ execute } as unknown as Pool, { publish } as unknown as Redis).publish(event)
    expect((execute.mock.calls[1] as unknown as [string, unknown[]])[1]).toEqual(['42', 100])
    const histories = publish.mock.calls.map(call => JSON.parse((call as unknown as [string, string])[1])).filter(value => value.type === 'trade.history.changed')
    expect(histories).toHaveLength(101)
    expect(new Set(histories.map(value => value.userId)).size).toBe(101)
    const emptyPublish = vi.fn(async () => 0)
    await new RedisOutboxRealtimePublisher({ execute: async () => [[], []] } as unknown as Pool, { publish: emptyPublish } as unknown as Redis).publish(event)
    expect(emptyPublish).not.toHaveBeenCalled()
  })
})
