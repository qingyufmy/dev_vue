import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

const check = (ok, code) => { if (!ok) throw new Error(`settings_credential_${code}`) }
const maximumBytes = 16384
function keyFor(keyring, version) {
  check(keyring instanceof Map && typeof version === 'string' && version.length > 0, 'key_unavailable')
  const key = keyring.get(version)
  check(Buffer.isBuffer(key) && key.length === 32, 'key_unavailable')
  return key
}
function decode(value, length) {
  check(typeof value === 'string' && value.length > 0, 'envelope_invalid')
  const bytes = Buffer.from(value, 'base64')
  check(bytes.toString('base64') === value && (length === undefined || bytes.length === length), 'envelope_invalid')
  return bytes
}
function open(value, keyring) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= maximumBytes * 2, 'envelope_invalid')
  let envelope
  try { envelope = JSON.parse(value) } catch { throw new Error('settings_credential_envelope_invalid') }
  check(envelope && typeof envelope === 'object' && !Array.isArray(envelope)
    && Object.keys(envelope).sort().join(',') === 'ct,iv,tag,v', 'envelope_invalid')
  const key = keyFor(keyring, envelope.v)
  const iv = decode(envelope.iv, 12), tag = decode(envelope.tag, 16), ciphertext = decode(envelope.ct)
  check(ciphertext.length <= maximumBytes, 'envelope_invalid')
  let first
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    first = decipher.update(ciphertext)
    return Buffer.concat([first, decipher.final()])
  } catch { throw new Error('settings_credential_authentication_failed') }
  finally { first?.fill(0) }
}

// Caller must bind the reviewed source format and returned ciphertext to its durable
// migration plan before writes. Existing targets are compared, never overwritten.
// This helper performs no database I/O and returns no decrypted value or key material.
export function convertSettingCredential(value, { sourceFormat, keyring, activeVersion, existingTarget } = {}) {
  check(['empty', 'encrypted', 'plaintext'].includes(sourceFormat), 'source_format_required')
  check(typeof value === 'string', 'source_invalid')
  if (sourceFormat === 'empty') {
    check(value === '' && (existingTarget === undefined || existingTarget === ''), 'empty_conflict')
    return { value: '', state: 'not_configured', authenticated: false, reused: existingTarget !== undefined }
  }
  check(value.length > 0, 'source_invalid')
  let plain, restored
  try {
    if (sourceFormat === 'encrypted') plain = open(value, keyring)
    else {
      check(Buffer.byteLength(value) <= maximumBytes, 'source_invalid')
      plain = Buffer.from(value, 'utf8')
      check(plain.toString('utf8') === value, 'source_invalid')
      // An envelope-like source must not silently be reclassified as plaintext.
      check(!value.trimStart().startsWith('{') && !value.trimStart().startsWith('['), 'source_format_ambiguous')
    }
    check(plain.length > 0 && plain.length <= maximumBytes, 'source_invalid')
    let target = existingTarget
    if (target === undefined) {
      if (sourceFormat === 'encrypted') target = value
      else {
        const key = keyFor(keyring, activeVersion), iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const ct = Buffer.concat([cipher.update(plain), cipher.final()])
        target = JSON.stringify({ v: activeVersion, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') })
      }
    }
    restored = open(target, keyring)
    check(plain.length === restored.length && timingSafeEqual(plain, restored), 'target_conflict')
    return { value: target, state: 'protected', authenticated: true, reused: existingTarget !== undefined }
  } finally { plain?.fill(0); restored?.fill(0) }
}
