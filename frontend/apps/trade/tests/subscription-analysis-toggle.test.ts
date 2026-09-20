import { mount, flushPromises } from '@vue/test-utils'
import { expect, it } from 'vitest'
import SubscriptionEditorSheet from '../src/features/strategist/components/SubscriptionEditorSheet.vue'
it('uses the analysis toggle as the subscription running state', async () => {
  const wrapper = mount(SubscriptionEditorSheet, { attachTo: document.body, props: {
    open: true, accountId: 'a', accounts: [], strategies: [],
    subscription: { id: 's', accountId: 'a', symbol: 'XAUUSD', analysisStrategyId: 'strategy', analysisStrategyVersionId: 'v', traderStrategyId: null, traderStrategyVersionId: null, analysisEnabled: true, traderEnabled: false, tradeSendEnabled: false, status: 'paused', cadenceSeconds: 300, revision: 1, updatedAt: '' },
  } })
  await flushPromises()
  const toggle = document.getElementById('analysis-enabled')!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  toggle.click()
  await flushPromises()
  const save = () => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '保存订阅')!.click()
  save(); await flushPromises()
  expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ analysisEnabled: true, status: 'active' })
  toggle.click()
  await flushPromises(); save(); await flushPromises()
  expect(wrapper.emitted('submit')?.[1]?.[0]).toMatchObject({ analysisEnabled: false, status: 'paused' })
  wrapper.unmount()
})
