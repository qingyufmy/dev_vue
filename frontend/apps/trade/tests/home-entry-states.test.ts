import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { ref } from 'vue'
import HomeView from '../src/features/home/HomeView.vue'
import AccountSummaryCard from '../src/features/home/AccountSummaryCard.vue'

const mocks = vi.hoisted(() => ({ workspace: null as any }))
vi.mock('../src/features/home/use-home-workspace', () => ({ useHomeWorkspace: () => mocks.workspace }))

beforeEach(() => {
  mocks.workspace = {
    accounts: ref([]), observers: ref([{ id: '12', active: true, sourceAccountId: '1', displayName: '示范账户' }]),
    context: ref({ accountId: null, observerChannelId: null, mode: 'blocked' }),
    loading: ref(false), error: ref(''), snapshot: ref(null), hasAccount: ref(false),
    symbols: ref([]), marketLoading: ref(false),
    load: vi.fn(), stop: vi.fn(), selectObserver: vi.fn(), selectAccount: vi.fn(), leaveObserver: vi.fn(),
  }
})

describe('home entry states', () => {
  it('keeps observation selection available without a personal trading account', async () => {
    const view = shallowMount(HomeView, { global: { renderStubDefaultSlot: true } })
    const selector = view.findComponent(AccountSummaryCard)
    expect(selector.exists()).toBe(true)
    selector.vm.$emit('observer', '12')
    expect(mocks.workspace.selectObserver).toHaveBeenCalledWith('12')
    view.unmount()
  })

  it('does not render the no-account onboarding when the directory read failed', () => {
    mocks.workspace.error.value = '交易工作区暂时无法读取，请刷新重试'
    const view = shallowMount(HomeView, { global: { renderStubDefaultSlot: true } })
    expect(view.text()).toContain('数据读取失败')
    expect(view.text()).not.toContain('还没有可用的交易账户')
    view.unmount()
  })

  it('does not present missing account facts as offline or read-only facts', () => {
    const view = shallowMount(AccountSummaryCard, {
      props: { accounts: [], observers: [], accountId: null, observerChannelId: null, snapshot: null, loading: false },
      global: { renderStubDefaultSlot: true },
    })
    expect(view.text()).toContain('智桥状态待确认')
    expect(view.text()).toContain('交易权限待确认')
    expect(view.text()).not.toContain('智桥离线')
    expect(view.text()).not.toContain('只读账户')
    view.unmount()
  })
})
