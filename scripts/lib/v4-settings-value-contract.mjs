import { requireBackfill as check } from './v4-backfill-contract.mjs'

const registry = new Map()
function add(namespace, keys, type, options = {}) {
  for (const key of keys.split(' ')) {
    const id = `${namespace}/${key}`
    check(!registry.has(id), 'settings_contract_duplicate')
    registry.set(id, Object.freeze({ namespace, key, type, exposure: 'restricted', ...options }))
  }
}
add('auth_toggle', 'email_enabled phone_enabled gift_enabled', 'boolean')
add('auth_toggle', 'gift_plan', 'enum', { values: ['free', 'plus', 'pro'] })
add('auth_toggle', 'gift_duration', 'integer', { minimum: '1', maximum: '3650' })
add('auth_toggle', 'gift_duration_unit', 'enum', { values: ['days', 'months', 'years'] })
add('plan_prices', 'plus_month plus_year pro_month pro_year', 'integer', { minimum: '1', maximum: '1000000' })
add('plan_prices', 'plus_month_original plus_year_original pro_month_original pro_year_original', 'integer', { minimum: '0', maximum: '1000000' })
add('crypto_wallet', 'payment_mode', 'enum', { values: ['fixed'] })
add('crypto_wallet', 'fixed_tron_address fixed_erc20_address fixed_bep20_address fixed_sol_address', 'string', { maximumCharacters: 100, addressSyntaxRequired: true })
add('sms', 'access_key_id access_key_secret', 'credential', { exposure: 'secret' })
add('sms', 'sign_name template_code template_code_login template_code_register template_code_reset template_code_bind template_code_membership_expiry template_code_membership_expired', 'string', { maximumCharacters: 100 })
add('sms', 'test_phone', 'string', { maximumCharacters: 30 })
add('smtp', 'host user from', 'string', { maximumCharacters: 255 })
add('smtp', 'from_name', 'string', { maximumCharacters: 100 })
add('smtp', 'port', 'integer', { minimum: '1', maximum: '65535' })
add('smtp', 'secure', 'boolean')
add('smtp', 'pass', 'credential', { exposure: 'secret' })
add('qiniu', 'access_key secret_key', 'credential', { exposure: 'secret' })
add('qiniu', 'bucket domain', 'string', { maximumCharacters: 255 })
add('qiniu', 'region', 'enum', { values: ['z0', 'z1', 'z2', 'na0', 'as0', 'cn-east', 'cn-south'] })
add('qiniu', 'private_bucket', 'boolean')
add('media_storage', 'default_provider', 'enum', { values: ['local', 'qiniu'] })
add('media_storage', 'video_provider attachment_provider image_provider resource_provider', 'enum', { values: ['inherit', 'local', 'qiniu'] })
add('media_storage', 'local_root qiniu_connection_test_version qiniu_connection_test_status qiniu_connection_test_stage qiniu_connection_tested_at qiniu_connection_test_error', 'string')
add('media_storage', 'qiniu_connection_test_cleanup_pending', 'boolean')
add('market_menu', 'items', 'json_array', { maximumCharacters: 500000 })
add('toolbox', 'items', 'json_array', { maximumCharacters: 500000 })
add('changelog', 'version', 'integer', { minimum: '1', maximum: '2147483647' })
add('changelog', 'content', 'string', { maximumCharacters: 50000 })

export function settingsValueContracts() { return structuredClone([...registry.values()]) }
// Syntax review only: never decrypts, trims, fills defaults or converts legacy bytes.
// Consumers must additionally check URLs, addresses, HTML, storage proofs and key availability.
export function inspectSettingValue(namespace, key, value) {
  const rule = registry.get(`${namespace}/${key}`)
  check(rule, 'settings_contract_unknown')
  check(value === null || typeof value === 'string', 'settings_contract_value_type')
  const result = { namespace, key, type: rule.type, exposure: rule.exposure,
    valueKind: value === null ? 'null' : value === '' ? 'empty' : 'text', compatible: false,
    needs: [], rawValuePreserved: true, semanticAcceptanceVerified: false }
  if (value === null) { result.needs.push('null_policy'); return result }
  if (Buffer.from(value, 'utf8').toString('utf8') !== value || Buffer.byteLength(value) > 16777215) {
    result.needs.push('representation'); return result
  }
  if (rule.maximumCharacters && [...value].length > rule.maximumCharacters) { result.needs.push('length'); return result }
  if (rule.type === 'boolean') result.compatible = value === 'true' || value === 'false'
  else if (rule.type === 'integer') result.compatible = /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20
    && BigInt(value) >= BigInt(rule.minimum) && BigInt(value) <= BigInt(rule.maximum)
  else if (rule.type === 'enum') result.compatible = rule.values.includes(value)
  else if (rule.type === 'json_array') {
    try { result.compatible = Array.isArray(JSON.parse(value)) } catch { /* invalid JSON remains unresolved */ }
    result.needs.push('item_schema_review')
  } else if (rule.type === 'credential') {
    // Keep ciphertext opaque. Shape detection does not prove authenticated decryption.
    if (value === '') { result.compatible = true; result.needs.push('not_configured') }
    else {
      try { const envelope = JSON.parse(value); result.compatible = !!(envelope && typeof envelope === 'object' && envelope.v && envelope.ct && envelope.iv && envelope.tag) } catch { /* plaintext needs explicit migration */ }
      result.needs.push(result.compatible ? 'keyring_restore_and_decryption_proof' : 'credential_protection_review')
    }
  } else result.compatible = true
  if (!result.compatible) result.needs.push('legacy_value_resolution')
  if (rule.addressSyntaxRequired) result.needs.push('chain_address_validation')
  return result
}
