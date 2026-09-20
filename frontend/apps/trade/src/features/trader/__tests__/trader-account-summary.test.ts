import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import type { AccountSnapshot, TradingAccount } from '@aurum/contracts'
import TraderAccountSummary from '../components/TraderAccountSummary.vue'

it('keeps a current denied permission ahead of an older account permission', () => {
  const account = { id: '1', platform: 'mt5', login: '123', server: 'Demo', tradePermission: true } as TradingAccount
  const wrapper = mount(TraderAccountSummary, { props: {
    account, snapshot: { ...account, tradePermission: false } as AccountSnapshot,
  } })
  expect(wrapper.text()).toContain('只读账户')
  expect(wrapper.text()).not.toContain('允许交易')
  wrapper.unmount()
})
