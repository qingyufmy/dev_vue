import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { SessionSummary } from '@aurum/contracts'
import { createPairingCode } from '../model/pairing-code'
import { useBridgePairing } from '../composables/use-bridge-pairing'
import BridgePairingPanel from '../components/BridgePairingPanel.vue'
import type { bridgeApi } from '../api/bridge-api'

const response = { data: { pairing_id: 'id', profile_id: 'profile-1', expires_at: '2026-09-06T00:10:00.000Z' },
  meta: { request_id: 'request-1', generated_at: '2026-09-06T00:00:00.000Z' } }
const identity: SessionSummary = { user: { id: '1', display_name: '测试', avatar_url: null }, app: 'trade',
  csrf_token: 'csrf', permissions: [], authenticated_at: '2026-09-06T00:00:00.000Z', mfa_level: 'none' }
let scope: EffectScope
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); scope = effectScope() })
afterEach(() => { scope.stop(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('bridge pairing flow', () => {
  it('uses a random URL-safe code and hashes the entire code', async () => {
    const first = await createPairingCode()
    expect(first.code).toMatch(/^bpc_[A-Za-z0-9_-]{43}$/)
    expect(first.hash).toBe(createHash('sha256').update(first.code).digest('hex'))
    expect((await createPairingCode()).code).not.toBe(first.code)
  })
  it('retries the same draft after an uncertain request and suppresses duplicate clicks', async () => {
    const createPairing = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response)
    const flow = scope.run(() => useBridgePairing(ref(identity), { createPairing }))!
    await Promise.all([flow.generate(), flow.generate()])
    expect(createPairing).toHaveBeenCalledTimes(1)
    await flow.generate()
    expect(createPairing.mock.calls[1]?.slice(0, 3)).toEqual(createPairing.mock.calls[0]?.slice(0, 3))
    expect(flow.code.value).toMatch(/^bpc_/)
    await flow.generate()
    expect(createPairing).toHaveBeenCalledTimes(2)
  })
  it('discards a late response after the user changes', async () => {
    let finish!: (result: typeof response) => void
    const createPairing = vi.fn<typeof bridgeApi.createPairing>(() => new Promise<typeof response>(resolve => { finish = resolve }))
    const session = ref<SessionSummary | null>(identity)
    const flow = scope.run(() => useBridgePairing(session, { createPairing }))!
    const task = flow.generate()
    await vi.waitFor(() => expect(createPairing).toHaveBeenCalledOnce())
    session.value = null
    finish(response)
    await task
    expect(flow.code.value).toBe('')
    expect(createPairing.mock.calls[0]?.[3]?.aborted).toBe(true)
  })
  it('clears expired codes even when the browser clock differs from the server', async () => {
    vi.useFakeTimers()
    const flow = scope.run(() => useBridgePairing(ref(identity), { createPairing: vi.fn().mockResolvedValue(response) }))!
    await flow.generate()
    expect(flow.remaining.value).toBe(600)
    await vi.advanceTimersByTimeAsync(601000)
    expect(flow.code.value).toBe('')
    expect(flow.remaining.value).toBe(0)
  })
  it('renders actionable generation, copy and error states without implying connection success', async () => {
    const wrapper = mount(BridgePairingPanel, { props: { code: '', error: '', busy: false, copied: false, remaining: 0 } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('generate')).toHaveLength(1)
    await wrapper.setProps({ code: 'bpc_' + 'a'.repeat(43), remaining: 120, error: '请重试。' })
    expect(wrapper.get('input').attributes('readonly')).toBeDefined()
    expect(wrapper.text()).toContain('配对不等于终端已连接')
    expect(wrapper.text()).toContain('请重试。')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('copy')).toHaveLength(1)
    wrapper.unmount()
  })
})
