import type { Pool, PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { inBridgeRouteTransaction } from '../src/modules/bridge/infrastructure/mysql-bridge-route-transaction.js'
import { PrincipalTransactionAbortedError } from '../src/modules/auth/index.js'
import { BridgeGatewayError } from '../src/modules/bridge/domain/bridge-gateway.js'

function fixture(fail: 'begin' | 'commit' | 'rollback' | null = null) {
  let durable = 0
  const logs: string[][] = []
  const pool = { async getConnection() {
    let pending = durable
    const log: string[] = []; logs.push(log)
    return {
      async beginTransaction() { log.push('begin'); if (fail === 'begin') throw Error('private') },
      async execute() { log.push('write'); pending++; return [] },
      async commit() { log.push('commit'); durable = pending; if (fail === 'commit') throw Object.assign(Error('lost ack'), { code: 'ER_LOCK_DEADLOCK' }) },
      async rollback() { log.push('rollback'); if (fail === 'rollback') throw Error('private'); pending = durable },
      destroy() { log.push('destroy') }, release() { log.push('release') },
    }
  } }
  return { pool: pool as unknown as Pool, logs, durable: () => durable }
}

it.each([Object.assign(Error('private deadlock'), { code: 'ER_LOCK_DEADLOCK' }), new PrincipalTransactionAbortedError()])(
  'restarts all database work after a definitive abort and successful rollback', async error => {
    const f = fixture()
    const work = vi.fn(async (connection: PoolConnection) => {
      await connection.execute('write')
      if (f.logs.length === 1) throw error
      return 'authorized-route'
    })
    expect(await inBridgeRouteTransaction(f.pool, work)).toBe('authorized-route')
    expect(f.logs).toEqual([['begin', 'write', 'rollback', 'release'], ['begin', 'write', 'commit', 'release']])
    expect(work).toHaveBeenCalledTimes(2)
    expect(work.mock.calls[0]![0]).not.toBe(work.mock.calls[1]![0])
    expect(f.durable()).toBe(1)
  })

it('bounds deadlocks and preserves business rejection without retrying it', async () => {
  const f = fixture()
  await expect(inBridgeRouteTransaction(f.pool, async () => { throw new PrincipalTransactionAbortedError() }))
    .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable' })
  expect(f.logs).toHaveLength(3)
  const denied = fixture()
  await expect(inBridgeRouteTransaction(denied.pool, async () => { throw new BridgeGatewayError('bridge_route_binding_invalid', 403) }))
    .rejects.toMatchObject({ code: 'bridge_route_binding_invalid', status: 403 })
  expect(denied.logs).toHaveLength(1)
})

it('does not retry a commit error even when its code resembles a deadlock', async () => {
  const f = fixture('commit')
  await expect(inBridgeRouteTransaction(f.pool, connection => connection.execute('write')))
    .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable' })
  expect(f.logs).toEqual([['begin', 'write', 'commit', 'destroy']])
  expect(f.durable()).toBe(1)
})

it.each(['begin', 'rollback'] as const)('destroys uncertain %s connections without retry or pool reuse', async fail => {
  const f = fixture(fail)
  await expect(inBridgeRouteTransaction(f.pool, async () => { throw new PrincipalTransactionAbortedError() }))
    .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable' })
  expect(f.logs).toEqual([fail === 'begin' ? ['begin', 'destroy'] : ['begin', 'rollback', 'destroy']])
})

it('does not retry lock timeouts or connection loss', async () => {
  for (const code of ['ER_LOCK_WAIT_TIMEOUT', 'PROTOCOL_CONNECTION_LOST']) {
    const f = fixture()
    await expect(inBridgeRouteTransaction(f.pool, async () => { throw Object.assign(Error('private'), { code }) }))
      .rejects.toMatchObject({ code: 'bridge_route_storage_unavailable' })
    expect(f.logs).toEqual([['begin', 'rollback', 'release']])
  }
})
