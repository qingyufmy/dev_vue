export type SettingValueType = 'string' | 'boolean' | 'integer' | 'enum' | 'json_array' | 'credential'
interface Rule {
  namespace: string; key: string; type: SettingValueType; exposure: 'restricted' | 'secret'
  values?: string[]; minimum?: string; maximum?: string; maximumCharacters?: number; addressSyntaxRequired?: boolean
}
const registry = new Map<string, Rule>()
function add(namespace: string, keys: string, type: SettingValueType, options: Partial<Omit<Rule, 'namespace' | 'key' | 'type'>> = {}) {
  for (const key of keys.split(' ')) {
    const id = `${namespace}/${key}`
    if (registry.has(id)) throw Error('setting_policy_duplicate')
    registry.set(id, { namespace, key, type, exposure:'restricted', ...options })
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

export function settingValueRules(): Rule[] { return structuredClone([...registry.values()]) }
export interface SettingValueInput { namespace: string; key: string; expectedType: SettingValueType; value: string | null }
export type SettingPolicyCheck = 'chain_address' | 'menu_items' | 'toolbox_items' | 'changelog_content'
  | 'smtp_endpoint' | 'smtp_identity' | 'sms_configuration' | 'qiniu_configuration' | 'storage_provider_ready'
export type SettingValueInspection = { status:'rejected'; code:string }
  | { status:'eligible'; policyChecks: readonly SettingPolicyCheck[] }
const reject = (code:string): SettingValueInspection => ({status:'rejected',code})

// This is the runtime write policy. Legacy import inspection remains separately
// frozen: data-preserving migration must not silently inherit new write rules.
export function inspectSettingUpdate(input: Readonly<SettingValueInput>): SettingValueInspection {
  const { namespace, key, expectedType, value } = input
  const rule = registry.get(`${namespace}/${key}`)
  if (!rule || rule.namespace!==namespace || rule.key!==key) return reject('setting_policy_unknown')
  if (rule.type!==expectedType) return reject('setting_policy_type_mismatch')
  if (rule.type==='credential') return reject('setting_policy_credential_writer_required')
  if (namespace==='media_storage' && (key==='local_root' || key.startsWith('qiniu_connection_test')))
    return reject('setting_policy_service_owned')
  // A generic update cannot clear a setting by NULL. Disabling/unconfiguring a
  // provider is an explicit domain operation, not implicit fallback deletion.
  if (typeof value!=='string') return reject('setting_policy_null_not_allowed')
  if (Buffer.byteLength(value)>16777215 || Buffer.from(value).toString('utf8')!==value) return reject('setting_policy_encoding')
  if (rule.maximumCharacters!==undefined && [...value].length>rule.maximumCharacters) return reject('setting_policy_length')
  if (rule.type==='boolean' && value!=='true' && value!=='false') return reject('setting_policy_boolean')
  if (rule.type==='integer' && (value.length>20 || !/^(0|[1-9][0-9]*)$/.test(value) || /[^0-9]/.test(value)
    || BigInt(value)<BigInt(rule.minimum!) || BigInt(value)>BigInt(rule.maximum!))) return reject('setting_policy_integer')
  if (rule.type==='enum' && !rule.values!.includes(value)) return reject('setting_policy_enum')
  if (rule.type==='json_array') {
    let valid=false;try {valid=Array.isArray(JSON.parse(value))} catch { /* reject malformed JSON */ }
    if (!valid) return reject('setting_policy_json_array')
  }
  const policyChecks: SettingPolicyCheck[] = []
  if (rule.addressSyntaxRequired) policyChecks.push('chain_address')
  if (namespace==='market_menu') policyChecks.push('menu_items')
  if (namespace==='toolbox') policyChecks.push('toolbox_items')
  if (namespace==='changelog' && key==='content') policyChecks.push('changelog_content')
  if (namespace==='smtp' && key==='host') policyChecks.push('smtp_endpoint')
  if (namespace==='smtp' && ['user','from','from_name'].includes(key)) policyChecks.push('smtp_identity')
  if (namespace==='sms') policyChecks.push('sms_configuration')
  if (namespace==='qiniu') policyChecks.push('qiniu_configuration')
  if (namespace==='media_storage') policyChecks.push('storage_provider_ready')
  return {status:'eligible',policyChecks}
}

// Caller supplies already available domain evidence; no network I/O or async
// checks inside the DB transaction. Every required check must return true.
export function validateSettingValueForWrite(input: Readonly<SettingValueInput>,
  validateDomain?: (check: SettingPolicyCheck, input: Readonly<SettingValueInput>) => boolean): boolean {
  const copy=Object.freeze({...input})
  const result=inspectSettingUpdate(copy)
  return result.status==='eligible' && result.policyChecks.every(check=>validateDomain?.(check,copy)===true)
}
