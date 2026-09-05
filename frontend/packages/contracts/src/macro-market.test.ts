import { describe, expect, it } from 'vitest'

import {
  browserRealtimeEventSchema,
  economicCalendarEventSchema,
  economicCalendarEventsResponseSchema,
  macroSeriesResponseSchema,
  macroMarketOverviewResponseSchema,
  macroSnapshotResponseSchema,
  macroSnapshotsResponseSchema,
  marketCalendarChangedRealtimeEventSchema,
  marketMacroChangedRealtimeEventSchema,
  marketSourceHealthChangedRealtimeEventSchema,
} from './index'

const now = '2026-09-05T08:00:00.000Z'
const meta = { request_id: 'request-macro-1', generated_at: now }

const factor = {
  code: 'DFII10', label: '美国10年实际利率', value: '1.82', unit: 'percent',
  observation_at: '2026-09-04T00:00:00.000Z', available_at: now,
  freshness: 'fresh', gold_relation: 'adverse',
}

const snapshot = {
  id: 'macro-snapshot-1', schema_version: 1, revision: '4', business_date: '2026-09-05',
  horizon: 'medium_term', data_cutoff_at: now, published_at: now,
  valid_until: '2026-09-06T08:00:00.000Z', status: 'fresh', direction: 'uncertain',
  summary: '核心因子存在分歧，暂不形成综合方向。', factors: [factor],
  content_sha256: 'a'.repeat(64),
}

const calendarEvent = {
  id: 'calendar-event-1', provider_event_id: 'te-1', country: 'United States', currency: 'USD',
  title: '非农就业人数', scheduled_at: '2026-09-05T12:30:00.000Z', time_precision: 'exact',
  importance: 'high', period: '2026-08', unit: 'thousands', previous: '135', consensus: '160',
  actual: null, revised_previous: null, status: 'scheduled', provider_updated_at: now, revision: '2',
}

const envelope = {
  v: 4, event_id: 'event-macro-1', occurred_at: now, sequence: 12,
  scope: { user_id: 'user-1', trading_account_id: null, terminal_instance_id: null, observer_channel_id: null },
  revision: '4', correlation_id: null,
}

describe('macro market HTTP contracts', () => {
  it('parses a strict snapshot and keeps decimal/time fields typed', () => {
    const { factors: _factors, ...snapshotSummary } = snapshot
    expect(macroSnapshotResponseSchema.parse({ data: snapshot, meta })).toMatchObject({
      data: { id: 'macro-snapshot-1', revision: 4, factors: [{ code: 'DFII10', observationAt: factor.observation_at, value: '1.82' }] },
    })
    expect(macroSnapshotsResponseSchema.safeParse({ data: {
      items: [{ ...snapshot, factor_count: 1 }], next_cursor: null, has_more: false,
    }, meta }).success).toBe(false)
    expect(macroSnapshotsResponseSchema.safeParse({ data: {
      items: [{ ...snapshotSummary, factor_count: 1 }], next_cursor: null, has_more: false,
    }, meta }).success).toBe(true)
  })

  it('supports nullable provider values and rejects non-UTC or camelCase fields', () => {
    expect(economicCalendarEventSchema.parse({ ...calendarEvent, provider_event_id: null, currency: null, previous: null, consensus: null })).toMatchObject({
      providerEventId: null, currency: null, scheduledAt: calendarEvent.scheduled_at, actual: null, revision: 2,
    })
    expect(economicCalendarEventsResponseSchema.safeParse({ data: { items: [calendarEvent], next_cursor: null, has_more: false }, meta }).success).toBe(true)
    expect(macroSnapshotResponseSchema.safeParse({ data: { ...snapshot, published_at: '2026-09-05T16:00:00+08:00' }, meta }).success).toBe(false)
    expect(macroSnapshotResponseSchema.safeParse({ data: { ...snapshot, schemaVersion: 1 }, meta }).success).toBe(false)
  })

  it('keeps the series response bounded to point records', () => {
    expect(macroSeriesResponseSchema.safeParse({ data: { items: [{
      code: 'T10YIE', observation_at: '2026-09-04T00:00:00.000Z', available_at: now,
      value: '2.1', unit: 'percent', freshness: 'fresh',
    }], next_cursor: null, has_more: false }, meta }).success).toBe(true)
  })

  it('keeps overview bounded to one snapshot summary and nearby high-impact events', () => {
    const { factors: _factors, ...snapshotSummary } = snapshot
    expect(macroMarketOverviewResponseSchema.safeParse({ data: {
      snapshot: { ...snapshotSummary, factor_count: 1 }, high_impact_events: [calendarEvent],
    }, meta }).success).toBe(true)
    expect(macroMarketOverviewResponseSchema.safeParse({ data: {
      snapshot: { ...snapshotSummary, factor_count: 1 }, high_impact_events: Array.from({ length: 21 }, () => calendarEvent),
    }, meta }).success).toBe(false)
  })
})

describe('macro market realtime contracts', () => {
  it('accepts the three minimal event variants and the browser union', () => {
    const macro = { ...envelope, type: 'market.macro.changed', resource: { kind: 'macro_snapshot', id: snapshot.id }, data: { change: 'updated', published_at: now, status: 'fresh' } }
    const calendar = { ...envelope, type: 'market.calendar.changed', resource: { kind: 'calendar_event', id: calendarEvent.id }, data: { change: 'created', scheduled_at: calendarEvent.scheduled_at, importance: 'high', status: 'scheduled' } }
    const health = { ...envelope, type: 'market.source_health.changed', resource: { kind: 'macro_source_health', id: 'fred' }, data: { source_id: 'fred', health: 'healthy', observed_at: now } }

    expect(marketMacroChangedRealtimeEventSchema.safeParse(macro).success).toBe(true)
    expect(marketCalendarChangedRealtimeEventSchema.safeParse(calendar).success).toBe(true)
    expect(marketSourceHealthChangedRealtimeEventSchema.safeParse(health).success).toBe(true)
    expect(browserRealtimeEventSchema.safeParse(macro).success).toBe(true)
    expect(browserRealtimeEventSchema.safeParse(calendar).success).toBe(true)
    expect(browserRealtimeEventSchema.safeParse(health).success).toBe(true)
  })

  it('rejects account-scoped macro events and full payloads on the realtime path', () => {
    const event = { ...envelope, type: 'market.macro.changed', resource: { kind: 'macro_snapshot', id: snapshot.id }, data: { change: 'updated', published_at: now, status: 'fresh' } }
    expect(marketMacroChangedRealtimeEventSchema.safeParse({ ...event, scope: { ...envelope.scope, trading_account_id: 'account-1' } }).success).toBe(false)
    expect(marketMacroChangedRealtimeEventSchema.safeParse({ ...event, data: { ...event.data, factors: [factor] } }).success).toBe(false)
  })
})
