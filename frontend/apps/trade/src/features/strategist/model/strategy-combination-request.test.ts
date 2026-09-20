import { describe, expect, it } from 'vitest'
import { clearStrategyCombination, prepareStrategyCombination } from './strategy-combination-request'

describe('strategy combination request recovery', () => {
  it('reuses one idempotency key for an unacknowledged two-prompt save', () => {
    const storage = new Map<string, string>()
    const session = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => { storage.delete(key) } } as unknown as Storage
    const body = { name: '组合', description: '', analysis_prompt_text: '分析提示词需要足够长度并保持证据约束', analysis_config: {}, trader_prompt_text: '交易提示词需要足够长度并保持账户约束', trader_config: {} }
    const first = prepareStrategyCombination(session, '7', '', body, null)
    const replay = prepareStrategyCombination(session, '7', '', body, null)
    expect(replay.idempotencyKey).toBe(first.idempotencyKey)
    clearStrategyCombination(session, '7', '')
    expect(session.getItem('aurum:v4:strategy-combination:7:new')).toBeNull()
  })
})
