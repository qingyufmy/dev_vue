import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './index'

describe('bridge pairing client', () => {
  const response = { data: { pairing_id: '11111111-1111-4111-8111-111111111111', profile_id: 'profile-1', expires_at: '2026-09-06T00:10:00.000Z' },
    meta: { request_id: 'request-1', generated_at: '2026-09-06T00:00:00.000Z' } }
  it('sends only a hash with CSRF, idempotency and cancellation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 201 }))
    const abort = new AbortController()
    await createApiClient({ fetchImpl }).createBridgePairing('a'.repeat(64), 'request-123456789', 'csrf-test', abort.signal)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/v4/bridge/pairing-requests')
    expect(init?.body).toBe(JSON.stringify({ code_hash: 'a'.repeat(64) }))
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-test')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('request-123456789')
    expect(init?.signal).toBe(abort.signal)
    expect(init?.cache).toBe('no-store')
  })
  it('rejects malformed hashes before sending and unexpected credential fields on return', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...response, data: { ...response.data, refresh_token: 'unexpected' } }), { status: 201 }))
    const client = createApiClient({ fetchImpl })
    expect(() => client.createBridgePairing('bad', 'request-123456789', 'csrf')).toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(client.createBridgePairing('b'.repeat(64), 'request-123456789', 'csrf')).rejects.toThrow()
  })
})
