import { createDecipheriv } from 'node:crypto'
import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'

// Recovery-only API. The returned original row contains a credential and must
// stay in the migration process; never serialize it to diagnostics or reports.
export function restoreCredentialSource(payload, { sourceHash, keyring }) {
  exactKeys(payload, ['version', 'sourceTable', 'projection', 'source', 'sourceValueEncoding', 'credentialPlanChecksum',
    'sourceSnapshotId', 'registeredAtUtc', 'basisHash', 'resolution'])
  check(payload.version === 1 && payload.sourceTable === 'system_config' && payload.projection === 'settings-credential-source/v1'
    && ['encrypted_plaintext', 'encrypted', 'empty'].includes(payload.sourceValueEncoding), 'credential_source_projection')
  exactKeys(payload.source, ['id', 'category', 'key', 'value', 'label', 'sort_order', 'created_at', 'updated_at'])
  const source = structuredClone(payload.source)
  if (payload.sourceValueEncoding === 'encrypted_plaintext') {
    let first, plaintext
    try {
      check(typeof source.value === 'string' && Buffer.byteLength(source.value) <= 32768, 'credential_source_envelope')
      const envelope = JSON.parse(source.value)
      exactKeys(envelope, ['v', 'iv', 'ct', 'tag'])
      const key = keyring instanceof Map ? keyring.get(envelope.v) : null
      check(Buffer.isBuffer(key) && key.length === 32, 'credential_source_key')
      const decode = (raw, size) => {
        check(typeof raw === 'string' && raw.length > 0, 'credential_source_envelope')
        const bytes = Buffer.from(raw, 'base64')
        check(bytes.toString('base64') === raw && (size === undefined || bytes.length === size), 'credential_source_envelope')
        return bytes
      }
      const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12))
      decipher.setAuthTag(decode(envelope.tag, 16))
      first = decipher.update(decode(envelope.ct))
      plaintext = Buffer.concat([first, decipher.final()])
      const value = plaintext.toString('utf8')
      check(Buffer.from(value, 'utf8').equals(plaintext), 'credential_source_encoding')
      source.value = value
    } catch { throw new Error('credential_source_recovery_failed') }
    finally { first?.fill(0); plaintext?.fill(0) }
  }
  if (payload.sourceValueEncoding === 'empty') check(source.value === '', 'credential_source_empty')
  check(typeof sourceHash === 'string' && /^[a-f0-9]{64}$/.test(sourceHash) && hash(source) === sourceHash, 'credential_source_hash')
  return source
}
