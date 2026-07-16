import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(() => []),
  queryRun: vi.fn(),
  beijingNow: vi.fn(),
}))

vi.mock('../../server/routes/ai/model-profiles.js', () => ({
  resolveAiTaskModel: vi.fn(),
}))

vi.mock('../../server/ai-credential.js', () => ({
  isEncryptionAvailable: () => true,
}))

import { queryOne } from '../../server/db.js'
import { resolveAiTaskModel } from '../../server/routes/ai/model-profiles.js'
import { getAnalyzeApiKey } from '../../server/routes/ai/config.js'

describe('manual inference prompt inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAiTaskModel.mockResolvedValue({
      model: {
        id: 10, api_provider: 'deepseek', model_name: 'deepseek-chat',
        api_key_encrypted: 'runtime-key',
      },
      credential_source: 'user',
      model_profile_id: 10,
    })
  })

  it('uses the current administrator prompt when the user has no override', async () => {
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('user_id = ? AND session_id = ?')) {
        return { system_prompt: null }
      }
      if (sql.includes('SELECT p.system_prompt')) return { system_prompt: '管理员最新提示词' }
      return null
    })

    const config = await getAnalyzeApiKey(2, 'default')

    expect(config.system_prompt).toBe('管理员最新提示词')
  })

  it('preserves an explicit user prompt override', async () => {
    queryOne.mockImplementation(async (sql) => {
      if (sql.includes('user_id = ? AND session_id = ?')) {
        return { system_prompt: '用户自定义提示词' }
      }
      if (sql.includes('SELECT p.system_prompt')) return { system_prompt: '管理员最新提示词' }
      return null
    })

    const config = await getAnalyzeApiKey(2, 'default')

    expect(config.system_prompt).toBe('用户自定义提示词')
  })
})
