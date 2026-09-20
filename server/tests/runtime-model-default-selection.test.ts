import { createCipheriv } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { AccountPrincipalReader } from '../src/modules/auth/index.js'
import { MysqlRuntimeModelProfileCatalog } from '../src/modules/inference/infrastructure/mysql-model-gateway-resolver.js'

const key = Buffer.alloc(32, 1), iv = Buffer.alloc(12, 2), cipher = createCipheriv('aes-256-gcm', key, iv)
const ciphertext = Buffer.concat([cipher.update('synthetic-test-key'), cipher.final()])
const envelope = JSON.stringify({ v: 'test', iv: iv.toString('base64'), ct: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') })
const input = { userId: 28, strategyId: '20', strategyVersionId: '21', usage: 'auto' as const }
function fixture(personal = false, verified = true, shared = true) {
  const profile = { id: personal ? '1' : '3', owner_user_id: personal ? 28 : 0, scope: personal ? 'user' : 'platform',
    provider: 'test', model_name: 'test-model', api_base_url: 'https://models.example.com/v1', api_key_encrypted: envelope,
    temperature: '0.3', max_tokens: 2000, max_output_tokens: 393216, request_timeout_ms: 10000, protocol: 'responses', verification_status: verified ? 'verified' : 'unverified',
    capability_provider: 'test', capability_model_name: 'test-model', capability_api_base_url: 'https://models.example.com/v1', supports_structured_output: 1 }
  const execute = vi.fn(async (sql: string) => {
    if(sql.includes('FROM user_model_assignments_v4'))return [[]]
    if (sql.startsWith('SELECT CAST(model_profile_id')) return [personal ? [{ id: '1' }] : []]
    if (sql.includes('FROM platform_model_usage_policy')) return [[{ share_for_manual: 1, share_for_auto: shared ? 1 : 0, allowed_plans: '["pro"]' }]]
    if (sql.includes('FROM ai_model_profiles')) return [[profile]]
    throw Error('unexpected_sql')
  })
  const access = { canUseCurrent: vi.fn(async () => true), canUseFrozenReview: vi.fn(async () => true) }
  const principals = { readMany: vi.fn(async () => new Map([[28, { plan: 'pro' }]])) }
  const catalog = new MysqlRuntimeModelProfileCatalog({ execute } as unknown as Pool, new Map([['test', key]]),
    { allowPrivateEndpoints: false, maxAttempts: 1, defaultTimeoutMs: 10000 }, access, principals as unknown as AccountPrincipalReader)
  return { catalog, execute, access, profile, principals }
}

it('uses the explicit platform default only when a personal binding is absent and sharing permits', async () => {
  const f = fixture()
  const result = await f.catalog.resolve(input)
  expect(result.id).toBe('3'); expect(result.usage.credentialSource).toBe('platform_shared')
  expect(f.execute.mock.calls.some(([sql]) => sql.includes('d.user_id=0'))).toBe(true)
})

it('keeps the personal default ahead of platform sharing', async () => {
  const f = fixture(true, true, false)
  expect((await f.catalog.resolve(input)).id).toBe('1')
  expect(f.principals.readMany).not.toHaveBeenCalled()
})

it('does not substitute a platform credential when the personal default is unverified', async () => {
  const f = fixture(true, false)
  await expect(f.catalog.resolve(input)).rejects.toThrow('model_profile_not_verified')
  expect(f.execute.mock.calls.some(([sql]) => sql.includes('d.user_id=0'))).toBe(false)
})

it('does not fall through when a personal binding points to an unavailable profile', async () => {
  const f = fixture(true)
  f.execute.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ id: '1' }]]).mockResolvedValueOnce([[]])
  await expect(f.catalog.resolve(input)).rejects.toThrow('model_profile_unavailable')
  expect(f.principals.readMany).not.toHaveBeenCalled()
})

it('checks the current plan before accessing shared credentials', async () => {
  const f = fixture()
  f.principals.readMany.mockResolvedValue(new Map([[28, { plan: 'free' }]]))
  await expect(f.catalog.resolve(input)).rejects.toThrow('platform_model_sharing_unavailable')
  expect(f.execute.mock.calls.some(([sql]) => sql.includes('FROM ai_model_profiles'))).toBe(false)
})

it('refuses disabled automatic sharing before fetching a platform credential', async () => {
  const f = fixture(false, true, false)
  await expect(f.catalog.resolve(input)).rejects.toThrow('platform_model_sharing_unavailable')
  expect(f.execute.mock.calls.some(([sql]) => sql.includes('FROM ai_model_profiles'))).toBe(false)
})

it('uses the same default policy for frozen reviews and retains strategy authorization', async () => {
  const f = fixture()
  expect((await f.catalog.resolveForFrozenReview(input)).id).toBe('3')
  f.access.canUseFrozenReview.mockResolvedValue(false)
  f.execute.mockClear()
  await expect(f.catalog.resolveForFrozenReview(input)).rejects.toThrow('model_strategy_unavailable')
  expect(f.execute).not.toHaveBeenCalled()
})

it('uses model output capacity instead of the obsolete profile budget',async()=>{
 const f=fixture();expect((await f.catalog.resolve(input)).maxTokens).toBe(393216)
 f.profile.max_tokens=128;expect((await f.catalog.resolveForFrozenReview(input)).maxTokens).toBe(393216)
 f.profile.max_output_tokens=0;await expect(f.catalog.resolve(input)).rejects.toThrow('model_max_tokens_invalid')
})

it('uses purpose assignments before the default and keeps failure explicit',async()=>{
 const f=fixture();f.execute.mockResolvedValueOnce([[{id:'3'}]])
 expect((await f.catalog.resolve({...input,purpose:'trader'})).id).toBe('3')
 expect(f.execute.mock.calls[0]![0]).toContain('trader_model_profile_id')
 expect(f.execute.mock.calls.some(([sql])=>sql.includes('FROM user_model_defaults'))).toBe(false)
 const failed=fixture();failed.execute.mockResolvedValueOnce([[{id:'99'}]]).mockResolvedValueOnce([[]])
 await expect(failed.catalog.resolve(input)).rejects.toThrow('model_profile_unavailable')
 const review=fixture();await review.catalog.resolveForFrozenReview(input)
 expect(review.execute.mock.calls[0]![0]).toContain('review_model_profile_id')
})
