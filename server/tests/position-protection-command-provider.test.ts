import { beforeEach, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeCommand } from '../src/modules/execution/index.js'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { PositionProtectionReviewPort } from '../src/modules/execution/application/position-protection-preparation.js'
const mocks = vi.hoisted(() => ({ replay: vi.fn(async () => {}), bind: vi.fn(async () => {}) }))
vi.mock('../src/modules/execution/composition.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  replayPositionProtectionCommandBinding: mocks.replay, writePositionProtectionCommandBinding: mocks.bind,
  createMysqlPositionProtectionCommandReviewer: (_db: PoolConnection, current: PositionProtectionReviewPort) => ({
    review: () => current.review({} as Parameters<PositionProtectionReviewPort['review']>[0]),
  }),
}))
import { createPositionProtectionCommandProviderCapture } from '../src/bootstrap/position-protection-command-provider.js'
const db = {} as PoolConnection
const input = { id: 'command', executionIntentId: 'intent', userId: 7, accountId: '5', requestHash: 'hash', status: 'queued' } as BridgeCommand
const limits = { maxAgeMs: 1000, maxInstrumentAgeMs: 1000 }
beforeEach(() => vi.clearAllMocks())

it('recovers a stored binding during Redis failure without requesting fresh authorization', async () => {
  const failure = new Error('redis_unavailable'), current = vi.fn(async () => { throw failure })
  const provider = await createPositionProtectionCommandProviderCapture({ current }, limits)(input)
  await provider.replay(db, { ...input, status: 'accepted' }, 'workflow')
  expect(mocks.replay).toHaveBeenCalledExactlyOnceWith(db, { ...input, status: 'accepted' }, 'workflow')
  await expect(provider.authorize(db, input, 'workflow')).rejects.toBe(failure)
  expect(current).toHaveBeenCalledTimes(1)
})
it('rejects reuse across command scopes before SQL replay or authorization', async () => {
  const provider = await createPositionProtectionCommandProviderCapture({ current: async () => null }, limits)(input)
  await expect(provider.replay(db, { ...input, accountId: '6' }, 'workflow')).rejects.toThrow('position_protection_command_scope_mismatch')
  await expect(provider.authorize(db, { ...input, requestHash: 'changed' }, 'workflow')).rejects.toThrow('position_protection_command_scope_mismatch')
  expect(mocks.replay).not.toHaveBeenCalled()
})
it('freezes route facts before the transaction', async () => {
  const route = { userId: 8, accountId: '5', platform: 'mt5' } as BridgeGatewayRoute
  const current = vi.fn(async () => route)
  const provider = await createPositionProtectionCommandProviderCapture({ current }, limits)(input)
  route.userId = 7
  await expect(provider.authorize(db, input, 'workflow')).rejects.toThrow('position_protection_context_unavailable')
  expect(current).toHaveBeenCalledTimes(1)
})
