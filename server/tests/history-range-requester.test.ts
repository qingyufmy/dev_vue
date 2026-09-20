import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlHistoryRangeRequester } from '../src/modules/trade-history/infrastructure/mysql-history-range-requester.js'

const scope = { taskId: '00000000-0000-4000-8000-000000000001', accountId: '5', userId: 7, platform: 'mt5' as const,
  ownershipIntervalId: 'interval', rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000 }
const route = { userId: 7, accountId: '5', platform: 'mt5', ownershipRevision: '3' }
function fixture(storedRoute: unknown = route) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('@@session.time_zone')) return [[{ timezone: '+00:00' }]]
    if (sql.includes('start_msc')) return [[{ id: scope.taskId, start_msc: '1000', end_msc: '2000' }]]
    if (sql.includes('FROM outbox_events')) return [[{ aggregate_type: 'trade_history_task', aggregate_id: scope.taskId,
      event_type: 'trade.history.task.requested', payload_json: { task_id: scope.taskId } }]]
    if (sql.includes('SELECT status,route_json')) return [[{ status: 'succeeded', route_json: storedRoute }]]
    throw Error('unexpected_sql')
  })
  const lockAccount = vi.fn(), authorize = vi.fn(async () => ({ ownershipRevision: '3' }))
  return { execute, lockAccount, authorize, requester: createMysqlHistoryRangeRequester({ execute } as unknown as PoolConnection, { lockAccount }, authorize) }
}
it('returns a same-owner completed task without registering another task or outbox event', async () => {
  const f = fixture()
  expect(await f.requester.ensure(scope,new Date(3000))).toEqual({ status: 'completed', taskId: scope.taskId })
  expect(f.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  expect(f.lockAccount.mock.invocationCallOrder[0]).toBeLessThan(f.authorize.mock.invocationCallOrder[0]!)
})
it.each([{ ...route, userId: 8 },{ ...route, ownershipRevision: '2' },{ ...route, accountId: '6' },{ ...route, platform: 'mt4' }])(
  'does not treat a task completed under changed ownership or platform as usable: %o', async stored => {
    expect(await fixture(stored).requester.ensure(scope,new Date(3000))).toMatchObject({ status: 'unavailable', reason: 'history_range_owner_changed' })
  })
it('rejects a corrupt completed route and a future requested window', async () => {
  await expect(fixture(null).requester.ensure(scope,new Date(3000))).rejects.toThrow('history_range_route_invalid')
  const f = fixture()
  await expect(f.requester.ensure(scope,new Date(1999))).rejects.toThrow('history_range_scope_invalid')
  expect(f.lockAccount).not.toHaveBeenCalled()
})
