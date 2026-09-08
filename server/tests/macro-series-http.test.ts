import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { MacroSeriesService } from '../src/modules/market/application/macro-series-service.js'
import { MacroFreshnessPolicy } from '../src/modules/market/domain/macro-freshness.js'
import { macroSeriesRoutes } from '../src/modules/market/transport/http/macro-series-routes.js'

async function fixture() {
  const row = { code: 'DFII10', observationAt: '2026-09-07T00:00:00.000Z', availableAt: '2026-09-07T12:00:00.000Z',
    value: '1.1234567890', unit: '%', valueKind: 'decimal' as const, calendar: 'unregistered-us-calendar', freshnessLimitSeconds: 259200, status: 'enabled' as const }
  const reader = { list: vi.fn(async () => [row]) }, authenticate = vi.fn(async () => ({ userId: 1 }))
  const app = Fastify()
  await app.register(macroSeriesRoutes, { prefix: '/api/v4', auth: { authenticate },
    service: new MacroSeriesService(reader, new MacroFreshnessPolicy(), () => new Date('2026-09-09T00:00:00.000Z')) })
  return { app, reader, authenticate, row }
}

it('returns contract DTO with precise decimals, reports unknown calendar and supports real empty results', async () => {
  const f = await fixture()
  try {
    const response = await f.app.inject('/api/v4/market/macro-series?code=DFII10')
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().data).toMatchObject({ items: [{ value: '1.1234567890', freshness: 'invalid' }], has_more: false, next_cursor: null })
    expect(response.json().data.items[0]).not.toHaveProperty('calendar')
    f.reader.list.mockResolvedValueOnce([])
    expect((await f.app.inject('/api/v4/market/macro-series?code=DFII10')).json().data.items).toEqual([])
  } finally { await f.app.close() }
})

it('authenticates before query validation and never queries malformed requests', async () => {
  const f = await fixture()
  try {
    f.authenticate.mockRejectedValueOnce(new AuthError('session_required', 401))
    expect((await f.app.inject('/api/v4/market/macro-series')).statusCode).toBe(401)
    for (const query of ['', '?code=DFII10&limit=101', '?code=DFII10&from=invalid', '?code=DFII10&cursor=oops']) {
      expect((await f.app.inject('/api/v4/market/macro-series' + query)).statusCode).toBe(400)
    }
    expect(f.reader.list).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('sanitizes database errors and rejects invalid response data instead of returning a fake empty page', async () => {
  const f = await fixture()
  try {
    f.reader.list.mockRejectedValueOnce(new Error('sensitive SQL here'))
    const failure = await f.app.inject('/api/v4/market/macro-series?code=DFII10')
    expect(failure.statusCode).toBe(503)
    expect(failure.body).not.toContain('sensitive')
    f.reader.list.mockResolvedValueOnce([{ ...f.row, value: 'NaN' }])
    expect((await f.app.inject('/api/v4/market/macro-series?code=DFII10')).statusCode).toBe(503)
  } finally { await f.app.close() }
})
