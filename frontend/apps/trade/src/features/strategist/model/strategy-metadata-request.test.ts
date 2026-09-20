import { expect, it } from 'vitest'
import { prepareStrategyMetadata, clearStrategyMetadata } from './strategy-metadata-request'

it('keeps the original revision on confirmation even after a fresh snapshot has advanced', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const body = { name: 'after', description: '' }
  const pending = prepareStrategyMetadata(storage, '7', '17', body, 1, () => 'strategy-metadata-001')
  expect(prepareStrategyMetadata(storage, '7', '17', body, 8)).toEqual(pending)
  expect(() => prepareStrategyMetadata(storage, '7', '17', { ...body, name: 'other' }, 8)).toThrow('上次修改结果尚未确认')
  expect(prepareStrategyMetadata(storage, '7', '18', body, 8, () => 'strategy-metadata-002').expectedRevision).toBe(8)
  clearStrategyMetadata(storage, '7', '17')
  expect(prepareStrategyMetadata(storage, '7', '17', body, 8, () => 'strategy-metadata-003').expectedRevision).toBe(8)
})
