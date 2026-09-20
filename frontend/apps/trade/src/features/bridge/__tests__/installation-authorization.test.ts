import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import type { SessionSummary } from '@aurum/contracts'
import { useInstallationAuthorization } from '../composables/use-installation-authorization'

const identity: SessionSummary = { user: { id: '1', display_name: '测试', avatar_url: null }, app: 'trade', csrf_token: 'csrf', permissions: [], authenticated_at: '2026-09-14T00:00:00Z', mfa_level: 'none' }
const response = { data: { authorization_id: 'request1', installation_id: 'device1', device_name: '我的电脑', status: 'pending' as const, revision: '0', created_at: '2026-09-14T00:00:00Z', expires_at: '2026-09-14T00:10:00Z', current_user: { id: '1', display_name: '测试' } }, meta: { request_id: 'r', generated_at: '2026-09-14T00:00:00Z' } }
let scope: EffectScope
beforeEach(() => { scope = effectScope(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('never auto-approves and reuses the same decision after a lost response', async () => {
  const decideAuthorization = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ ...response, data: { ...response.data, status: 'approved', revision: '1' } })
  const flow = scope.run(() => useInstallationAuthorization(ref('request1'), ref(identity), { getAuthorization: vi.fn().mockResolvedValue(response), decideAuthorization }))!
  await flushPromises()
  expect(decideAuthorization).not.toHaveBeenCalled()
  await Promise.all([flow.decide('approved'), flow.decide('approved')])
  expect(decideAuthorization).toHaveBeenCalledTimes(1)
  await flow.decide('denied')
  expect(decideAuthorization).toHaveBeenCalledTimes(1)
  await flow.decide('approved')
  expect(decideAuthorization.mock.calls[1]?.slice(0, 4)).toEqual(decideAuthorization.mock.calls[0]?.slice(0, 4))
  expect(flow.authorization.value?.status).toBe('approved')
})

it('rejects late responses after account change and mismatched actor snapshots', async () => {
  let finish!: (value: typeof response) => void
  const session = ref<SessionSummary | null>(identity)
  const flow = scope.run(() => useInstallationAuthorization(ref('request1'), session, {
    getAuthorization: vi.fn(() => new Promise<typeof response>(resolve => { finish = resolve })), decideAuthorization: vi.fn(),
  }))!
  session.value = null
  finish(response)
  await flushPromises()
  expect(flow.authorization.value).toBeNull()
  expect(flow.canDecide.value).toBe(false)
  session.value = { ...identity, user: { ...identity.user, id: '2' } }
  finish(response)
  await flushPromises()
  expect(flow.authorization.value).toBeNull()
})

it('expires using the server clock even when the local clock differs', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2020-01-01'))
  const decideAuthorization = vi.fn()
  const flow = scope.run(() => useInstallationAuthorization(ref('request1'), ref(identity), { getAuthorization: vi.fn().mockResolvedValue(response), decideAuthorization }))!
  await Promise.resolve(); await Promise.resolve()
  expect(flow.canDecide.value).toBe(true)
  await vi.advanceTimersByTimeAsync(601000)
  await flow.decide('approved')
  expect(decideAuthorization).not.toHaveBeenCalled()
  expect(flow.canDecide.value).toBe(false)
})
