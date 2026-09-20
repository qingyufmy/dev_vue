import { expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlRuntimeModelProfileCatalog } from '../src/modules/inference/infrastructure/mysql-model-gateway-resolver.js'

it('uses the strategy model before the usage default and does not fall back when inaccessible', async () => {
  const requested: unknown[][] = []
  const pool = { execute: async (sql: string, values: unknown[]) => {
    if (sql.includes('user_model_assignments_v4')) return [[{ id: '8' }], []]
    requested.push(values)
    return [[], []]
  } } as unknown as Pool
  const profiles = new MysqlRuntimeModelProfileCatalog(pool, new Map(), { allowPrivateEndpoints: false, maxAttempts: 1, defaultTimeoutMs: 30000 },
    { canUseCurrent: async () => true, canUseFrozenReview: async () => true, readModelProfileId: async () => '3' },
    { readMany: async () => new Map() })
  await expect(profiles.resolve({ userId: 7, strategyId: '1', strategyVersionId: '2', usage: 'auto' })).rejects.toMatchObject({ code: 'model_profile_unavailable' })
  expect(requested).toEqual([['3', 7]])
})
