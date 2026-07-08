import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryAll: vi.fn(),
  queryRun: vi.fn(),
}))

import { queryAll } from '../server/db.js'

describe('loadSmsConfig', () => {
  beforeAll(async () => {
    queryAll.mockResolvedValue([
      { key: 'access_key_id', value: 'test_key' },
      { key: 'access_key_secret', value: 'test_secret' },
      { key: 'sign_name', value: '量见' },
      { key: 'template_code_login', value: 'SMS_001' },
      { key: 'template_code_register', value: 'SMS_002' },
      { key: 'template_code_reset', value: 'SMS_003' },
      { key: 'template_code_bind', value: 'SMS_004' },
    ])
  })

  it('从 DB 加载 SMS 配置', async () => {
    const { loadSmsConfig } = await import('../server/sms.js')
    const cfg = await loadSmsConfig()
    expect(cfg.accessKeyId).toBe('test_key')
    expect(cfg.signName).toBe('量见')
    expect(cfg.templateCodes.login).toBe('SMS_001')
    expect(cfg.templateCodes.register).toBe('SMS_002')
    expect(cfg.templateCodes.reset).toBe('SMS_003')
    expect(cfg.templateCodes.bind).toBe('SMS_004')
  })

  it('缓存生效后不再查 DB', async () => {
    queryAll.mockClear()
    queryAll.mockResolvedValue([{ key: 'access_key_id', value: 'k' }])
    const { loadSmsConfig } = await import('../server/sms.js')
    await loadSmsConfig()
    await loadSmsConfig()
    // Cached — should not call DB again
    expect(queryAll).not.toHaveBeenCalled()
  })
})
