import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'crypto'
import { encryptCredential, decryptCredential, isEncryptionAvailable, isEncryptedEnvelope, resetKeyringForTests, getActiveKeyVersion } from '../../server/ai-credential.js'

function setupKeyring(version = '1', keyBase64) {
  if (!keyBase64) keyBase64 = randomBytes(32).toString('base64')
  process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ [version]: keyBase64 })
  process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = version
  resetKeyringForTests()
  return keyBase64
}

describe('AI Credential Encryption', () => {
  beforeEach(() => {
    resetKeyringForTests()
    delete process.env.AI_CREDENTIAL_KEYS_JSON
    delete process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION
  })

  describe('isEncryptionAvailable', () => {
    it('returns false when env vars not set', () => {
      expect(isEncryptionAvailable()).toBe(false)
    })

    it('returns false when keyring is empty', () => {
      process.env.AI_CREDENTIAL_KEYS_JSON = '{}'
      process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'
      resetKeyringForTests()
      expect(isEncryptionAvailable()).toBe(false)
    })

    it('returns true with valid keyring', () => {
      setupKeyring()
      expect(isEncryptionAvailable()).toBe(true)
    })

    it('returns false when active version not in keyring', () => {
      const keyBase64 = randomBytes(32).toString('base64')
      process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': keyBase64 })
      process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '99'
      resetKeyringForTests()
      expect(isEncryptionAvailable()).toBe(false)
    })

    it('returns false when key is wrong length', () => {
      process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': 'dGVzdA==' }) // 4 bytes, not 32
      process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'
      resetKeyringForTests()
      expect(isEncryptionAvailable()).toBe(false)
    })
  })

  describe('encrypt / decrypt roundtrip', () => {
    it('encrypts and decrypts back to original', () => {
      setupKeyring()
      const plaintext = 'sk-test-api-key-12345'
      const encrypted = encryptCredential(plaintext)
      expect(encrypted).not.toBe(plaintext)
      expect(isEncryptedEnvelope(encrypted)).toBe(true)
      const decrypted = decryptCredential(encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('produces different ciphertexts for same plaintext (random IV)', () => {
      setupKeyring()
      const plaintext = 'sk-same-key'
      const enc1 = encryptCredential(plaintext)
      const enc2 = encryptCredential(plaintext)
      expect(enc1).not.toBe(enc2)
      expect(decryptCredential(enc1)).toBe(plaintext)
      expect(decryptCredential(enc2)).toBe(plaintext)
    })

    it('returns null for null/empty input', () => {
      setupKeyring()
      expect(encryptCredential(null)).toBeNull()
      expect(encryptCredential('')).toBeNull()
    })

    it('returns null for null decrypt', () => {
      setupKeyring()
      expect(decryptCredential(null)).toBeNull()
    })
  })

  describe('tamper detection', () => {
    it('fails when auth tag is tampered', () => {
      setupKeyring()
      const encrypted = encryptCredential('secret-key')
      const parsed = JSON.parse(encrypted)
      const tagBuf = Buffer.from(parsed.tag, 'base64')
      tagBuf[0] ^= 0xff
      parsed.tag = tagBuf.toString('base64')
      expect(() => decryptCredential(JSON.stringify(parsed))).toThrow()
    })

    it('fails when ciphertext is tampered', () => {
      setupKeyring()
      const encrypted = encryptCredential('secret-key')
      const parsed = JSON.parse(encrypted)
      const ctBuf = Buffer.from(parsed.ct, 'base64')
      ctBuf[0] ^= 0xff
      parsed.ct = ctBuf.toString('base64')
      expect(() => decryptCredential(JSON.stringify(parsed))).toThrow()
    })

    it('fails when IV is tampered', () => {
      setupKeyring()
      const encrypted = encryptCredential('secret-key')
      const parsed = JSON.parse(encrypted)
      const ivBuf = Buffer.from(parsed.iv, 'base64')
      ivBuf[0] ^= 0xff
      parsed.iv = ivBuf.toString('base64')
      expect(() => decryptCredential(JSON.stringify(parsed))).toThrow()
    })
  })

  describe('wrong master key', () => {
    it('fails to decrypt when encrypted key version is removed from keyring', () => {
      const key1 = randomBytes(32).toString('base64')
      const key2 = randomBytes(32).toString('base64')
      // Encrypt with key version '1'
      process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': key1 })
      process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'
      resetKeyringForTests()
      const encrypted = encryptCredential('my-secret')
      // Now only key '2' available — version '1' was removed (rotated out)
      process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '2': key2 })
      process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '2'
      resetKeyringForTests()
      expect(() => decryptCredential(encrypted)).toThrow()
    })

    it('fails when key version not in keyring', () => {
      const key1 = randomBytes(32).toString('base64')
      process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': key1 })
      process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'
      resetKeyringForTests()
      const encrypted = encryptCredential('my-secret')
      const parsed = JSON.parse(encrypted)
      parsed.v = '99'
      expect(() => decryptCredential(JSON.stringify(parsed))).toThrow('encryption_key_version_not_found:99')
    })
  })

  describe('legacy plaintext rejection', () => {
    it('decryptCredential rejects legacy plaintext', () => {
      setupKeyring()
      const legacy = 'plain-api-key-no-envelope'
      expect(() => decryptCredential(legacy)).toThrow('credential_not_encrypted')
    })

    it('decryptCredential rejects non-envelope JSON strings', () => {
      setupKeyring()
      const notEnvelope = '{"some":"other_json"}'
      expect(() => decryptCredential(notEnvelope)).toThrow('credential_not_encrypted')
    })
  })

  describe('isEncryptedEnvelope', () => {
    it('identifies valid envelope', () => {
      setupKeyring()
      expect(isEncryptedEnvelope(encryptCredential('test'))).toBe(true)
    })

    it('rejects non-envelope strings', () => {
      expect(isEncryptedEnvelope('plain-key')).toBe(false)
      expect(isEncryptedEnvelope('{"v":"1"}')).toBe(false)
      expect(isEncryptedEnvelope(null)).toBe(false)
      expect(isEncryptedEnvelope(undefined)).toBe(false)
    })
  })

  describe('getActiveKeyVersion', () => {
    it('returns current version', () => {
      setupKeyring('3')
      expect(getActiveKeyVersion()).toBe('3')
    })

    it('returns null when not configured', () => {
      expect(getActiveKeyVersion()).toBeNull()
    })
  })

  describe('encryption key missing blocks save', () => {
    it('encryptCredential throws when no keyring', () => {
      expect(() => encryptCredential('any-key')).toThrow('encryption_master_key_missing')
    })
  })
})
