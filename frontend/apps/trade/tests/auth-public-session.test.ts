import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'

const api = vi.hoisted(() => ({ getSession: vi.fn(), logoutCurrent: vi.fn() }))
vi.mock('@aurum/api-client', async (original) => ({ ...await original<typeof import('@aurum/api-client')>(), createApiClient: () => api }))

afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

describe('trade auth public session', () => {
  it('exposes readonly state and changes it only through the auth operations', async () => {
    api.getSession.mockResolvedValue({ data: { user: { id: '7', display_name: 'Trader', avatar_url: null },
      app: 'trade', permissions: ['trade'], csrf_token: 'csrf', authenticated_at: '2026-09-08T00:00:00Z', mfa_level: 'none' } })
    api.logoutCurrent.mockResolvedValue(undefined)
    const { useTradeSession } = await import('../src/features/auth')
    const owner = useTradeSession(), consumer = useTradeSession()
    const loaded = await owner.load()
    expect(isReadonly(consumer.session)).toBe(true)
    expect(isReadonly(loaded)).toBe(true)
    expect(consumer.session.value?.user.id).toBe('7')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Reflect.set(consumer.session, 'value', null)
    Reflect.set(loaded!.user, 'id', 'another-user')
    expect(consumer.session.value?.user.id).toBe('7')
    await owner.logout()
    expect(api.logoutCurrent).toHaveBeenCalledWith('csrf')
    expect(consumer.session.value).toBeNull()
  })
})
