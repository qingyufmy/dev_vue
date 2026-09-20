import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, it, vi, afterEach } from 'vitest'
import type { StrategySubscription } from '@aurum/contracts'
const api = vi.hoisted(() => ({ setAccountTrader: vi.fn() }))
vi.mock('../api/strategist-api', () => ({ strategistApi: api }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: ref({ user: { id: 1 }, authenticated_at: 'a', csrf_token: 'csrf' }) }) }))
vi.mock('~/features/trading-context', () => ({ currentAccount: ref({ id: '1' }) }))
import TraderRuntimeSwitch from '../components/TraderRuntimeSwitch.vue'
import { Switch } from '@aurum/ui/switch'
afterEach(() => vi.resetAllMocks())
const item = { id: 's1', revision: 3, status: 'active', analysisEnabled: true, traderEnabled: true, traderStrategyId: 't1' } as StrategySubscription
it('opens configuration without sending an enable request when unconfigured', async () => {
  const wrapper = mount(TraderRuntimeSwitch, { props: { items: [], loading: false, readonly: false } })
  wrapper.findComponent(Switch).vm.$emit('update:modelValue', true)
  await flushPromises()
  expect(wrapper.emitted('configure')).toHaveLength(1)
  expect(api.setAccountTrader).not.toHaveBeenCalled()
  wrapper.unmount()
})
it('sends all observed subscription revisions in one disabling request', async () => {
  api.setAccountTrader.mockResolvedValue({ data: { enabled: false } })
  const wrapper = mount(TraderRuntimeSwitch, { props: { items: [item], loading: false, readonly: false } })
  wrapper.findComponent(Switch).vm.$emit('update:modelValue', false)
  await flushPromises()
  expect(api.setAccountTrader).toHaveBeenCalledWith('csrf', '1', false, [{ id: 's1', revision: 3 }], expect.any(String))
  expect(wrapper.emitted('saved')).toHaveLength(1)
  wrapper.unmount()
})
it('reuses the same command to reconcile an uncertain save', async () => {
  api.setAccountTrader.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ data: { enabled: false } })
  const wrapper = mount(TraderRuntimeSwitch, { props: { items: [item], loading: false, readonly: false } })
  wrapper.findComponent(Switch).vm.$emit('update:modelValue', false)
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '核对状态')!.trigger('click')
  await flushPromises()
  expect(api.setAccountTrader.mock.calls[1]).toEqual(api.setAccountTrader.mock.calls[0])
  wrapper.unmount()
})
