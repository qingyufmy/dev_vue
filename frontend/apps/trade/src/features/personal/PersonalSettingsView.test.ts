import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { it, expect, vi, afterEach } from 'vitest'
import PersonalSettingsView from './PersonalSettingsView.vue'
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), play: vi.fn(), leave: vi.fn() }))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: mocks.leave }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: ref({ csrf_token: 'test-token' }), displayName: ref('测试用户') }) }))
vi.mock('./state', () => ({ personalClient: { getPersonalSettings: mocks.get, savePersonalSettings: mocks.save }, personalSettings: ref(null), soundReady: ref(false), playNotice: mocks.play }))
const settings = { nickname: '测试', revision: 1, hasFeishu: false, emailAvailable: false, preferences: { analysis: 'all', decision: 'effective', analysisSound: 'off', decisionSound: 'bell', feishuEnabled: false, emailEnabled: false } }
let wrapper: ReturnType<typeof mount> | undefined
async function setup() { mocks.get.mockResolvedValue({ data: structuredClone(settings) }); wrapper = mount(PersonalSettingsView); await flushPromises(); return wrapper }
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks() })
it('does not play another sound when the selected sound is off', async () => {
  const view = await setup()
  const button = view.get('button[aria-label="试听行情分析声音"]')
  expect(button.attributes('disabled')).toBeDefined()
  await button.trigger('click')
  expect(mocks.play).not.toHaveBeenCalled()
})
it('locks the form during saving and only sends one request', async () => {
  const view = await setup()
  let resolve!: (value: unknown) => void
  mocks.save.mockImplementation(() => new Promise(done => { resolve = done }))
  await view.get('#personal-name').setValue('新称呼')
  const save = view.findAll('button').find(button => button.text() === '保存设置')!
  await save.trigger('click'); await save.trigger('click')
  expect(mocks.save).toHaveBeenCalledTimes(1)
  expect(view.get('fieldset').attributes('disabled')).toBeDefined()
  expect(mocks.leave.mock.calls[0]![0]()).toBe(false)
  resolve({ data: { revision: 2 } }); await flushPromises()
  expect(view.text()).toContain('设置已保存')
  expect(view.findAll('button').find(button => button.text() === '已保存')?.attributes('disabled')).toBeDefined()
})
it('keeps input after a failed save and reuses the idempotency key on retry', async () => {
  const view = await setup(); mocks.save.mockRejectedValue(new Error('offline'))
  await view.get('#personal-name').setValue('保留的称呼')
  const save = view.findAll('button').find(button => button.text() === '保存设置')!
  await save.trigger('click'); await flushPromises()
  expect((view.get('#personal-name').element as HTMLInputElement).value).toBe('保留的称呼')
  expect(view.get('[role="alert"]').text()).toContain('填写内容已保留')
  await save.trigger('click'); await flushPromises()
  expect(mocks.save.mock.calls[0]![2]).toBe(mocks.save.mock.calls[1]![2])
})
it('provides a retry action when initial settings cannot load', async () => {
  mocks.get.mockRejectedValueOnce(new Error('offline')); wrapper = mount(PersonalSettingsView)
  expect(wrapper.text()).toContain('正在读取个人设置')
  await flushPromises()
  mocks.get.mockResolvedValue({ data: structuredClone(settings) })
  await wrapper.findAll('button').find(button => button.text() === '重新加载')!.trigger('click'); await flushPromises()
  expect(wrapper.find('#personal-name').exists()).toBe(true)
})
