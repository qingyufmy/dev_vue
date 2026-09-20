vi.mock('~/features/risk', () => ({ TradeSendSwitch: { template: '<span>交易发送开关</span>' } }))
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
const status = vi.hoisted(() => ({ connect: vi.fn(() => ({ stop: vi.fn() })) }))
vi.mock('~/features/analyst', () => ({ createAnalysisStatusRealtime: status.connect }))
const api = vi.hoisted(() => ({ listStrategies: vi.fn().mockResolvedValue({ data: { items: [] } }), listSubscriptions: vi.fn(), updateSubscription: vi.fn() }))
vi.mock('../api/strategist-api', () => ({ strategistApi: api }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: ref({ user: { id: 1 }, authenticated_at: 'login', csrf_token: 'test' }) }) }))
vi.mock('~/features/trading-context', () => ({ tradingAccounts: ref([{ id: '1', login: '111', platform: 'mt5', bridgeState: 'online' }]), currentAccount: ref({ id: '1', login: '111', platform: 'mt5' }), tradingContext: ref({ mode: 'full' }) }))
import { currentAccount, tradingAccounts } from '~/features/trading-context'
import RuntimeControls from '../components/RuntimeControls.vue'
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); (tradingAccounts as Ref<typeof tradingAccounts.value>).value = [{ id: '1', login: '111', platform: 'mt5', bridgeState: 'online' }] as any; (currentAccount as Ref<typeof currentAccount.value>).value = { id: '1', login: '111', platform: 'mt5' } as typeof currentAccount.value; vi.clearAllMocks() })
it('does not display an enabled trading switch for an account with no subscriptions', async () => {
  api.listSubscriptions.mockResolvedValue({ data: { items: [] } })
  wrapper = mount(RuntimeControls, { global: { stubs: { RouterLink: true } } })
  await flushPromises()
  expect(api.listSubscriptions).toHaveBeenCalledWith('1')
  expect(api.updateSubscription).not.toHaveBeenCalled()
})
it('discards an old account subscription response after switching accounts', async () => {
  let resolve!: (value: unknown) => void
  api.listSubscriptions.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockResolvedValue({ data: { items: [] } })
  wrapper = mount(RuntimeControls, { global: { stubs: { RouterLink: true } } })
  ;(currentAccount as Ref<typeof currentAccount.value>).value = { id: '2', login: '222', platform: 'mt4' } as typeof currentAccount.value
  await flushPromises()
  resolve({ data: { items: [{ id: 's1', tradingAccountId: '1', status: 'active', analysisEnabled: true, traderEnabled: true, tradeSendEnabled: true, schedule: { nextDueAt: null } }] } })
  await flushPromises()
  expect(api.updateSubscription).not.toHaveBeenCalled()
})

it('shows missing account as unknown rather than a disabled subscription', async () => {
  ;(currentAccount as Ref<typeof currentAccount.value>).value = null
  wrapper = mount(RuntimeControls, { global: { stubs: { RouterLink: true } } })
  await flushPromises()
  expect(wrapper.text()).toContain('待选择账户')
  expect(wrapper.text()).not.toContain('已关闭')
  expect(api.listSubscriptions).not.toHaveBeenCalled()
})

it('shows the actual countdown and running state from an analysis event', async () => {
  api.listSubscriptions.mockResolvedValue({ data: { items: [{ id: 's1', tradingAccountId: '1', analysisStrategyId: 'a1', standardSymbol: 'XAUUSD', status: 'active', analysisEnabled: true, schedule: { nextDueAt: new Date(Date.now() + 90000).toISOString() } }] } })
  wrapper = mount(RuntimeControls, { global: { stubs: { RouterLink: true } } })
  await flushPromises()
  expect(wrapper.text()).toMatch(/01:(29|30)/)
  const callback = status.connect.mock.calls.at(-1) as unknown as [{ onEvent: (event: unknown) => void }]
  callback[0].onEvent({ type: 'analysis.job.changed', resource: { id: 'run1' }, data: { strategy_id: 'a1', symbol: 'XAUUSD', status: 'running' } })
  await flushPromises()
  expect(wrapper.text()).toContain('分析中')
  callback[0].onEvent({ type: 'analysis.job.changed', resource: { id: 'run1' }, data: { strategy_id: 'a1', symbol: 'XAUUSD', status: 'succeeded' } })
  await flushPromises()
  expect(wrapper.text()).not.toContain('分析中')
})

it('opens the editor directly for one connected account', async () => {
  api.listSubscriptions.mockResolvedValue({ data: { items: [{ id: 's1', tradingAccountId: '1', status: 'paused' }] } })
  wrapper = mount(RuntimeControls, { global: { stubs: { AnalysisSettingsPanel: true } } })
  await flushPromises()
  await wrapper.find('button').trigger('click')
  await flushPromises()
  expect(wrapper.findComponent({ name: 'AnalysisSettingsPanel' }).props()).toMatchObject({ accountId: '1', subscriptionId: 's1', open: true })
})
it('lists both connected accounts before opening a subscription editor', async () => {
  ;(tradingAccounts as Ref<typeof tradingAccounts.value>).value = [{ id: '1', login: '111', platform: 'mt5', bridgeState: 'online' }, { id: '2', login: '222', platform: 'mt4', bridgeState: 'online' }] as any
  api.listSubscriptions.mockImplementation(async (id: string) => ({ data: { items: [{ id: `s${id}`, tradingAccountId: id, status: 'paused', standardSymbol: 'XAUUSD' }] } }))
  wrapper = mount(RuntimeControls, { attachTo: document.body, global: { stubs: { AnalysisSettingsPanel: true } } })
  await flushPromises()
  await wrapper.find('button').trigger('click')
  await flushPromises()
  expect(document.body.textContent).toContain('MT5 · 111')
  expect(document.body.textContent).toContain('MT4 · 222')
  expect(wrapper.findComponent({ name: 'AnalysisSettingsPanel' }).exists()).toBe(false)
  const buttons = [...document.querySelectorAll('button')].filter(button => button.textContent?.trim() === '编辑订阅')
  buttons[1]!.click()
  await flushPromises()
  expect(wrapper.findComponent({ name: 'AnalysisSettingsPanel' }).props()).toMatchObject({ accountId: '2', subscriptionId: 's2' })
})
