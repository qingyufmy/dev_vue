import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { expect, it, vi } from 'vitest'
vi.mock('~/features/strategist', () => ({ RuntimeControls: { props: ['marketStates'], template: '<span data-runtime-market>{{ marketStates?.[0]?.state }}</span>' } }))
vi.mock('~/features/trading-context', () => ({
  tradingAccounts: ref([{ id: 'a1', bridgeState: 'online', tradePermission: true }]),
  tradingContext: ref({ accountId: 'a1', mode: 'full' }),
  realtimeState: ref('live'), currentAccount: ref(null),
  publicMarketStates: ref([]), activeMarketSymbol: ref('XAUUSD'),
}))
import { publicMarketStates, realtimeState, tradingAccounts } from '~/features/trading-context'
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

it('passes an authoritative closed session to automatic runtime controls', async () => {
  ;(publicMarketStates as any).value = [{ symbol: 'XAUUSD', state: 'closed', checked_at: new Date().toISOString() }]
  const wrapper = mount(RuntimeStatus)
  try {
    await flushPromises()
    await nextTick()
    expect(wrapper.get('[data-runtime-market]').text()).toBe('closed')
    expect(wrapper.text()).toContain('休市')
  } finally {
    wrapper.unmount()
    ;(publicMarketStates as any).value = []
  }
})
