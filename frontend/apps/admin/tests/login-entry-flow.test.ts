import { effectScope, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { createLoginEntry } from '../src/features/auth/use-login-entry'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function fixture(reason?: string) {
  const route = ref({ fullPath: '/login', query: { next: '/overview', ...(reason ? { reason } : {}) } as Record<string, unknown> })
  const issue = ref<'none' | 'signed-out' | 'forbidden' | 'unavailable'>('signed-out')
  const ports = { load: vi.fn<() => Promise<unknown>>().mockResolvedValue(null), issue: () => issue.value,
    replace: vi.fn(), authorize: vi.fn(), beginAttempt: vi.fn(() => true), clearAttempt: vi.fn() }
  const scope = effectScope(); scopes.push(scope)
  const controller = scope.run(() => createLoginEntry(() => route.value, ports))!
  return { route, issue, ports, scope, controller }
}
it('automatically starts SSO after the session reports 401 signed-out', async () => {
  const f = fixture(); await f.controller.start()
  expect(f.ports.authorize).toHaveBeenCalledWith('/auth/start?next=%2Foverview', true)
  expect(f.controller.checking.value).toBe(true)
})
it('keeps a 503 session failure on page and allows a user retry', async () => {
  const f = fixture(); f.issue.value = 'unavailable'; await f.controller.start()
  expect(f.ports.authorize).not.toHaveBeenCalled()
  expect(f.controller.problem.value).toContain('暂时无法连接')
  expect(f.controller.checking.value).toBe(false)
  f.issue.value = 'signed-out'; await f.controller.checkSession()
  expect(f.ports.authorize).toHaveBeenCalledOnce()
})
it.each(['signed-out', 'unavailable', 'forbidden'])('does not read a session on an explicit %s landing page', async reason => {
  const f = fixture(reason); await f.controller.start()
  expect(f.ports.load).not.toHaveBeenCalled(); expect(f.ports.authorize).not.toHaveBeenCalled()
  expect(f.controller.issue.value).toBe(reason)
  if (reason !== 'signed-out') expect(f.controller.problem.value).not.toBe('')
})
it('returns an existing session to the safe target without another SSO trip', async () => {
  const f = fixture(); f.ports.load.mockResolvedValue({ user: { id: '7' } }); f.issue.value = 'none'
  await f.controller.start()
  expect(f.ports.replace).toHaveBeenCalledWith('/overview'); expect(f.ports.authorize).not.toHaveBeenCalled()
})
it('stops a repeated automatic attempt and permits one explicit retry', async () => {
  const f = fixture(); f.ports.beginAttempt.mockReturnValue(false)
  await f.controller.start()
  expect(f.controller.message.value).toContain('登录尚未完成'); expect(f.ports.authorize).not.toHaveBeenCalled()
  f.controller.continueLogin(); f.controller.continueLogin()
  expect(f.ports.clearAttempt).toHaveBeenCalledOnce(); expect(f.ports.authorize).toHaveBeenCalledOnce()
})
it.each(['unmount', 'route'])('ignores late responses after %s and prevents duplicate requests', async change => {
  const f = fixture(); let finish!: (value: unknown) => void
  f.ports.load.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = f.controller.start(); await f.controller.checkSession()
  expect(f.ports.load).toHaveBeenCalledOnce()
  if (change === 'unmount') f.scope.stop()
  else f.route.value = { fullPath: '/login?reason=signed-out', query: { reason: 'signed-out' } }
  finish({ user: { id: '7' } }); await pending
  expect(f.ports.authorize).not.toHaveBeenCalled(); expect(f.ports.replace).not.toHaveBeenCalled()
  if (change === 'route') expect(f.controller.checking.value).toBe(false)
})
it('does not leave a busy page stuck if the session loader unexpectedly rejects', async () => {
  const f = fixture(); f.ports.load.mockRejectedValue(Error('offline'))
  await f.controller.start()
  expect(f.controller.issue.value).toBe('unavailable'); expect(f.controller.checking.value).toBe(false)
  expect(f.ports.authorize).not.toHaveBeenCalled()
})
