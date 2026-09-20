import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { reviewArchivedActivityRoutes } from '../src/modules/reviews/transport/http/review-archived-activity-routes.js'
it('rejects malformed pagination before reading and masks storage failures', async () => {
  const app = Fastify(), page = vi.fn(async () => ({ items: [], total: 0, nextOffset: null }))
  try {
    await app.register(reviewArchivedActivityRoutes, { reader: { page }, auth: { authenticate: async () => ({ userId: 7 }), assertWrite: vi.fn() } })
    for (const query of ['page_size=0','page_size=101','offset=-1','offset=10001','offset=1e2','offset=0&offset=1','unknown=1'])
      expect((await app.inject('/review-cases/c/history/events?' + query)).statusCode).toBe(400)
    expect(page).not.toHaveBeenCalled()
    for (const kind of ['jobs','events','stages']) expect((await app.inject('/review-cases/c/history/' + kind)).statusCode).toBe(200)
    expect(page).toHaveBeenLastCalledWith(7, 'c', 'stages', { limit: 20, offset: 0 })
    page.mockRejectedValueOnce(new Error('private SQL details'))
    const result = await app.inject('/review-cases/c/history/jobs')
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain('private SQL')
    expect(result.headers['cache-control']).toBe('no-store')
  } finally { await app.close() }
})
