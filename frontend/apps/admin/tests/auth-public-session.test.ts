import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'

const api = vi.hoisted(() => ({ getSession: vi.fn(), logoutCurrent: vi.fn() }))
vi.mock('@aurum/api-client', async (original) => ({ ...await original<typeof import('@aurum/api-client')>(), createApiClient: () => api }))
afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

describe('admin auth public session', () => {
  it('retains permission filtering and does not let consumers mutate session ownership', async () => {
    const identity = { user: { id: '7', display_name: 'Admin', avatar_url: null }, app: 'admin', permissions: [],
      csrf_token: 'csrf', authenticated_at: '2026-09-08T00:00:00Z', mfa_level: 'none' }
    api.getSession.mockResolvedValueOnce({ data: identity }).mockResolvedValueOnce({ data: { ...identity, permissions: ['admin'] } })
    api.logoutCurrent.mockResolvedValue(undefined)
    const { useAdminSession } = await import('../src/features/auth')
    const owner = useAdminSession(), consumer = useAdminSession()
    expect(await owner.load()).toBeNull()
    const loaded = await owner.load()
    expect(isReadonly(consumer.session)).toBe(true)
    expect(isReadonly(loaded)).toBe(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Reflect.set(consumer.session, 'value', null)
    Reflect.set(loaded!.user, 'id', 'another-user')
    expect(consumer.session.value?.user.id).toBe('7')
    await owner.logout()
    expect(api.logoutCurrent).toHaveBeenCalledWith('csrf')
    expect(consumer.session.value).toBeNull()
  })
})
