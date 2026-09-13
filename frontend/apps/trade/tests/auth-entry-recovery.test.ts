import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '@aurum/api-client'

const api = vi.hoisted(() => ({ getSession: vi.fn(), logoutCurrent: vi.fn() }))
vi.mock('@aurum/api-client', async (original) => ({ ...await original<typeof import('@aurum/api-client')>(), createApiClient: () => api }))

const identity = { user: { id: '7', display_name: 'Test', avatar_url: null }, app: 'trade',
  permissions: ['trade'], csrf_token: 'csrf', authenticated_at: '2026-09-13T00:00:00Z', mfa_level: 'none' }

beforeEach(() => { vi.resetAllMocks(); vi.resetModules(); sessionStorage.clear() })

describe('trade login recovery', () => {
  it.each([[401, 'signed-out'], [403, 'forbidden'], [503, 'unavailable']])('classifies HTTP %s without assuming an invalid password', async (status, expected) => {
    const { useTradeSession } = await import('../src/features/auth/session')
    api.getSession.mockRejectedValue(new ApiClientError(Number(status), null))
    const owner = useTradeSession()
    expect(await owner.load()).toBeNull()
    expect(owner.issue.value).toBe(expected)
  })

  it('ignores a successful session response arriving after logout', async () => {
    const { useTradeSession } = await import('../src/features/auth/session')
    api.getSession.mockResolvedValueOnce({ data: identity })
    const owner = useTradeSession()
    await owner.load()
    let finish!: (result: { data: typeof identity }) => void
    api.getSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = owner.load()
    api.logoutCurrent.mockResolvedValue(undefined)
    await owner.logout()
    finish({ data: identity })
    await pending
    expect(owner.session.value).toBeNull()
    expect(owner.issue.value).toBe('signed-out')
  })

  it('does not let an older failure invalidate a newer session', async () => {
    const { useTradeSession } = await import('../src/features/auth/session')
    let reject!: (reason: Error) => void
    api.getSession.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const owner = useTradeSession()
    const pending = owner.load()
    api.getSession.mockResolvedValueOnce({ data: identity })
    await owner.load()
    reject(new Error('private network details'))
    await pending
    expect(owner.session.value?.user.id).toBe('7')
    expect(owner.issue.value).toBe('none')
  })

  it('keeps failed logout retryable without claiming success', async () => {
    const { useTradeSession } = await import('../src/features/auth/session')
    api.getSession.mockResolvedValue({ data: identity })
    const owner = useTradeSession()
    await owner.load()
    api.logoutCurrent.mockRejectedValue(new Error('network'))
    await expect(owner.logout()).rejects.toThrow('network')
    expect(owner.session.value?.user.id).toBe('7')
  })

  it('bounds automatic redirects and preserves only safe application return paths', async () => {
    const { beginAutomaticLogin, clearLoginAttempt, safeLoginNext } = await import('../src/features/auth/login-entry')
    expect(beginAutomaticLogin(100_000)).toBe(true)
    expect(beginAutomaticLogin(100_100)).toBe(false)
    clearLoginAttempt()
    expect(beginAutomaticLogin(100_200)).toBe(true)
    expect(safeLoginNext('/market?symbol=XAUUSD#chart')).toBe('/market?symbol=XAUUSD#chart')
    for (const value of ['https://evil.invalid', '//evil.invalid', '/auth/start', '/login', '/api/v4/session', '/%61uth/start', '/\\\\evil.invalid', '/a\n']) {
      expect(safeLoginNext(value)).toBe('/')
    }
  })
})
