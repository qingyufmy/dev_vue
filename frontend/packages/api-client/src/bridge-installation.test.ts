import { expect, it, vi } from 'vitest'
import { createApiClient } from './index'

const response = { data: { authorization_id: 'request1', installation_id: 'device1', device_name: 'My PC', status: 'approved', revision: '1', created_at: '2026-09-14T00:00:00Z', expires_at: '2026-09-14T00:10:00Z', current_user: { id: '1', display_name: 'User' } }, meta: { request_id: 'r', generated_at: '2026-09-14T00:00:00Z' } }
it('sends explicit actor and revision with CSRF and idempotency', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)))
  const body = { decision: 'approved' as const, expected_revision: '0', current_user_id: '1' }
  await createApiClient({ fetchImpl }).decideBridgeInstallationAuthorization('request1', body, 'request-key-12345', 'csrf')
  const [url, init] = fetchImpl.mock.calls[0]!
  expect(url).toBe('/api/v4/bridge/installation-authorizations/request1/decision')
  expect(JSON.parse(String(init?.body))).toEqual(body)
  expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf')
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('request-key-12345')
  expect(init?.cache).toBe('no-store')
})
it('rejects credential leakage in confirmation responses', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...response, data: { ...response.data, installation_token: 'secret' } })))
  await expect(createApiClient({ fetchImpl }).getBridgeInstallationAuthorization('request1')).rejects.toThrow()
})
