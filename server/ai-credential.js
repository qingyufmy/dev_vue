// ai-credential.js — AES-256-GCM versioned credential encryption
// Independent master key (not JWT_SECRET). Keyring via AI_CREDENTIAL_KEYS_JSON env.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

let _keyring = null
let _activeVersion = null

function loadKeyring() {
  if (_keyring) return
  const raw = process.env.AI_CREDENTIAL_KEYS_JSON
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    _keyring = {}
    for (const [ver, b64] of Object.entries(parsed)) {
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 32) _keyring[ver] = buf
    }
    _activeVersion = process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION || null
  } catch { _keyring = null }
}

export function isEncryptionAvailable() {
  loadKeyring()
  if (!_keyring || !_activeVersion) return false
  return !!_keyring[_activeVersion]
}

export function getActiveKeyVersion() {
  loadKeyring()
  return _activeVersion || null
}

export function encryptCredential(plaintext) {
  if (!plaintext) return null
  loadKeyring()
  if (!_keyring || !_activeVersion || !_keyring[_activeVersion]) {
    throw new Error('encryption_master_key_missing')
  }
  const key = _keyring[_activeVersion]
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return JSON.stringify({
    v: _activeVersion,
    iv: iv.toString('base64'),
    ct: encrypted.toString('base64'),
    tag: authTag.toString('base64'),
  })
}

export function decryptCredential(envelope) {
  if (!envelope) return null
  loadKeyring()
  if (!_keyring) throw new Error('encryption_master_key_missing')
  let parsed
  try { parsed = JSON.parse(envelope) } catch {
    // Legacy plaintext — return as-is during migration period
    return envelope
  }
  if (!parsed.v || !parsed.ct || !parsed.iv || !parsed.tag) {
    // Not an envelope — treat as legacy plaintext
    return envelope
  }
  const key = _keyring[parsed.v]
  if (!key) throw new Error(`encryption_key_version_not_found:${parsed.v}`)
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()])
  return decrypted.toString('utf8')
}

export function isEncryptedEnvelope(value) {
  if (!value || typeof value !== 'string') return false
  try {
    const parsed = JSON.parse(value)
    return !!(parsed.v && parsed.ct && parsed.iv && parsed.tag)
  } catch { return false }
}

export function resetKeyringForTests() {
  _keyring = null
  _activeVersion = null
}
