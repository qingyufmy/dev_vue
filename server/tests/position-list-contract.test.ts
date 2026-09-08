import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { TradingService } from '../src/modules/trading/application/trading-service.js'
import type { TradingReadRepository } from '../src/modules/trading/application/trading-ports.js'
import { PositionListService } from '../src/modules/trading/application/position-list-service.js'
import { positionListRoutes } from '../src/modules/trading/transport/http/position-list-routes.js'

async function fixture() {
  const snapshot = { revision: 4, items: ['9007199254740993', '1001', '2001'].map(ticket => ({
    ticket, accountId: '7', symbol: 'XAUUSD', side: 'buy' as const, volume: '0.10', openPrice: '2000.00', currentPrice: '2001.00',
    stopLoss: null, takeProfit: null, floatingProfit: '1.00', openedAt: '2026-09-09T00:00:00.000Z', source: 'unknown' as const, signalId: null, revision: 4,
  })) }
  const repository = { findOwnedAccount: vi.fn(async () => ({ id: '7' } as { id: string } | null)), listPositions: vi.fn(async () => snapshot) }
  const authenticate = vi.fn(async () => ({ userId: 42, role: 'user' }))
  const app = Fastify()
  await app.register(positionListRoutes, { prefix: '/api/v4', service: new PositionListService(new TradingService(repository as unknown as TradingReadRepository)),
    auth: { authenticate, assertWrite: async () => { throw Error('read must not invoke write auth') } } })
  return { app, snapshot, repository, authenticate }
}

it('returns contract DTOs and exact tickets with revision-scoped stable pagination', async () => {
  const f = await fixture()
  try {
    const first = await f.app.inject('/api/v4/positions?account_id=7&page_size=2')
    expect(first.statusCode).toBe(200)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.json().data.map((row: { ticket: string }) => row.ticket)).toEqual(['1001', '2001'])
    expect(first.json().data[0]).toMatchObject({ account_id: '7', revision: '4', volume: '0.10', source: 'unknown' })
    const cursor = first.json().meta.next_cursor
    const second = await f.app.inject(`/api/v4/positions?account_id=7&page_size=2&cursor=${cursor}`)
    expect(second.statusCode).toBe(200)
    expect(second.json().data[0].ticket).toBe('9007199254740993')
    expect(second.json().meta).toMatchObject({ has_more: false, next_cursor: null, page_size: 1 })
    expect(second.headers.etag).not.toBe(first.headers.etag)
    expect(f.repository.listPositions).toHaveBeenCalledWith('7', 42)
    f.snapshot.revision++
    expect((await f.app.inject(`/api/v4/positions?account_id=7&cursor=${cursor}`)).statusCode).toBe(409)
    expect((await f.app.inject(`/api/v4/positions?account_id=8&cursor=${cursor}`)).statusCode).toBe(400)
  } finally { await f.app.close() }
})

it('rejects missing or invalid pagination and never reads another owner account', async () => {
  const f = await fixture()
  try {
    for (const query of ['', '?account_id=7&page_size=0', '?account_id=7&page_size=201', '?account_id=7&cursor=bad!']) {
      expect((await f.app.inject('/api/v4/positions' + query)).statusCode).toBe(400)
    }
    expect(f.repository.listPositions).not.toHaveBeenCalled()
    f.repository.findOwnedAccount.mockResolvedValue(null)
    expect((await f.app.inject('/api/v4/positions?account_id=7')).statusCode).toBe(403)
    expect(f.repository.listPositions).not.toHaveBeenCalled()
  } finally { await f.app.close() }
})

it('does not publish positions if ownership disappears during the read', async () => {
  const f = await fixture()
  try {
    f.repository.findOwnedAccount.mockResolvedValueOnce({ id: '7' }).mockResolvedValueOnce(null)
    const result = await f.app.inject('/api/v4/positions?account_id=7')
    expect(result.statusCode).toBe(403)
    expect(result.json().data).toBeUndefined()
  } finally { await f.app.close() }
})

it('rejects unauthenticated reads and sanitizes invalid snapshot content', async () => {
  const f = await fixture()
  try {
    f.authenticate.mockRejectedValueOnce(new AuthError('session_required', 401))
    expect((await f.app.inject('/api/v4/positions?account_id=7')).statusCode).toBe(401)
    expect(f.repository.listPositions).not.toHaveBeenCalled()
    f.snapshot.items[0]!.accountId = '8'
    const invalid = await f.app.inject('/api/v4/positions?account_id=7')
    expect(invalid.statusCode).toBe(503)
    expect(invalid.body).not.toContain('9007199254740993')
  } finally { await f.app.close() }
})
