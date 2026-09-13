import { effectScope } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useLoginEntry } from '../app/features/auth/use-login-entry'
import { beginAutomaticLogin, clearLoginAttempt, safeLoginNext } from '../app/features/auth/login-entry'

const session = { data: { user: { id: '7', display_name: '用户', avatar_url: null }, app: 'www', permissions: [],
  authenticated_at: '2026-09-07T00:00:00Z', mfa_level: 'none', csrf_token: 'csrf' }, meta: { request_id: 'r', generated_at: '2026-09-07T00:00:00Z' } }
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals() })
function fixture(query: Record<string, unknown> = {}) {
  const ports = { session: vi.fn<() => Promise<unknown>>().mockRejectedValue({ statusCode: 401 }), replace: vi.fn(), authorize: vi.fn(),
    beginAttempt: vi.fn(() => true), clearAttempt: vi.fn() }
  const scope = effectScope(); scopes.push(scope)
  const controller = scope.run(() => useLoginEntry(() => query, ports))!
  return { ports, scope, controller }
}
it('automatically starts SSO only after an explicit signed-out response', async () => {
  const f = fixture({ next: '/courses/12?lesson=2#content' })
  await f.controller.start()
  expect(f.ports.authorize).toHaveBeenCalledWith('/auth/start?next=%2Fcourses%2F12%3Flesson%3D2%23content', true)
  expect(f.controller.checking.value).toBe(true)
})
it('returns an already authenticated www user to the intended page', async () => {
  const f = fixture({ next: '/courses/12' }); f.ports.session.mockResolvedValue(session)
  await f.controller.start()
  expect(f.ports.clearAttempt).toHaveBeenCalledOnce()
  expect(f.ports.replace).toHaveBeenCalledWith('/courses/12')
  expect(f.ports.authorize).not.toHaveBeenCalled()
})
it.each([['signed-out', null], ['unavailable', 'unavailable'], ['forbidden', 'forbidden']])('does not automatically leave a %s landing page', async (reason, issue) => {
  const f = fixture({ reason }); await f.controller.start()
  expect(f.ports.session).not.toHaveBeenCalled(); expect(f.ports.authorize).not.toHaveBeenCalled()
  expect(f.controller.issue.value).toBe(issue)
})
it.each([503, 403, undefined])('keeps %s failures on the page with retry feedback', async statusCode => {
  const f = fixture(); f.ports.session.mockRejectedValue({ statusCode })
  await f.controller.start()
  expect(f.ports.authorize).not.toHaveBeenCalled()
  expect(f.controller.issue.value).toBe(statusCode === 403 ? 'forbidden' : 'unavailable')
  expect(f.controller.checking.value).toBe(false)
  f.ports.session.mockRejectedValue({ statusCode: 401 })
  await f.controller.checkSession()
  expect(f.ports.authorize).toHaveBeenCalledOnce()
})
it('rejects malformed or cross-application session snapshots', async () => {
  const f = fixture(); f.ports.session.mockResolvedValue({ ...session, data: { ...session.data, app: 'trade' } })
  await f.controller.start()
  expect(f.controller.issue.value).toBe('unavailable'); expect(f.ports.authorize).not.toHaveBeenCalled()
})
it('stops automatic login loops and permits an explicit retry', async () => {
  const f = fixture(); f.ports.beginAttempt.mockReturnValue(false)
  await f.controller.start()
  expect(f.ports.authorize).not.toHaveBeenCalled(); expect(f.controller.message.value).toContain('登录尚未完成')
  f.controller.continueLogin(); f.controller.continueLogin()
  expect(f.ports.clearAttempt).toHaveBeenCalledOnce(); expect(f.ports.authorize).toHaveBeenCalledOnce()
})
it('ignores late session results after unmount and blocks duplicate checks', async () => {
  const f = fixture(); let finish!: (value: unknown) => void
  f.ports.session.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = f.controller.checkSession(); await f.controller.checkSession()
  expect(f.ports.session).toHaveBeenCalledOnce()
  f.scope.stop(); finish(session); await pending
  expect(f.ports.replace).not.toHaveBeenCalled(); expect(f.ports.authorize).not.toHaveBeenCalled()
})
it.each(['https://evil.test', '//evil.test', '/\\evil.test', '/login?next=/courses', '/auth/start', '/api/v4/session', '/%61uth/start', '/courses\n', ['/', '/courses']])('rejects unsafe return path %s', value => {
  expect(safeLoginNext(value)).toBe('/')
})
it('bounds automatic attempts by time and fails safely when storage is unavailable', () => {
  const data = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  expect(beginAutomaticLogin(100_000)).toBe(true); expect(beginAutomaticLogin(120_000)).toBe(false)
  expect(beginAutomaticLogin(161_000)).toBe(true); clearLoginAttempt(); expect(beginAutomaticLogin(162_000)).toBe(true)
  vi.stubGlobal('sessionStorage', { getItem: () => { throw Error('blocked') } })
  expect(beginAutomaticLogin()).toBe(false); expect(() => clearLoginAttempt()).not.toThrow()
})
