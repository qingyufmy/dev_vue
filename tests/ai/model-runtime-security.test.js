import { afterEach, describe, expect, it } from 'vitest'
import { getAnalyzeApiKey, getUnifiedAutoInferenceConfig } from '../../server/routes/ai/config.js'
import { resetKeyringForTests } from '../../server/ai-credential.js'

const originalKeys = process.env.AI_CREDENTIAL_KEYS_JSON
const originalVersion = process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION

afterEach(() => {
  if (originalKeys === undefined) delete process.env.AI_CREDENTIAL_KEYS_JSON
  else process.env.AI_CREDENTIAL_KEYS_JSON = originalKeys
  if (originalVersion === undefined) delete process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION
  else process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = originalVersion
  resetKeyringForTests()
})

describe('real unified model module loading and fail-closed behavior', () => {
  it('loads the real config module without mocked exports', () => {
    expect(getAnalyzeApiKey).toBeTypeOf('function')
    expect(getUnifiedAutoInferenceConfig).toBeTypeOf('function')
  })

  it('blocks manual and automatic model resolution when the master key is missing', async () => {
    delete process.env.AI_CREDENTIAL_KEYS_JSON
    delete process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION
    resetKeyringForTests()

    await expect(getAnalyzeApiKey(2, 'default')).rejects.toThrow('encryption_master_key_missing')
    await expect(getUnifiedAutoInferenceConfig(1)).rejects.toThrow('encryption_master_key_missing')
  })
})
