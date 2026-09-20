import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { expect, it, vi } from 'vitest'
vi.mock('~/features/strategist', () => ({ RuntimeControls: { template: '<span />' } }))
vi.mock('~/features/trading-context', () => ({
  tradingAccounts: ref([{ id: 'a1', bridgeState: 'online', tradePermission: true }]),
  tradingContext: ref({ accountId: 'a1', mode: 'full' }),
  realtimeState: ref('live'), currentAccount: ref(null),
  publicMarketStates: ref([]), activeMarketSymbol: ref('XAUUSD'),
}))
import { realtimeState, tradingAccounts } from '~/features/trading-context'
import RuntimeStatus from './RuntimeStatus.vue'
it('keeps header connection status independent of page realtime teardown', async () => {
  const wrapper = mount(RuntimeStatus)
  try {
    expect(wrapper.text()).toContain('连接正常')
    ;(realtimeState as any).value = 'idle'
    await nextTick()
    expect(wrapper.text()).toContain('连接正常')
    ;(tradingAccounts as any).value = [{ id: 'a1', bridgeState: 'offline' }]
    await nextTick()
    expect(wrapper.text()).toContain('连接待确认')
  } finally { wrapper.unmount() }
})
