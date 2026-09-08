import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { MacroSnapshotService } from '../src/modules/market/application/macro-snapshot-service.js'
import { macroSnapshotRoutes } from '../src/modules/market/transport/http/macro-snapshot-routes.js'
import { sha256Canonical } from '../src/shared/canonical-json.js'
import type { ReadableMacroSnapshot } from '../src/modules/market/application/macro-snapshot-reader.js'

async function fixture() {
  let now = '2026-09-09T00:00:00.000Z'
  const payload = { display: { direction: 'uncertain', summary: '研究背景', factors: [] }, analysis_evidence: { secret: 'private' } }
  const row: ReadableMacroSnapshot = { record: { id: 'snapshot-1', schemaVersion: 1, revision: '9007199254740993', businessDate: '2026-09-08',
    horizon: 'medium_term', dataCutoffAt: '2026-09-08T00:00:00.000Z', publishedAt: '2026-09-08T01:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z',
    status: 'fresh', contentSha256: sha256Canonical(payload), payload }, observations: [{ factorCode: 'internal', observationAt: '2026-09-07T00:00:00.000Z',
    availableAt: '2026-09-07T00:00:00.000Z', ingestedAt: '2026-09-07T00:00:00.000Z', value: '1' }] }
  const reader = { list: vi.fn(async () => [row]) }, authenticate = vi.fn(async () => ({ userId: 1 }))
  const calendar = { list: vi.fn(async () => ({ items: [], has_more: false, next_cursor: null })) }
  const app = Fastify()
  await app.register(macroSnapshotRoutes, { prefix: '/api/v4', auth: { authenticate }, service: new MacroSnapshotService(reader, calendar, () => new Date(now)) })
  return { app, reader, authenticate, calendar, row, setNow: (value: string) => { now = value } }
}

it('serves all four contracts, keeps detail precision and makes list/overview summaries', async () => {
  const f = await fixture()
  try {
    for (const path of ['macro-snapshots', 'macro-snapshots/latest', 'macro-snapshots/snapshot-1', 'overview']) {
      const response = await f.app.inject('/api/v4/market/' + path)
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.body).not.toMatch(/private|analysis_evidence/)
      const data = response.json().data
      if (path === 'macro-snapshots') { expect(data.items[0].factor_count).toBe(0); expect(data.items[0]).not.toHaveProperty('factors') }
      else if (path === 'overview') expect(data.snapshot.factor_count).toBe(0)
      else { expect(data.revision).toBe('9007199254740993'); expect(response.headers.etag).toMatch(/^W\/"macro-/) }
    }
    const before = await f.app.inject('/api/v4/market/macro-snapshots/snapshot-1')
    f.setNow(f.row.record.validUntil)
    const after = await f.app.inject('/api/v4/market/macro-snapshots/snapshot-1')
    expect(after.json().data.status).toBe('stale')
    expect(after.headers.etag).not.toBe(before.headers.etag)
  } finally { await f.app.close() }
})

it('authenticates before validation and rejects bad paging before database access', async () => {
  const f = await fixture()
  try {
    f.authenticate.mockRejectedValueOnce(new AuthError('session_required', 401))
    expect((await f.app.inject('/api/v4/market/macro-snapshots?limit=bad')).statusCode).toBe(401)
    for (const query of ['limit=101', 'cursor=invalid']) expect((await f.app.inject('/api/v4/market/macro-snapshots?' + query)).statusCode).toBe(400)
    expect(f.reader.list).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('returns missing 404, valid empty overview and sanitized 503 without fallback success', async () => {
  const f = await fixture()
  try {
    f.reader.list.mockResolvedValue([])
    expect((await f.app.inject('/api/v4/market/macro-snapshots/latest')).statusCode).toBe(404)
    expect((await f.app.inject('/api/v4/market/macro-snapshots/missing')).statusCode).toBe(404)
    expect((await f.app.inject('/api/v4/market/overview')).json().data).toEqual({ snapshot: null, high_impact_events: [] })
    f.reader.list.mockRejectedValueOnce(new Error('private SQL'))
    const failure = await f.app.inject('/api/v4/market/macro-snapshots')
    expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain('private SQL')
    f.calendar.list.mockRejectedValueOnce(new Error('private provider'))
    expect((await f.app.inject('/api/v4/market/overview')).statusCode).toBe(503)
    f.reader.list.mockResolvedValueOnce([{ ...f.row, record: { ...f.row.record, contentSha256: '0'.repeat(64) } }])
    expect((await f.app.inject('/api/v4/market/macro-snapshots/latest')).statusCode).toBe(503)
  } finally { await f.app.close() }
})
