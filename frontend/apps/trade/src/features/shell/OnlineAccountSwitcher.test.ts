import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { TradingAccount, TradingContext } from '@aurum/contracts'

const mocks = vi.hoisted(() => ({ list: vi.fn(), context: vi.fn(), command: vi.fn() }))
vi.mock('@aurum/api-client', () => ({ createApiClient: () => ({ listTradingAccounts: mocks.list, getTradingContext: mocks.context }) }))
vi.mock('~/features/auth', async () => {
  const { ref } = await import('vue')
  const session = ref({ user: { id: 'user' }, authenticated_at: 'now', csrf_token: 'test' })
  return { useTradeSession: () => ({ session }) }
})
vi.mock('~/features/trading-context', async importOriginal => ({
  ...await importOriginal<object>(), runContextCommand: mocks.command,
}))
import { applyTradingAccounts, applyTradingContext, tradingContext } from '~/features/trading-context'
import OnlineAccountSwitcher from './OnlineAccountSwitcher.vue'

const context = { mode: 'full', accountId: 'a', observerChannelId: null, revision: 4 } as TradingContext
const accounts = [
  { id: 'old', bridgeState: 'offline', platform: 'mt4', login: '00', server: 'Hidden broker' },
  { id: 'a', bridgeState: 'online', platform: 'mt4', login: '11', server: 'Hidden broker' },
  { id: 'b', bridgeState: 'online', platform: 'mt5', login: '22', server: 'Hidden broker' },
] as TradingAccount[]
let wrapper: ReturnType<typeof shallowMount> | undefined
const slot = defineComponent({ template: '<div><slot /></div>' })
const item = defineComponent({ emits: ['select'], template: '<button @click="$emit(\'select\')"><slot /></button>' })
function mount() {
  wrapper = shallowMount(OnlineAccountSwitcher, { global: { stubs: {
    DropdownMenu: slot, DropdownMenuContent: slot, DropdownMenuTrigger: slot, DropdownMenuItem: item,
    Button: defineComponent({ template: '<button><slot /></button>' }),
  } } })
  return wrapper
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  applyTradingContext(context); applyTradingAccounts(accounts)
  mocks.list.mockResolvedValue({ data: { items: accounts } })
  mocks.context.mockResolvedValue({ data: context })
  mocks.command.mockResolvedValue({ data: { ...context, accountId: 'b', revision: 5 } })
})
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() })
it('lists only online platform/login labels and switches the shared server context', async () => {
  const view = mount(); await flushPromises()
  expect(view.text()).not.toContain('Hidden broker')
  expect(view.text()).not.toContain('00')
  const target = view.findAll('button').find(button => button.text() === 'MT5 · 22')!
  await target.trigger('click'); await flushPromises()
  expect(mocks.command).toHaveBeenCalledWith(expect.anything(), 'select_account', 'b', 4)
  expect(tradingContext.value?.accountId).toBe('b')
})
it('keeps observer mode instead of replacing it with an automatic own-account selection', async () => {
  const observer = { ...context, mode: 'observer', accountId: null, observerChannelId: 'channel' }
  applyTradingContext(observer as TradingContext)
  mocks.context.mockResolvedValue({ data: observer })
  const view = mount(); await flushPromises()
  expect(view.text()).toContain('观摩模式')
  expect(mocks.command).not.toHaveBeenCalled()
})
it('hides the selector when all accounts are offline', async () => {
  mocks.list.mockResolvedValue({ data: { items: [accounts[0]] } })
  const view = mount(); await flushPromises()
  expect(view.find('button').exists()).toBe(false)
  expect(mocks.command).not.toHaveBeenCalled()
})
