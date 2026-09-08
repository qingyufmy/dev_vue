import { beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import ContextCommandRecovery from '../src/features/trading-context/ContextCommandRecovery.vue'

const mocks = vi.hoisted(() => ({ state: null as any, session: null as any, bind: vi.fn(), recover: vi.fn(), retry: vi.fn() }))
vi.mock('../src/features/trading-context/context-command-session', async () => {
  const { ref } = await import('vue')
  mocks.state = ref({ status: 'idle', busy: false, intent: null })
  return { contextCommandState: mocks.state, bindContextCommandSession: mocks.bind, recoverContextCommand: mocks.recover, retryContextCommand: mocks.retry }
})
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: mocks.session }) }))

beforeEach(() => {
  mocks.session = ref({ user: { id: '42' }, csrf_token: 'csrf', authenticated_at: '2026-09-08T12:00:00.000Z' })
  mocks.state.value = { status: 'uncertain', busy: false, intent: { requestId: 'original-key' } }
  mocks.bind.mockReset(); mocks.recover.mockReset(); mocks.retry.mockReset()
})

it('keeps focus and the pending request while preventing duplicate confirmation clicks', async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<null>((_resolve, fail) => { reject = fail })
  mocks.recover.mockImplementation(() => {
    mocks.state.value = { ...mocks.state.value, busy: true }
    return pending.finally(() => { mocks.state.value = { ...mocks.state.value, busy: false } })
  })
  const wrapper = mount(ContextCommandRecovery, { attachTo: document.body })
  try {
    const button = wrapper.get('button')
    ;(button.element as HTMLButtonElement).focus()
    await button.trigger('click'); await button.trigger('click')
    expect(mocks.recover).toHaveBeenCalledTimes(1)
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(button.element)
    reject(Error('unavailable')); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('结果仍待确认')
    expect(mocks.state.value.intent.requestId).toBe('original-key')
    expect(document.activeElement).toBe(button.element)
    expect(mocks.retry).not.toHaveBeenCalled()
  } finally { wrapper.unmount() }
})

it('binds session teardown and exposes only an explicit original-request retry', async () => {
  mocks.retry.mockRejectedValue(Error('still-unknown'))
  const wrapper = mount(ContextCommandRecovery)
  try {
    await wrapper.findAll('button')[1]!.trigger('click'); await flushPromises()
    expect(mocks.retry).toHaveBeenCalledWith(mocks.session.value)
    expect(mocks.recover).not.toHaveBeenCalled()
    mocks.session.value = null; await flushPromises()
    expect(mocks.bind).toHaveBeenLastCalledWith(null)
  } finally { wrapper.unmount() }
})
