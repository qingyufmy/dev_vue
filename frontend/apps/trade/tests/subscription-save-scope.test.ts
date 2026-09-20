import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { useStrategistWorkspace } from '../src/features/strategist/composables/use-strategist-workspace'
const api = vi.hoisted(() => ({ listSubscriptions: vi.fn(), getWorkspace: vi.fn(), updateSubscription: vi.fn() }))
vi.mock('../src/features/strategist/api/strategist-api', () => ({ strategistApi: api }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: ref({ user: { id: 'u' }, csrf_token: 'token' }) }) }))
it('does not reload an old account after its save completes', async () => {
  let finish!: () => void
  api.updateSubscription.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
  api.listSubscriptions.mockResolvedValue({ data: { items: [] } })
  api.getWorkspace.mockResolvedValue({ data: { symbols: ['GOLD'] } })
  let state!: ReturnType<typeof useStrategistWorkspace>
  const wrapper = mount(defineComponent({ setup() { state = useStrategistWorkspace({ autoLoad: false }); return () => null } }))
  const draft = { accountId: 'a', symbol: 'XAUUSD', analysisStrategyId: 's', traderStrategyId: null, analysisEnabled: false, traderEnabled: false, tradeSendEnabled: false, status: 'paused' as const }
  const current = { ...draft, id: 'subscription-a', analysisStrategyVersionId: 'v1', traderStrategyVersionId: null, cadenceSeconds: 300, revision: 1, updatedAt: '' }
  await state.loadSubscriptions('a')
  const save = state.saveSubscription(draft, current)
  await flushPromises()
  await state.loadSubscriptions('b')
  finish()
  expect(await save).toBe(true)
  expect(api.listSubscriptions.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
  expect(api.updateSubscription).toHaveBeenCalledWith('token', 'subscription-a', expect.objectContaining({ analysis_enabled: false, status: 'paused' }), 1, expect.any(String))
  api.listSubscriptions.mockRejectedValueOnce(new Error('SQL internal_failure'))
  await state.loadSubscriptions('b')
  expect(state.actionError.value).toBe('账户策略订阅读取失败')
  wrapper.unmount()
})
