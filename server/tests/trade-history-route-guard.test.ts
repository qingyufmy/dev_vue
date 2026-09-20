import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'
import { MysqlTradeHistoryCollectorRepository } from '../src/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'

const route = { userId: 7, accountId: '42', platform: 'mt5', connectionId: 'old-route' } as BridgeGatewayRoute
it.each(['begin', 'persistPage', 'complete', 'fail'] as const)('refuses %s writes after the transaction route guard rejects', async method => {
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), execute: vi.fn() }
  const assert = vi.fn().mockRejectedValue(new Error('trading_context_invalid'))
  const factory = vi.fn(() => ({ assert }))
  const repository = new MysqlTradeHistoryCollectorRepository({ getConnection: async () => connection } as unknown as Pool, factory)
  const now = new Date()
  const work = method === 'begin' ? repository.begin(route, now)
    : method === 'complete' ? repository.complete(route, now.getTime(), now, [])
      : method === 'fail' ? repository.fail(route, 'failed', now)
        : repository.persistPage(route, 'history.orders', { payload: { resource: 'history.orders', items: [] } } as unknown as BridgeQueryResponseEnvelope, now)
  await expect(work).rejects.toThrow('trading_context_invalid')
  expect(factory).toHaveBeenCalledWith(connection)
  expect(assert).toHaveBeenCalledWith(route)
  expect(connection.execute).not.toHaveBeenCalled()
  expect(connection.commit).not.toHaveBeenCalled()
  expect(connection.rollback).toHaveBeenCalledOnce()
  expect(connection.release).toHaveBeenCalledOnce()
})
