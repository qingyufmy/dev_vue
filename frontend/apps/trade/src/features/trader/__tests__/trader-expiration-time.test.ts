import { applyPublicDisplayClock, applyAccountSnapshot } from '~/features/trading-context'
import { applyTradingContext } from '~/features/trading-context'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { AccountSnapshot, TradingContext, PendingOrder } from '@aurum/contracts'
import TraderCommandSheet from '../components/TraderCommandSheet.vue'
import TraderResourceEditDialog from '../components/TraderResourceEditDialog.vue'
import { accountInputTimezone } from '~/lib/account-input-timezone'

const account = {
  id: 'account-1', platform: 'mt5' as const, login: '8950701', server: 'Demo', currency: 'USD',
  terminalProfileId: 'profile-1', terminalInstanceId: null, bridgeState: 'online' as const, tradePermission: true, lastSeenAt: null,
}
function setClock(offset: number | null) {
  applyTradingContext({ accountId: account.id } as TradingContext)
  applyAccountSnapshot({ ...account, timezoneOffsetMinutes: offset, clockStatus: 'calibrated' } as AccountSnapshot)
}
afterEach(() => { applyPublicDisplayClock(null); applyAccountSnapshot(null); applyTradingContext(null); document.body.innerHTML = '' })

it('rejects stale and mismatched account clocks even when the public clock is calibrated', () => {
  setClock(180)
  applyPublicDisplayClock({ offset_minutes: 0, status: 'calibrated', checked_at: '2026-09-07T00:00:00Z' })
  applyAccountSnapshot({ ...account, timezoneOffsetMinutes: 180, clockStatus: 'stale' } as AccountSnapshot)
  expect(accountInputTimezone().isDefault).toBe(true)
  applyAccountSnapshot({ ...account, id: 'another-account', timezoneOffsetMinutes: 180, clockStatus: 'calibrated' } as AccountSnapshot)
  expect(accountInputTimezone().isDefault).toBe(true)
})

it.each([180, 0, -210])('emits the same UTC expiry after displaying offset %s', async (offset) => {
  setClock(offset)
  applyPublicDisplayClock({ offset_minutes: 540, status: 'calibrated', checked_at: '2026-09-07T00:00:00Z' })
  const expiry = Date.parse('2026-09-08T23:30:12Z')
  const wrapper = mount(TraderCommandSheet, { attachTo: document.body, props: {
    open: true, account, symbols: ['XAUUSD'], quote: { bid: '2300', ask: '2301', observedAt: '2026-09-07T00:00:00Z' },
    initial: { command_type: 'pending_order', symbol: 'XAUUSD', order_type: 'buy_limit', volume: '0.1', price: '2200', stop_loss: '2190', expiration_utc_msc: expiry },
  } })
  try {
    await nextTick()
    const input = document.body.querySelector<HTMLInputElement>('#command-expiration-time')!
    expect(input.value).toBe(new Date(expiry + offset * 60000).toISOString().slice(0, 19))
    document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ expiration_utc_msc: expiry })
    applyTradingContext({ accountId: 'account-2' } as TradingContext)
    document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.emitted('submit')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('does not turn the default display timezone into a submitted expiration', async () => {
  setClock(null)
  const wrapper = mount(TraderCommandSheet, { attachTo: document.body, props: {
    open: true, account, symbols: ['XAUUSD'], quote: { bid: '2300', ask: '2301', observedAt: '2026-09-07T00:00:00Z' },
    initial: { command_type: 'pending_order', symbol: 'XAUUSD', order_type: 'buy_limit', volume: '0.1', price: '2200', stop_loss: '2190', expiration_utc_msc: Date.parse('2026-09-08T23:30:12Z') },
  } })
  try {
    await nextTick()
    document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.emitted('submit')).toBeUndefined()
  } finally { wrapper.unmount() }
})

it('keeps an unchanged resource expiration out of a price edit', async () => {
  setClock(180)
  const resource = { ticket: '1', symbol: 'XAUUSD', price: '2200', type: 'buy_limit', expiresAt: '2026-09-08T23:30:12.345Z', stopLoss: null, takeProfit: null } as PendingOrder
  const wrapper = mount(TraderResourceEditDialog, { attachTo: document.body, props: { open: true, resource } })
  try {
    await nextTick()
    document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(wrapper.emitted('submit')?.[0]?.[0]).toEqual({ price: '2200' })
  } finally { wrapper.unmount() }
})
