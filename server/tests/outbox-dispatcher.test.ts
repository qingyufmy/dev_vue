import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlOutboxRepository } from '../src/outbox/infrastructure/mysql-outbox-repository.js'
import { OutboxDispatcher } from '../src/outbox/application/outbox-dispatcher.js'
import type { ClaimedOutboxEvent } from '../src/outbox/application/outbox-ports.js'

function event(attempts = 1): ClaimedOutboxEvent {
  return { id: '1', eventId: 'event-12345678', eventType: 'execution.intent.prepared', occurredAt: '2026-09-04T00:00:00.000Z', payload: { intent_id: 'intent-12345678' }, attempts }
}

describe('OutboxDispatcher', () => {
  it('publishes before marking the MySQL outbox event dispatched', async () => {
    const order: string[] = []
    const repository = {
      claim: async () => [event()],
      markDispatched: async () => { order.push('mark'); return true },
      retry: async () => { throw new Error('must_not_retry') },
    }
    const dispatcher = new OutboxDispatcher(repository, { publish: async () => { order.push('publish') } })
    await expect(dispatcher.runBatch()).resolves.toEqual({ claimed: 1, dispatched: 1, failed: 0 })
    expect(order).toEqual(['publish', 'mark'])
  })

  it('returns a failed publication to bounded backoff and dead-letters the final attempt', async () => {
    const retries: Array<{ dead: boolean; availableAt: Date }> = []
    const repository = {
      claim: async () => [event(12)],
      markDispatched: async () => false,
      retry: async (_id: string, _owner: string, availableAt: Date, dead: boolean) => {
        retries.push({ dead, availableAt }); return true
      },
    }
    const now = new Date('2026-09-03T00:00:00.000Z')
    const dispatcher = new OutboxDispatcher(repository, { publish: async () => { throw new Error('queue_down') } }, 12, () => now)
    await expect(dispatcher.runBatch()).resolves.toEqual({ claimed: 1, dispatched: 0, failed: 1 })
    expect(retries).toHaveLength(1)
    expect(retries[0]!.dead).toBe(true)
    expect(retries[0]!.availableAt.getTime()).toBeGreaterThan(now.getTime())
  })
})


describe('MySQL outbox due clock', () => {
  it('does not use a lagging worker clock for DB-created immediate events', async () => {
    const hostNow = new Date('2026-09-15T11:00:00Z')
    const databaseNow = new Date('2026-09-15T11:00:30Z')
    const pending = [
      { id: '1', event_id: 'due', event_type: 'operation.changed', payload_json: {}, attempts: 0, created_at_utc: databaseNow, due: databaseNow },
      { id: '2', event_id: 'future', event_type: 'operation.changed', payload_json: {}, attempts: 0, created_at_utc: databaseNow, due: new Date(databaseNow.getTime() + 60_000) },
    ]
    const connection = {
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
      execute: async (sql: string, values: unknown[]) => {
        if (!sql.startsWith('SELECT')) return [{ affectedRows: 1 }]
        const cutoff = sql.includes('available_at_utc<=UTC_TIMESTAMP(3)') ? databaseNow : values[0] as Date
        return [pending.filter(row => row.due <= cutoff)]
      },
    }
    const repository = new MysqlOutboxRepository({ getConnection: async () => connection } as unknown as Pool)
    const events = await repository.claim('worker', 50, 30, hostNow)
    expect(events.map(event => event.eventId)).toEqual(['due'])
  })
})
