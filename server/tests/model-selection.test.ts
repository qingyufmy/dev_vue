import { expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createModelSelection } from '../src/modules/inference/infrastructure/mysql-model-selection.js'

it('rejects unverified or unavailable choices and makes the same default selection idempotent', async () => {
  let selected = '1', writes = 0, shared = true
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, execute: async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM user_model_defaults')) return [[{ id: selected }]]
    if (sql.includes('FROM platform_model_usage_policy')) return [[{ share_for_manual: shared, allowed_plans: ['pro'] }]]
    if (sql.includes('FROM ai_model_profiles')) return [[{ id: '1', scope: 'user', name: 'Personal', verification_status: 'unverified' }, { id: '3', scope: 'platform', name: 'Shared', verification_status: 'verified', protocol: 'responses', provider: 'p', verified_provider: 'p', model_name: 'm', verified_model: 'm', api_base_url: 'https://example.com/v1', verified_base: 'https://example.com/v1/' }]]
    if (sql.startsWith('INSERT')) { selected = String(args[1]); writes++; return [] }
    throw Error('Unexpected query')
  } }
  const service = createModelSelection({ getConnection: async () => connection } as unknown as Pool, () => ({ readMany: async () => new Map([[1, { userId: 1, plan: 'pro', planExpiresAtUtc: null, tokenVersion: 1 }]]) }))
  expect((await service.read(1)).items[0]?.available).toBe(false)
  await expect(service.select(1, '1', '1')).rejects.toThrow()
  await expect(service.select(1, '3', '2')).rejects.toThrow()
  expect((await service.select(1, '3', '1')).selected_model_profile_id).toBe('3')
  await service.select(1, '3', '1')
  expect(writes).toBe(1)
  shared = false
  await expect(service.select(1, '3', '3')).rejects.toThrow()
})
