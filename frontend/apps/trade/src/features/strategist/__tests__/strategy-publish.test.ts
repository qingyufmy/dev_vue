import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { ref } from 'vue'
const calls = vi.hoisted(() => ({ publish: vi.fn() }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { strategy_id: 's1' } }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('../composables/use-strategist-workspace', () => ({ useStrategistWorkspace: () => ({
  strategies: ref([{ id: 's1', kind: 'analysis' }]), accounts: ref([]), detail: ref(null), subscriptions: ref([]), symbols: ref([]),
  loading: ref(false), detailLoading: ref(false), subscriptionLoading: ref(false), refreshing: ref(false), compiling: ref(false), submitting: ref(false),
  error: ref(''), actionError: ref(''), notice: ref(''), compileResult: ref(null), loadDetail: vi.fn(), loadSubscriptions: vi.fn(), publish: calls.publish,
}) }))
import StrategistView from '../views/StrategistView.vue'
it('keeps the selected version until publication is acknowledged', async () => {
  let finish!: (value: boolean) => void
  calls.publish.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const wrapper = mount(StrategistView, { attachTo: document.body, global: { stubs: { StrategyCatalog: true, StrategyDetail: true, StrategyEditorSheet: true, StrategyMetadataSheet: true, SubscriptionEditorSheet: true, SubscriptionWorkspace: true } } })
  wrapper.findComponent({ name: 'StrategyDetail' }).vm.$emit('publish', 'v7')
  await flushPromises()
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '确认发布')!
  expect(button).toBeDefined(); button.click(); await flushPromises()
  expect(calls.publish).toHaveBeenCalledWith('v7')
  expect(document.querySelector('[role=alertdialog]')).not.toBeNull()
  finish(true); await flushPromises()
  expect(document.querySelector('[role=alertdialog]')).toBeNull()
  wrapper.unmount()
})
