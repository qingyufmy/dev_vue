import { expect, it } from 'vitest'
import { prepareSubscriptionUpdate, clearSubscriptionUpdate } from './subscription-update-request'

it('retains the exact patch and original revision, including an end request', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const body = { status: 'ended' as const }
  const first = prepareSubscriptionUpdate(storage, '7', '9', body, 1, () => 'subscription-update-001')
  expect(prepareSubscriptionUpdate(storage, '7', '9', body, 9)).toEqual(first)
  expect(() => prepareSubscriptionUpdate(storage, '7', '9', { status: 'active' }, 9)).toThrow('上次订阅修改尚未确认')
  expect(() => prepareSubscriptionUpdate(storage, '7', '10', {}, 9)).toThrow('请填写需要修改的订阅内容')
  clearSubscriptionUpdate(storage, '7', '9')
  expect(prepareSubscriptionUpdate(storage, '7', '9', { status: 'paused' }, 9, () => 'subscription-update-002').expectedRevision).toBe(9)
})
