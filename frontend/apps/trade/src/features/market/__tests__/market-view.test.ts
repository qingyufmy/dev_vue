import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'
import MarketView from '../views/MarketView.vue'

const mocks = vi.hoisted(() => ({ overview: vi.fn(), detail: vi.fn(), session: null as unknown }))
vi.mock('@aurum/api-client', () => ({ createApiClient: () => ({ getMacroMarketOverview: mocks.overview, getMacroSnapshot: mocks.detail }) }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: mocks.session }) }))

beforeEach(() => {
  mocks.session = ref({ user: { id: 'one' } })
  mocks.overview.mockReset().mockResolvedValue({ data: { snapshot: null, high_impact_events: [] } })
  mocks.detail.mockReset()
})

it('renders valid empty results and permits retry after a failed refresh', async () => {
  const wrapper = mount(MarketView)
  await flushPromises()
  expect(wrapper.text()).toContain('尚无已发布研究')
  expect(wrapper.text()).toContain('当前没有可展示的重要事件')
  expect(wrapper.text()).toContain('北京时间')
  mocks.overview.mockRejectedValueOnce(Error('private SQL'))
  await wrapper.findAll('button').find(button => button.text() === '刷新市场数据')!.trigger('click')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('请重试')
  expect(wrapper.text()).not.toContain('private SQL')
  await wrapper.findAll('button').find(button => button.text() === '刷新市场数据')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('尚无已发布研究')
  wrapper.unmount()
})

it('does not fetch twice while loading, and clears and aborts on logout and unmount', async () => {
  mocks.overview.mockImplementation(() => new Promise(() => {}))
  const wrapper = mount(MarketView)
  await wrapper.findAll('button').find(button => button.text() === '正在刷新…')!.trigger('click')
  expect(mocks.overview).toHaveBeenCalledTimes(1)
  const signal = mocks.overview.mock.calls[0]![0] as AbortSignal
  ;(mocks.session as ReturnType<typeof ref>).value = null
  await flushPromises()
  expect(signal.aborted).toBe(true)
  expect(wrapper.text()).not.toContain('正在获取市场数据')
  ;(mocks.session as ReturnType<typeof ref>).value = { user: { id: 'two' } }
  await flushPromises()
  expect(mocks.overview).toHaveBeenCalledTimes(2)
  const second = mocks.overview.mock.calls[1]![0] as AbortSignal
  wrapper.unmount()
  expect(second.aborted).toBe(true)
})
