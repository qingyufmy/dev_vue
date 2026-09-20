import { shallowMount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import TradingResourcesCard from '../src/features/home/TradingResourcesCard.vue'
describe('trade collection availability', () => {
  it('distinguishes unavailable collections from confirmed empty snapshots', async () => {
    const view = shallowMount(TradingResourcesCard, {
      props: { positions: [], orders: [], positionsConfirmed: false, ordersConfirmed: false },
      global: { renderStubDefaultSlot: true },
    })
    expect(view.text()).toContain('正在等待终端同步持仓')
    expect(view.text()).toContain('正在等待终端同步挂单')
    expect(view.text()).not.toContain('当前没有持仓')
    await view.setProps({ positionsConfirmed: true, ordersConfirmed: true })
    expect(view.text()).toContain('当前没有持仓')
    expect(view.text()).toContain('当前没有挂单')
    view.unmount()
  })
})
