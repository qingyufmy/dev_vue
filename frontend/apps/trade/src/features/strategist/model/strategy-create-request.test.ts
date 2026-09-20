import { expect, it } from 'vitest'
import { prepareStrategyCreate, clearStrategyCreate } from './strategy-create-request'

it('retains exact user-scoped request content and key across retries and a new caller', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const body = { kind: 'analysis' as const, name: 'draft', description: '', prompt_text: 'analyse', config: {} }
  const first = prepareStrategyCreate(storage, '7', body, () => 'strategy-request-001')
  expect(prepareStrategyCreate(storage, '7', body, () => { throw Error('must retain key') })).toEqual(first)
  expect(() => prepareStrategyCreate(storage, '7', { ...body, name: 'changed' })).toThrow('上次创建结果尚未确认')
  expect(prepareStrategyCreate(storage, '8', body, () => 'strategy-request-002').idempotencyKey).not.toBe(first.idempotencyKey)
  clearStrategyCreate(storage, '7')
  expect(prepareStrategyCreate(storage, '7', body, () => 'strategy-request-003').idempotencyKey).toBe('strategy-request-003')
})
