import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-16 10:00:00'),
}))

import { queryOne, queryRun } from '../../server/db.js'
import { getInferencePreference, saveInferencePreference } from '../../server/routes/ai/inference-preferences.js'

describe('inference preferences', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns safe defaults and inherits the administrator prompt', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM ai_inference_preferences WHERE')) return null
      if (sql.includes('SELECT role FROM users')) return { role: 'user' }
      if (sql.includes('SELECT p.system_prompt')) return { system_prompt: '平台提示词' }
      return null
    })

    const preference = await getInferencePreference(8, 'default')

    expect(preference).toMatchObject({
      system_prompt: '平台提示词', risk_level: 'medium', max_position_size: 0.05,
      selected_take_profit: 2, _exists: false, _system_prompt_inherited: true,
    })
    expect(preference).not.toHaveProperty('api_key_encrypted')
  })

  it('keeps a user prompt override and normalizes database values', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM ai_inference_preferences WHERE')) return {
        system_prompt: '用户提示词', enable_auto_trade: 1, enable_futures_trading: 0,
        risk_level: 'low', max_position_size: '0.03', selected_take_profit: 1,
      }
      if (sql.includes('SELECT role FROM users')) return { role: 'user' }
      if (sql.includes('SELECT p.system_prompt')) return { system_prompt: '平台提示词' }
      return null
    })

    await expect(getInferencePreference(8)).resolves.toMatchObject({
      system_prompt: '用户提示词', enable_auto_trade: true, enable_futures_trading: false,
      risk_level: 'low', max_position_size: 0.03, selected_take_profit: 1,
      _system_prompt_inherited: false,
    })
  })

  it('validates bounds before writing', async () => {
    await expect(saveInferencePreference(8, 'default', {
      risk_level: 'medium', max_position_size: 0, selected_take_profit: 2,
    })).rejects.toThrow('invalid_max_position_size')
    await expect(saveInferencePreference(8, 'default', {
      risk_level: 'medium', max_position_size: 5.01, selected_take_profit: 2,
    })).rejects.toThrow('invalid_max_position_size')
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('upserts only preference fields', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('FROM ai_inference_preferences WHERE')) return {
        system_prompt: null, enable_auto_trade: 1, enable_futures_trading: 1,
        risk_level: 'high', max_position_size: 0.08, selected_take_profit: 3,
      }
      if (sql.includes('SELECT role FROM users')) return { role: 'user' }
      if (sql.includes('SELECT p.system_prompt')) return { system_prompt: '平台提示词' }
      return null
    })

    await saveInferencePreference(8, 'default', {
      system_prompt: null, enable_auto_trade: true, enable_futures_trading: true,
      risk_level: 'high', max_position_size: 0.08, selected_take_profit: 3,
    })

    const sql = queryRun.mock.calls[0][0]
    expect(sql).toContain('INSERT INTO ai_inference_preferences')
    expect(sql).not.toContain('api_key')
  })
})
