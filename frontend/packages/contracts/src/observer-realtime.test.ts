import { describe, expect, it } from 'vitest'
import {
  browserRealtimeEventSchema, observerPublicationChangedRealtimeEventSchema,
} from './index.js'

const event = {
  v: 4 as const,
  event_id: 'observer:source-event:channel-1',
  type: 'observer.publication.changed' as const,
  occurred_at: '2026-09-05T08:00:00.000Z',
  sequence: 1,
  scope: {
    user_id: '99', trading_account_id: '7', terminal_instance_id: null,
    observer_channel_id: 'channel-1',
  },
  resource: { kind: 'observer_publication', id: 'channel-1' },
  revision: '12',
  data: { channel_id: 'channel-1', source_revision: '12', resource: 'market.quote', resource_id: 'XAUUSD' },
  correlation_id: null,
}

describe('observer realtime publication contract', () => {
  it('accepts the value-free publication invalidation envelope', () => {
    expect(observerPublicationChangedRealtimeEventSchema.safeParse(event).success).toBe(true)
    expect(browserRealtimeEventSchema.safeParse(event).success).toBe(true)
  })

  it('rejects source event mixing and any private publication body', () => {
    expect(browserRealtimeEventSchema.safeParse({
      ...event,
      type: 'market.quote.updated',
      resource: { kind: 'observer_publication', id: 'channel-1' },
      data: { login: 'private-login' },
    }).success).toBe(false)
    expect(observerPublicationChangedRealtimeEventSchema.safeParse({
      ...event, data: { ...event.data, profile_id: 'private-profile' },
    }).success).toBe(false)
  })

  it('requires the target channel identity to be consistent', () => {
    expect(observerPublicationChangedRealtimeEventSchema.safeParse({
      ...event, resource: { kind: 'observer_publication', id: 'other-channel' },
    }).success).toBe(false)
    expect(observerPublicationChangedRealtimeEventSchema.safeParse({
      ...event, data: { ...event.data, resource: 'runtime.bridge' },
    }).success).toBe(false)
  })
})
