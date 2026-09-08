import { describe, expect, it } from 'vitest'
import {
  BrowserRealtimeHub,
  BrowserRealtimeSession,
} from '../src/modules/trading/index.js'
import { parseBrowserRealtimeEvent } from '../src/modules/trading/infrastructure/redis-browser-realtime-subscriber.js'

const occurredAt = '2026-09-05T08:00:00.000Z'

describe('platform macro realtime contract', () => {
  it('delivers one platform invalidation to each authenticated subscriber without exposing another user scope', async () => {
    const first: unknown[] = []
    const second: unknown[] = []
    const hub = new BrowserRealtimeHub({} as never)
    const firstSession = new BrowserRealtimeSession(42, hub, sink(first))
    const secondSession = new BrowserRealtimeSession(99, hub, sink(second))

    await firstSession.receive(subscribe('macro-42', 'macro'))
    await secondSession.receive(subscribe('macro-99', 'macro'))
    hub.publish({
      eventId: 'macro-event-1', type: 'market.macro.changed', occurredAt,
      userId: null, accountId: null, terminalInstanceId: null,
      resource: 'macro_snapshot', resourceId: 'macro-snapshot-1', revision: 7,
      data: { change: 'updated', published_at: occurredAt, status: 'fresh' },
    })

    expect(first).toContainEqual(expect.objectContaining({
      type: 'market.macro.changed', scope: expect.objectContaining({ user_id: '42', trading_account_id: null }),
      resource: { kind: 'macro_snapshot', id: 'macro-snapshot-1' },
    }))
    expect(second).toContainEqual(expect.objectContaining({
      type: 'market.macro.changed', scope: expect.objectContaining({ user_id: '99', trading_account_id: null }),
    }))
    firstSession.closeSubscriptions()
    secondSession.closeSubscriptions()
  })

  it('supports the calendar platform target and rejects admin-only source health, account, or cursor scope', async () => {
    const sent: unknown[] = []
    const session = new BrowserRealtimeSession(42, new BrowserRealtimeHub({} as never), sink(sent))
    await session.receive({
      v: 4, type: 'subscription.subscribe', request_id: 'platform-targets', targets: [target('calendar')],
    })
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'subscription.ready', request_id: 'platform-targets', subscriptions: expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ resource_id: 'calendar' }) }),
      ]),
    }))

    await session.receive({
      v: 4, type: 'subscription.subscribe', request_id: 'admin-only-health',
      targets: [target('source_health')],
    })

    await session.receive({
      v: 4, type: 'subscription.subscribe', request_id: 'bad-account',
      targets: [{ ...target('macro'), trading_account_id: '7' }],
    })
    await session.receive({
      v: 4, type: 'subscription.subscribe', request_id: 'bad-cursor',
      targets: [{ ...target('macro'), after_revision: '3' }],
    })
    expect(sent.filter(message => (message as { type?: string }).type === 'protocol.error')).toHaveLength(3)
    session.closeSubscriptions()
  })

  it('accepts only strict, minimal platform invalidation payloads', () => {
    const valid = {
      eventId: 'macro-event-2', type: 'market.calendar.changed', occurredAt,
      userId: null, accountId: null, terminalInstanceId: null,
      resource: 'calendar_event', resourceId: 'calendar-event-1', revision: 2,
      data: { change: 'updated', scheduled_at: occurredAt, importance: 'high', status: 'released' },
    }
    expect(parseBrowserRealtimeEvent(JSON.stringify(valid))).toEqual(expect.objectContaining({
      type: 'market.calendar.changed', userId: null,
    }))
    expect(parseBrowserRealtimeEvent(JSON.stringify({ ...valid, userId: 42 }))).toBeNull()
    expect(parseBrowserRealtimeEvent(JSON.stringify({ ...valid, accountId: '7' }))).toBeNull()
    expect(parseBrowserRealtimeEvent(JSON.stringify({
      ...valid, data: { ...valid.data, full_snapshot: { forbidden: true } },
    }))).toBeNull()
  })
})

function subscribe(requestId: string, resourceId: 'macro' | 'calendar' | 'source_health') {
  return { v: 4, type: 'subscription.subscribe', request_id: requestId, targets: [target(resourceId)] }
}

function target(resourceId: 'macro' | 'calendar' | 'source_health') {
  return {
    kind: 'market', trading_account_id: null, observer_channel_id: null,
    symbol: null, timeframe: null, resource_id: resourceId, after_revision: null,
  }
}

function sink(messages: unknown[]) {
  return {
    send(value: unknown) { messages.push(value) },
    close() { throw new Error('unexpected_close') },
  }
}
