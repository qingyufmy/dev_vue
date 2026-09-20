import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { reviewHistoryRoutes } from '../src/modules/reviews/transport/http/review-history-routes.js'
import { ReviewError } from '../src/modules/reviews/domain/review.js'
const reader = () => ({ listVersions: vi.fn(async () => ({ items: [], nextBeforeVersion: null })),
  version: vi.fn(async () => { throw new ReviewError('review_version_not_found', 404) }), metadata: vi.fn(async () => null) })
it('validates pagination and errors before reading and hides unexpected storage failures', async () => {
  const r = reader(), app = Fastify()
  try {
    await app.register(reviewHistoryRoutes, { reader: r, auth: { authenticate: async () => ({ userId: 7 }), assertWrite: vi.fn() } })
    for (const query of ['page_size=0', 'page_size=101', 'page_size=1e2', 'page_size=1&page_size=2', 'before_version=0', 'other=1'])
      expect((await app.inject('/review-cases/c1/versions?' + query)).statusCode).toBe(400)
    expect(r.listVersions).not.toHaveBeenCalled()
    expect((await app.inject('/review-cases/c1/versions?page_size=1&before_version=4')).statusCode).toBe(200)
    expect(r.listVersions).toHaveBeenCalledWith(7, 'c1', { limit: 1, beforeVersion: 4 })
    expect((await app.inject('/review-cases/c1/versions/v2')).statusCode).toBe(404)
    r.metadata.mockRejectedValueOnce(new Error('private SQL connection detail'))
    const failure = await app.inject('/review-cases/c1/history')
    expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain('private SQL')
    expect(failure.headers['cache-control']).toBe('no-store')
    expect((await app.inject('/review-cases/c1/history')).json().data).toBeNull()
  } finally { await app.close() }
})
