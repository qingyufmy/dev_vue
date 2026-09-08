import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../frontend/packages/api-client/src/index.ts'
import { createMarketHttp } from '../src/modules/market/composition.ts'
import { MarketReadError } from '../src/modules/market/domain/calendar.ts'

it('consumes all market routes through shared transport, preserving revision/decimal precision and cancellation', async () => {
  const stamp = '2026-09-09T00:00:00.000Z', revision = '9007199254740993'
  const snapshot = { id: 'snapshot-1', schema_version: 1, revision, business_date: '2026-09-09', horizon: 'medium_term',
    data_cutoff_at: stamp, published_at: stamp, valid_until: '2026-09-10T00:00:00.000Z', status: 'fresh', direction: 'uncertain',
    summary: '背景', factors: [], content_sha256: 'a'.repeat(64) }
  const { factors, ...summary } = snapshot
  const event = { id: 'event-1', provider_event_id: null, country: 'US', currency: 'USD', title: 'CPI', scheduled_at: stamp,
    time_precision: 'exact', importance: 'high', period: null, unit: '%', previous: '1.1234567890', consensus: null, actual: null,
    revised_previous: null, status: 'scheduled', provider_updated_at: null, revision }
  const page = items => ({ items, has_more: false, next_cursor: null })
  const calendar = { list: vi.fn(async () => page([event])), find: vi.fn(async () => event) }
  const series = { list: vi.fn(async () => page([{ code: 'DFII10', observation_at: stamp, available_at: stamp, value: '1.1234567890', unit: '%', freshness: 'invalid' }])) }
  const snapshots = { list: vi.fn(async () => page([{ ...summary, factor_count: 0 }])), find: vi.fn(async () => snapshot),
    latest: vi.fn(async () => snapshot), overview: vi.fn(async () => ({ snapshot: { ...summary, factor_count: 0 }, high_impact_events: [event] })) }
  const app = Fastify(), controller = new AbortController()
  await app.register(createMarketHttp(calendar, { authenticate: async () => ({ userId: 1 }) }, series, snapshots))
  const fetchImpl = vi.fn(async (url, init) => {
    expect(init.credentials).toBe('same-origin'); expect(init.cache).toBe('no-store')
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const response = await app.inject(url)
    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': String(response.headers['content-type']) } })
  })
  const client = createApiClient({ fetchImpl })
  try {
    expect((await client.listMacroSnapshots()).data.items[0]).toMatchObject({ revision, factorCount: 0 })
    expect((await client.getMacroSnapshot('snapshot-1')).data.revision).toBe(revision)
    expect((await client.getLatestMacroSnapshot()).data.revision).toBe(revision)
    expect((await client.listMacroSeriesPoints({ code: 'DFII10', from: stamp, limit: 1 }, controller.signal)).data.items[0]).toMatchObject({ value: '1.1234567890', observationAt: stamp })
    expect(fetchImpl.mock.calls.at(-1)[1].signal).toBe(controller.signal)
    await client.listEconomicCalendarEvents({ from: stamp, to: stamp, importance: 'high', cursor: 'a+b&c' })
    expect(calendar.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'a+b&c', importance: 'high' }))
    expect((await client.getEconomicCalendarEvent('event-1')).data).toMatchObject({ revision, previous: '1.1234567890', scheduledAt: stamp })
    expect((await client.getMacroMarketOverview()).data.snapshot.factorCount).toBe(0)
    snapshots.latest.mockRejectedValueOnce(new MarketReadError('macro_snapshot_not_found', 404))
    await expect(client.getLatestMacroSnapshot()).rejects.toMatchObject({ status: 404, problem: { code: 'macro_snapshot_not_found' } })
    controller.abort()
    await expect(client.getMacroMarketOverview(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  } finally { await app.close() }
})
