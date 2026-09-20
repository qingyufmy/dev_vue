import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { HistoryResourcePageChain } from '../src/modules/trade-history/application/trade-history-collector-ports.js'
import { historyTaskRoute } from '../src/modules/trade-history/application/history-collection-task.js'
import { historyTaskCompletion } from '../src/modules/trade-history/application/history-task-completion.js'
import { MysqlHistoryCollectionTasks } from '../src/modules/trade-history/infrastructure/mysql-history-collection-tasks.js'

const taskId = '00000000-0000-4000-8000-000000000001'
const route: BridgeGatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
  brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', sessionId: 'session', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
function fixture() {
  const row = { session_timezone: '+00:00', status: 'pending', attempts: 0, lease_live: 0, retry_at: '2030-01-01T00:00:00.000000Z',
    start_msc: '1000.000', end_msc: '2000.000', route_json: null as string | null, route_sha256: null as string | null,
    completion_json: null as string | null, completion_sha256: null as string | null, lease_token: null as string | null }
  const trace: string[] = [], connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT')) { trace.push('lock'); return [[{ ...row }]] }
      trace.push('update')
      if (sql.includes("SET status='failed'")) { row.status = 'failed'; row.lease_token = null; row.lease_live = 0 }
      else if (sql.includes('SET status=?')) {
        row.status = String(values[0]); row.attempts++; row.lease_live = 1; row.lease_token = String(values[1])
        row.route_json = String(values[2]); row.route_sha256 = String(values[3])
        row.completion_json = values[4] as string | null; row.completion_sha256 = values[5] as string | null
      }
      return [{ affectedRows: 1 }]
    }) }
  const guard = vi.fn(async () => { trace.push('guard') })
  const tasks = new MysqlHistoryCollectionTasks({ getConnection: async () => connection } as unknown as Pool, () => ({ assert: guard }))
  return { row, trace, connection, tasks, guard }
}
it('authorizes before locking and creates a durable fresh lease over the original window', async () => {
  const f = fixture(), result = await f.tasks.claim(taskId, route)
  expect(f.trace).toEqual(['guard', 'lock', 'update'])
  expect(result).toMatchObject({ state: 'collecting', claim: { taskId, accountId: '5', rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, routeHash: historyTaskRoute(route).hash } })
  expect(f.row.attempts).toBe(1)
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
it('does not steal a live lease, even at the attempt limit', async () => {
  const f = fixture(); await f.tasks.claim(taskId, route)
  f.row.attempts = 5; f.trace.length = 0
  expect(await f.tasks.claim(taskId, route)).toEqual({ state: 'busy', retryAt: '2030-01-01T00:00:00.000Z' })
  expect(f.trace).toEqual(['guard', 'lock'])
})
it('rotates an expired lease and fences renewal by the old token', async () => {
  const f = fixture(), first = await f.tasks.claim(taskId, route)
  if (first.state !== 'collecting') throw Error('fixture')
  f.row.lease_live = 0
  const second = await f.tasks.claim(taskId, route)
  if (second.state !== 'collecting') throw Error('fixture')
  expect(second.claim.leaseToken).not.toBe(first.claim.leaseToken)
  await expect(f.tasks.renew(first.claim, route)).rejects.toThrow('history_task_lease_lost')
  await f.tasks.renew(second.claim, route)
  expect(f.row.attempts).toBe(2)
})
it.each([false, true])('restores prepared evidence only when route identity is unchanged (changed=%s)', async changed => {
  const f = fixture(), first = await f.tasks.claim(taskId, route)
  if (first.state !== 'collecting') throw Error('fixture')
  const chains: HistoryResourcePageChain[] = ['history.orders', 'history.deals'].map(resource => ({ resource: resource as HistoryResourcePageChain['resource'],
    rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, source: 'terminal', sourceRevision: 'r1', pageCount: 1, itemCount: 0, pageChainHash: 'a'.repeat(64) }))
  const completion = historyTaskCompletion(first.claim, route, chains)
  Object.assign(f.row, { status: 'completing', lease_live: 0, completion_json: completion.json, completion_sha256: completion.hash })
  const result = await f.tasks.claim(taskId, changed ? { ...route, connectionEpoch: 4 } : route)
  expect(result.state).toBe(changed ? 'collecting' : 'completing')
  if (result.state === 'completing') expect(result.completion).toEqual(completion)
  expect(f.row.completion_sha256).toBe(changed ? null : completion.hash)
})
it('rejects corrupt prior route evidence rather than overwriting it during takeover', async () => {
  const f = fixture(); await f.tasks.claim(taskId, route)
  f.row.lease_live = 0; f.row.route_json = '{}'
  await expect(f.tasks.claim(taskId, { ...route, connectionEpoch: 4 })).rejects.toThrow('history_task_route_corrupt')
  expect(f.row.attempts).toBe(1)
})
it('ends exhausted expired tasks without creating a sixth lease', async () => {
  const f = fixture(); await f.tasks.claim(taskId, route)
  f.row.attempts = 5; f.row.lease_live = 0
  expect(await f.tasks.claim(taskId, route)).toEqual({ state: 'terminal', status: 'failed' })
  expect(f.row.attempts).toBe(5); expect(f.row.lease_token).toBeNull()
})
it('keeps committed terminal tasks terminal without a new claim', async () => {
  const f = fixture(); f.row.status = 'succeeded'
  expect(await f.tasks.claim(taskId, route)).toEqual({ state: 'terminal', status: 'succeeded' })
  expect(f.trace).toEqual(['guard', 'lock'])
})
it('reports lost claim commit as unknown and destroys its connection', async () => {
  const f = fixture(); f.connection.commit.mockRejectedValueOnce(Error('socket_closed'))
  await expect(f.tasks.claim(taskId, route)).rejects.toThrow('trade_history_commit_unknown')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
})
