import { beforeEach, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
const ports = vi.hoisted(() => ({ owner: vi.fn(), clock: vi.fn(), resolve: vi.fn(), inventory: vi.fn(), write: vi.fn() }))
vi.mock('../src/modules/auth/composition.js', () => ({ createActivePrincipalAccess: () => ({}) }))
vi.mock('../src/modules/trading/composition.js', () => ({
  createMysqlOwnedHistoryAccess: () => ({ read: ports.owner }),
  createMysqlHistoricalClockReader: () => ({ read: ports.clock, resolveLocal: ports.resolve }),
}))
vi.mock('../src/modules/reviews/composition.js', () => ({ createMysqlPeriodReviewWriter: () => ({ write: ports.write }) }))
vi.mock('../src/bootstrap/period-review-inventory.js', () => ({ createTransactionPeriodReviewInventory: () => ({ read: ports.inventory }) }))
import { createTransactionPeriodReviewCollector } from '../src/bootstrap/period-review-collector.js'

const start = Date.parse('2026-09-09T21:00:00.000Z'), end = start + 86400000
const input = { taskId: 'task', route: { userId: 7, accountId: '5', platform: 'mt5' as const }, ownershipIntervalId: 'interval',
  asOfUtcMsc: end + 60000, period: { kind: 'daily' as const, key: '2026-09-10',
    start: { utcMsc: start, offsetMinutes: 180, evidenceRef: 'caller:untrusted' },
    end: { utcMsc: end, offsetMinutes: 180, evidenceRef: 'caller:untrusted' } } }
const collector = () => createTransactionPeriodReviewCollector({} as PoolConnection)
const collect = () => collector().collect(input as Parameters<ReturnType<typeof collector>['collect']>[0])
beforeEach(() => {
  vi.resetAllMocks()
  ports.owner.mockResolvedValue({})
  ports.clock.mockImplementation(async scope => ({ utcMsc: scope.utcMsc, offsetMinutes: 180, evidenceRef: `clock:verified:${scope.utcMsc}` }))
  ports.resolve.mockImplementation(async scope => ({ utcMsc: scope.localMidnightMsc-180*60000, offsetMinutes: 180, evidenceRef: 'clock:resolved' }))
  ports.inventory.mockImplementation(async scope => ({ status: 'selected', period: scope.period }))
  ports.write.mockResolvedValue({ status: 'collected' })
})
it('accepts a calendar key and resolves both boundaries without a current offset from the caller', async () => {
  const { period, ...scope } = input
  const value = { ...scope, kind: period.kind, key: period.key }
  expect(await collector().collectCalendar(value as Parameters<ReturnType<typeof collector>['collectCalendar']>[0])).toEqual({ status: 'collected' })
  expect(ports.resolve).toHaveBeenCalledTimes(2)
  expect(ports.write.mock.calls[0]![1].period.start.utcMsc).toBe(start)
  ports.resolve.mockResolvedValue(null); ports.write.mockClear()
  expect(await collector().collectCalendar(value as Parameters<ReturnType<typeof collector>['collectCalendar']>[0])).toMatchObject({ reason: 'period_clock_unavailable' })
  expect(ports.write).not.toHaveBeenCalled()
})
it('authorizes both boundary times before reading inventory and replaces caller evidence references', async () => {
  expect(await collect()).toEqual({ status: 'collected' })
  expect(ports.owner).toHaveBeenCalledWith(expect.objectContaining({ openedAt: new Date(start).toISOString(), closedAt: new Date(end).toISOString() }))
  const stored = ports.write.mock.calls[0]![1].period
  expect(stored.start.evidenceRef).toBe(`clock:verified:${start}`)
  expect(stored.end.evidenceRef).toBe(`clock:verified:${end}`)
  expect(input.period.start.evidenceRef).toBe('caller:untrusted')
})
it('does not collect or write under missing ownership or clock evidence', async () => {
  ports.owner.mockResolvedValue(null)
  expect(await collect()).toMatchObject({ reason: 'period_ownership_unavailable' })
  expect(ports.clock).not.toHaveBeenCalled()
  ports.owner.mockResolvedValue({}); ports.clock.mockResolvedValue(null)
  expect(await collect()).toMatchObject({ reason: 'period_clock_unavailable' })
  expect(ports.inventory).not.toHaveBeenCalled(); expect(ports.write).not.toHaveBeenCalled()
})
it('does not turn a mismatched offset or incomplete inventory into a period review', async () => {
  ports.clock.mockResolvedValue({ utcMsc: start, offsetMinutes: 120, evidenceRef: 'clock:other' })
  expect(await collect()).toMatchObject({ reason: 'period_clock_unavailable' })
  ports.clock.mockImplementation(async scope => ({ utcMsc: scope.utcMsc, offsetMinutes: 180, evidenceRef: 'clock:correct' }))
  ports.inventory.mockResolvedValue({ status: 'unresolved', reason: 'period_trade_source_incomplete' })
  expect(await collect()).toMatchObject({ reason: 'period_trade_source_incomplete' })
  expect(ports.write).not.toHaveBeenCalled()
})
