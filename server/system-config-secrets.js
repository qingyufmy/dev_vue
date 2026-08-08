import { decryptCredential, encryptCredential, isEncryptedEnvelope, isEncryptionAvailable } from './ai-credential.js'
import { queryAll, queryRun } from './db.js'

export const SYSTEM_CONFIG_SENSITIVE_KEY_RE = /mnemonic|private_key|secret|password|access_key|api_key|rpc_url|(^|_)pass($|_)|(^|_)token($|_)/i

export function isSensitiveSystemConfigKey(key) {
  return SYSTEM_CONFIG_SENSITIVE_KEY_RE.test(String(key || ''))
}

export function protectSystemConfigValue(key, value) {
  const text = String(value ?? '')
  if (!isSensitiveSystemConfigKey(key) || !text) return text
  if (isEncryptedEnvelope(text)) return text
  if (!isEncryptionAvailable()) throw new Error('credential_encryption_unavailable')
  return encryptCredential(text)
}

export function revealSystemConfigValue(key, value) {
  const text = String(value ?? '')
  if (!isSensitiveSystemConfigKey(key) || !text || !isEncryptedEnvelope(text)) return text
  return decryptCredential(text)
}

export function systemConfigRowsToMap(rows = []) {
  return Object.fromEntries(rows.map(row => [row.key, revealSystemConfigValue(row.key, row.value)]))
}

export async function migrateLegacySystemConfigSecrets() {
  if (!isEncryptionAvailable()) return { migrated:0, skipped:true }
  const rows = await queryAll("SELECT id, category, `key`, `value` FROM system_config WHERE category IN ('sms','smtp')")
  let migrated = 0
  for (const row of rows) {
    const value = String(row.value ?? '')
    if (!value || !isSensitiveSystemConfigKey(row.key) || isEncryptedEnvelope(value)) continue
    await queryRun('UPDATE system_config SET `value` = ?, updated_at = NOW() WHERE id = ?', [encryptCredential(value), row.id])
    migrated++
  }
  return { migrated, skipped:false }
}
