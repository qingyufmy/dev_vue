import type { PoolConnection, RowDataPacket } from 'mysql2/promise'

import type { SettingType, SettingLookup, SettingMetadata as Metadata } from '../domain/setting-read.js'
interface SettingRow extends RowDataPacket {
  id: string; namespace: string; setting_key: string; value_type: SettingType; sensitivity: Metadata['sensitivity']; revision: string
  value_state: 'null' | 'empty' | 'text'; readable_value: string | null
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100
  && /^[a-z]/.test(value) && !/[^a-z0-9_]/.test(value)
const positive = (value: unknown, maximum: bigint): value is string => typeof value === 'string' && value.length > 0 && value.length <= 20
  && /^[1-9]/.test(value) && !/[^0-9]/.test(value) && BigInt(value) <= maximum
const types: readonly string[] = ['string','boolean','integer','enum','json_array','credential']

// Internal read boundary, not an HTTP authorization policy. Secret values are
// redacted inside SQL, even when a credential has an invalid sensitivity tag.
export async function readSetting(connection: Pick<PoolConnection,'execute'>,
  input: { namespace: string; key: string; expectedType: SettingType }): Promise<SettingLookup> {
  const { namespace, key, expectedType } = input
  if (!identifier(namespace) || !identifier(key) || !types.includes(expectedType)) throw Error('setting_read_scope_invalid')
  const [rows] = await connection.execute<SettingRow[]>(`SELECT CAST(id AS CHAR) id,namespace,setting_key,value_type,sensitivity,
    CAST(revision AS CHAR) revision,
    CASE WHEN value_text IS NULL THEN 'null' WHEN OCTET_LENGTH(value_text)=0 THEN 'empty' ELSE 'text' END value_state,
    CASE WHEN sensitivity='secret' OR value_type='credential' THEN NULL ELSE value_text END readable_value
    FROM system_settings WHERE namespace=? AND setting_key=? LIMIT 2`,[namespace,key])
  if (!rows.length) return { status:'missing' }
  const row = rows[0]
  if (rows.length!==1 || !row || row.namespace!==namespace || row.setting_key!==key || row.value_type!==expectedType
    || !positive(row.id,2147483647n) || !positive(row.revision,18446744073709551615n)
    || !['public','restricted','secret'].includes(row.sensitivity) || !['null','empty','text'].includes(row.value_state)
    || (row.value_type==='credential' && row.sensitivity!=='secret')) throw Error('setting_read_state_invalid')
  const metadata: Metadata = {id:row.id,namespace,key,type:expectedType,sensitivity:row.sensitivity,revision:row.revision}
  if (row.sensitivity==='secret') {
    if (row.readable_value!==null) throw Error('setting_read_redaction_invalid')
    return {status:'protected',metadata,valueState:row.value_state}
  }
  const value=row.readable_value
  if ((row.value_state==='null' && value!==null) || (row.value_state==='empty' && value!=='')
    || (row.value_state==='text' && (typeof value!=='string' || value.length===0))) throw Error('setting_read_value_invalid')
  if (value!==null) {
    if (typeof value!=='string' || Buffer.byteLength(value)>16777215 || Buffer.from(value,'utf8').toString('utf8')!==value) throw Error('setting_read_value_invalid')
    if (expectedType==='boolean' && value!=='true' && value!=='false') throw Error('setting_read_boolean_invalid')
    if (expectedType==='integer' && (!/^(0|-?[1-9][0-9]*)$/.test(value) || /[^0-9-]/.test(value))) throw Error('setting_read_integer_invalid')
    if (expectedType==='json_array') {
      let valid=false;try {valid=Array.isArray(JSON.parse(value))} catch { /* reject invalid storage shape */ }
      if (!valid) throw Error('setting_read_json_invalid')
    }
  }
  // No defaults, rounding, JSON reserialization, decryption or legacy fallback.
  return {status:'found',metadata,valueState:row.value_state,rawValue:value}
}
