import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(() => []),
  queryRun: vi.fn(),
  beijingNow: vi.fn(),
}))

vi.mock('../../server/routes/ai/model-profiles.js', () => ({
  isEncryptionAvailable: () => false,
  resolveAiTaskModel: vi.fn(),
  logModelUsage: vi.fn(),
}))

import { queryOne } from '../../server/db.js'
import { getAnalyzeApiKey } from '../../server/routes/ai/config.js'

describe('manual inference prompt inheritance', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the current administrator prompt when the user has no override', async () => {
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('user_id = ? AND session_id = ?')) {
        return { user_id: 2, api_key_encrypted: 'user-key', system_prompt: null }
      }
      if (sql.includes('model_sharing_enabled = 1')) return null
      if (sql.includes('SELECT system_prompt')) return { system_prompt: '管理员最新提示词' }
      return null
    })

    const config = await getAnalyzeApiKey(2, 'default')

    expect(config.system_prompt).toBe('管理员最新提示词')
  })

  it('preserves an explicit user prompt override', async () => {
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('user_id = ? AND session_id = ?')) {
        return { user_id: 2, api_key_encrypted: 'user-key', system_prompt: '用户自定义提示词' }
      }
      if (sql.includes('model_sharing_enabled = 1')) return null
      if (sql.includes('SELECT system_prompt')) return { system_prompt: '管理员最新提示词' }
      return null
    })

    const config = await getAnalyzeApiKey(2, 'default')

    expect(config.system_prompt).toBe('用户自定义提示词')
  })
})
