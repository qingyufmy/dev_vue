import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ getPolicy: vi.fn(), run: vi.fn().mockResolvedValue(true) }))
vi.mock('../api/risk-api', () => ({ riskApi: mocks }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: ref({ user: { id: 'u1' }, csrf_token: 'csrf', authenticated_at: 'login' }) }) }))
vi.mock('~/features/trading-context', () => ({ currentAccount: ref({ id: 'a1' }), tradingContext: ref({ mode: 'full' }) }))
vi.mock('../composables/use-policy-write-recovery', () => ({ usePolicyWriteRecovery: () => ({ busy: ref(false), error: ref(''), pending: ref(null), run: mocks.run }) }))
import TradeSendSwitch from '../components/TradeSendSwitch.vue'
it('reads and changes the account sending gate without a subscription', async () => {
  mocks.getPolicy.mockResolvedValue({ data: { tradeSendEnabled: false, editableFields: ['trade_send_enabled'], revision: 2 } })
  const wrapper = mount(TradeSendSwitch)
  try {
    await flushPromises()
    expect(mocks.getPolicy).toHaveBeenCalledWith('a1')
    const control = wrapper.get('[role=switch]')
    expect(control.attributes('aria-checked')).toBe('false')
    expect(control.attributes('disabled')).toBeUndefined()
    await control.trigger('click'); await flushPromises()
    expect(mocks.run).toHaveBeenCalledWith('create', { trade_send_enabled: true, reason: '顶栏开启交易指令发送' })
  } finally { wrapper.unmount() }
})
