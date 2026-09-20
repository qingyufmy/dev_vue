import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import { historyTaskRoute, freezeHistoryCollectionClaim } from '../src/modules/trade-history/application/history-collection-task.js'
import { lockHistoryCollectionTask } from '../src/modules/trade-history/infrastructure/mysql-history-task-lock.js'

const route: BridgeGatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
  brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', sessionId: 'session', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const identity = historyTaskRoute(route)
const claim = { taskId: '00000000-0000-4000-8000-000000000001', accountId: '5', leaseToken: '00000000-0000-4000-8000-000000000002',
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, routeHash: identity.hash }
function fixture() {
  const row = { session_timezone: '+00:00', status: 'running', lease_token: claim.leaseToken, lease_live: 1,
    route_sha256: identity.hash, route_json: identity.json, start_msc: '1000.000', end_msc: '2000.000' }
  const execute = vi.fn(async () => [[row], []])
  return { row, execute, connection: { execute } as unknown as PoolConnection }
}
it('locks the exact task/account and returns a copied claim', async () => {
  const f = fixture(), copy = { ...claim }
  const result = await lockHistoryCollectionTask(f.connection, copy, route, 'page')
  expect(result).toEqual(claim)
  expect(result).not.toBe(copy)
  expect(f.execute).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [claim.taskId, '5'])
})
it.each(['old-token', 'expired', 'completed', 'window', 'route', 'timezone'])('fences %s writers', async kind => {
  const f = fixture()
  if (kind === 'old-token') f.row.lease_token = '00000000-0000-4000-8000-000000000003'
  if (kind === 'expired') f.row.lease_live = 0
  if (kind === 'completed') f.row.status = 'succeeded'
  if (kind === 'window') f.row.end_msc = '2001'
  if (kind === 'route') f.row.route_sha256 = 'b'.repeat(64)
  if (kind === 'timezone') f.row.session_timezone = '+08:00'
  await expect(lockHistoryCollectionTask(f.connection, claim, route, 'page')).rejects.toThrow('history_task_lease_lost')
})
it('requires prepared completion and forbids adding pages after preparation', async () => {
  const f = fixture()
  await expect(lockHistoryCollectionTask(f.connection, claim, route, 'complete')).rejects.toThrow('history_task_lease_lost')
  f.row.status = 'completing'
  await expect(lockHistoryCollectionTask(f.connection, claim, route, 'complete')).resolves.toEqual(claim)
  await expect(lockHistoryCollectionTask(f.connection, claim, route, 'page')).rejects.toThrow('history_task_lease_lost')
})
it.each(['{}', 'not-json'])('rejects a corrupt persisted route %s', async value => {
  const f = fixture(); f.row.route_json = value
  await expect(lockHistoryCollectionTask(f.connection, claim, route, 'page')).rejects.toThrow('history_task_route_corrupt')
})
it.each([{ accountId: '6' }, { connectionId: 'new-connection' }, { timezoneOffsetMinutes: 120 }, { ownershipRevision: '3' }])(
  'rejects changed current scope before touching SQL %j', async patch => {
    const f = fixture()
    await expect(lockHistoryCollectionTask(f.connection, claim, { ...route, ...patch }, 'page')).rejects.toThrow('history_task_claim_mismatch')
    expect(f.execute).not.toHaveBeenCalled()
  })
it('does not permit invalid task identities, window or missing ownership revision', () => {
  expect(() => freezeHistoryCollectionClaim({ ...claim, accountId: '18446744073709551616' })).toThrow('history_task_claim_invalid')
  expect(() => freezeHistoryCollectionClaim({ ...claim, rangeEndUtcMsc: 1000 })).toThrow('history_task_claim_invalid')
  const unknownOwner = { ...route }; delete unknownOwner.ownershipRevision
  expect(() => historyTaskRoute(unknownOwner)).toThrow('history_task_route_invalid')
})
