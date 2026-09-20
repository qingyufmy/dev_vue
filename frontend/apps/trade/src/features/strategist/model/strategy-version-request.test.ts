import { expect, it } from 'vitest'
import { prepareStrategyVersion, clearStrategyVersion } from './strategy-version-request'

it('retains the exact version operation and original revision until confirmed', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const intent = { action: 'publish_version' as const, versionId: '18' }
  const first = prepareStrategyVersion(storage, '7', '17', intent, 1, () => 'strategy-version-001')
  expect(prepareStrategyVersion(storage, '7', '17', intent, 9)).toEqual(first)
  expect(() => prepareStrategyVersion(storage, '7', '17', { action: 'retire_strategy' }, 9)).toThrow('上次策略操作尚未确认')
  expect(() => prepareStrategyVersion(storage, '7', '17', { ...intent, versionId: '19' }, 9)).toThrow('上次策略操作尚未确认')
  clearStrategyVersion(storage, '7', '17')
  expect(prepareStrategyVersion(storage, '7', '17', { action: 'create_version', body: { prompt_text: 'analyse', config: {} } }, 9,
    () => 'strategy-version-002').expectedRevision).toBe(9)
})
