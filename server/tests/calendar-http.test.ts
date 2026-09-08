import { MacroSnapshotService } from '../src/modules/market/application/macro-snapshot-service.js'
import { MacroSeriesService } from '../src/modules/market/application/macro-series-service.js'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { CalendarService, type CalendarEvent, MarketReadError } from '../src/modules/market/index.js'
import { createMarketHttp } from '../src/modules/market/composition.js'

const now = '2026-09-09T00:00:00.000Z'
const record = (id: string): CalendarEvent => ({ id, provider_event_id: 'provider-1', country: 'US', currency: 'USD', title: 'CPI',
  scheduled_at: now, time_precision: 'exact', importance: 'high', period: null, unit: '%', previous: '3.1000000000',
  consensus: null, actual: null, revised_previous: null, status: 'scheduled', provider_updated_at: null, revision: '9007199254740993' })

async function fixture() {
  const reader = { list: vi.fn(async () => [record('a'), record('b')]), find: vi.fn(async () => record('a') as CalendarEvent | null) }
  const authenticate = vi.fn(async () => ({ userId: 7 }))
  const app = Fastify()
  await app.register(createMarketHttp(new CalendarService(reader, () => new Date(now)), { authenticate }, new MacroSeriesService({ list: async () => [] }, { evaluate: () => 'invalid' }), new MacroSnapshotService({ list: async () => [] }, new CalendarService(reader))))
  return { app, reader, authenticate }
}

it('preserves decimals and revisions and binds pagination to filters and exact tie-breaker', async () => {
  const f = await fixture()
  try {
    const query = `?from=${now}&to=${now}&limit=1&importance=high`
    const response = await f.app.inject('/api/v4/market/calendar-events' + query)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().data.items[0]).toMatchObject({ previous: '3.1000000000', revision: '9007199254740993' })
    const cursor = response.json().data.next_cursor
    await f.app.inject('/api/v4/market/calendar-events' + query + '&cursor=' + cursor)
    expect(f.reader.list).toHaveBeenLastCalledWith(expect.objectContaining({ after: { id: 'a', scheduledAt: now }, limit: 2 }), now)
    expect((await f.app.inject('/api/v4/market/calendar-events' + query.replace('high', 'low') + '&cursor=' + cursor)).statusCode).toBe(400)
    const detail = await f.app.inject('/api/v4/market/calendar-events/a')
    expect(detail.statusCode).toBe(200)
    expect(detail.headers.etag).toMatch(/^W\/"calendar-/)
  } finally { await f.app.close() }
})

it('authenticates before reading and rejects malformed intervals without querying', async () => {
  const f = await fixture()
  try {
    f.authenticate.mockRejectedValueOnce(new AuthError('session_required', 401))
    expect((await f.app.inject('/api/v4/market/calendar-events/a')).statusCode).toBe(401)
    expect(f.reader.find).not.toHaveBeenCalled()
    for (const query of ['', `?from=${now}&to=2026-09-08T00:00:00.000Z`, `?from=${now}&to=${now}&limit=101`]) {
      expect((await f.app.inject('/api/v4/market/calendar-events' + query)).statusCode).toBe(400)
    }
    expect(f.reader.list).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('distinguishes absent or unpublishable data from backend failure and invalid payloads', async () => {
  const f = await fixture()
  try {
    f.reader.find.mockResolvedValueOnce(null)
    expect((await f.app.inject('/api/v4/market/calendar-events/a')).statusCode).toBe(404)
    f.reader.find.mockRejectedValueOnce(new MarketReadError('calendar_unavailable', 503))
    expect((await f.app.inject('/api/v4/market/calendar-events/a')).statusCode).toBe(503)
    f.reader.find.mockResolvedValueOnce({ ...record('a'), previous: 'private invalid value' })
    const invalid = await f.app.inject('/api/v4/market/calendar-events/a')
    expect(invalid.statusCode).toBe(503)
    expect(invalid.body).not.toContain('private invalid value')
  } finally { await f.app.close() }
})
