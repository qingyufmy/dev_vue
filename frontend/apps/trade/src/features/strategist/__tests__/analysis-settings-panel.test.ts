import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import AnalysisSettingsPanel from '../components/AnalysisSettingsPanel.vue'
const state = vi.hoisted(() => ({ workspace: null as any }))
vi.mock('../composables/use-strategist-workspace', () => ({ useStrategistWorkspace: () => state.workspace }))
let wrapper: ReturnType<typeof mount> | undefined
function setup() {
  const workspace = { subscriptions: ref([{ id: 's1', accountId: '1', status: 'active' }]), accounts: ref([]), strategies: ref([]), symbols: ref([]),
    actionError: ref(''), error: ref(''), submitting: ref(false), load: vi.fn().mockResolvedValue(undefined),
    loadSubscriptions: vi.fn().mockResolvedValue(undefined), saveSubscription: vi.fn().mockResolvedValue(true) }
  state.workspace = workspace
  wrapper = mount(AnalysisSettingsPanel, { props: { open: true, accountId: '1', subscriptionId: 's1' }, global: { stubs: {
    SubscriptionEditorSheet: { name: 'SubscriptionEditorSheet', props: ['submitting'], emits: ['submit'], template: '<div>订阅表单</div>' },
    SheetTitle: true, SheetDescription: true, Sheet: { template: '<div><slot /></div>' }, SheetContent: { template: '<div><slot /></div>' },
  } } })
  return workspace
}
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks() })
it('offers retry on read failure instead of showing a save form', async () => {
  const workspace = setup()
  workspace.load.mockImplementationOnce(async () => { workspace.error.value = '' })
  workspace.error.value = '订阅读取失败'
  expect(wrapper!.text()).toContain('正在读取订阅')
  expect(wrapper!.text()).not.toContain('正在保存')
  await flushPromises()
  expect(wrapper!.text()).toContain('订阅读取失败')
  expect(wrapper!.findComponent({ name: 'SubscriptionEditorSheet' }).exists()).toBe(false)
  await wrapper!.find('button').trigger('click'); await flushPromises()
  expect(wrapper!.findComponent({ name: 'SubscriptionEditorSheet' }).exists()).toBe(true)
})
it('does not turn a missing subscription into a create form', async () => {
  const workspace = setup(); workspace.subscriptions.value = []
  await flushPromises()
  expect(wrapper!.text()).toContain('这条订阅已不可用')
  expect(wrapper!.findComponent({ name: 'SubscriptionEditorSheet' }).exists()).toBe(false)
})
it('does not close a reopened editor when an earlier save completes', async () => {
  const workspace = setup(); await flushPromises()
  let finish!: (result: boolean) => void
  workspace.saveSubscription.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  wrapper!.findComponent({ name: 'SubscriptionEditorSheet' }).vm.$emit('submit', { accountId: '1' })
  await wrapper!.setProps({ open: false }); await wrapper!.setProps({ open: true }); await flushPromises()
  finish(true); await flushPromises()
  expect(wrapper!.emitted('update:open')).toBeUndefined()
})
it('refreshes the header and closes after saving the current editor', async () => {
  setup(); await flushPromises()
  wrapper!.findComponent({ name: 'SubscriptionEditorSheet' }).vm.$emit('submit', { accountId: '1' })
  await flushPromises()
  expect(wrapper!.emitted('saved')).toHaveLength(1)
  expect(wrapper!.emitted('update:open')).toEqual([[false]])
})
