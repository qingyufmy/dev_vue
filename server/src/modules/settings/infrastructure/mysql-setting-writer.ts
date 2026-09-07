import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { SettingType } from './mysql-setting-reader.js'

export interface SettingUpdate {
  namespace: string; key: string; expectedType: Exclude<SettingType, 'credential'>
  expectedRevision: string; value: string | null; requestId: string; actorUserId: number
}
export type SettingValueValidator = (input: Readonly<Pick<SettingUpdate, 'namespace' | 'key' | 'expectedType' | 'value'>>) => boolean
interface Snapshot extends RowDataPacket { id: string; revision: string; fingerprint: string; value_type: string; sensitivity: string }
// Version 1: ordered JSON array of all 15 persisted columns. Dates are UTC
// session text with six fractional digits; integer fields are decimal strings.
const snapshotSql = `SELECT CAST(id AS CHAR) id,CAST(revision AS CHAR) revision,value_type,sensitivity,
  SHA2(CAST(JSON_ARRAY(CAST(id AS CHAR),namespace,setting_key,value_type,value_text,sensitivity,label,
    CAST(sort_order AS CHAR),DATE_FORMAT(created_at_utc,'%Y-%m-%d %H:%i:%s.%f'),
    DATE_FORMAT(updated_at_utc,'%Y-%m-%d %H:%i:%s.%f'),CAST(revision AS CHAR),origin,
    migration_run_id,source_sha256,DATE_FORMAT(imported_at_utc,'%Y-%m-%d %H:%i:%s.%f')) AS CHAR),256) fingerprint
  FROM system_settings WHERE namespace=? AND setting_key=? FOR UPDATE`

// Trusted caller owns UTC session, transaction, actor authorization, semantic
// policy and durable request recovery. Roll back on EVERY error; never retry an
// uncertain commit. Hash-only audit is not a request-idempotency receipt.
// This primitive updates existing non-secret values only, never credentials.
export async function updateSettingInTransaction(connection: PoolConnection, input: SettingUpdate, validate: SettingValueValidator) {
  const change = { ...input }
  const { namespace, key, expectedType, expectedRevision, value, requestId, actorUserId } = change
  if (typeof requestId !== 'string' || requestId.length !== 36
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)
    || !Number.isSafeInteger(actorUserId) || actorUserId < 1 || actorUserId > 2147483647
    || typeof expectedRevision !== 'string' || !/^[1-9][0-9]{0,19}$/.test(expectedRevision)
    || /[^0-9]/.test(expectedRevision) || BigInt(expectedRevision) >= 18446744073709551615n
    || !['string','boolean','integer','enum','json_array'].includes(expectedType)
    || (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 16777215 || Buffer.from(value).toString('utf8') !== value))
    || typeof validate !== 'function') throw Error('setting_update_invalid')
  if (value !== null) {
    if (expectedType === 'boolean' && value !== 'true' && value !== 'false') throw Error('setting_update_value_invalid')
    if (expectedType === 'integer' && (!/^(0|-?[1-9][0-9]*)$/.test(value) || /[^0-9-]/.test(value))) throw Error('setting_update_value_invalid')
    if (expectedType === 'json_array') {
      let valid = false; try { valid = Array.isArray(JSON.parse(value)) } catch { /* invalid JSON */ }
      if (!valid) throw Error('setting_update_value_invalid')
    }
  }
  for (const identifier of [namespace, key]) {
    if (typeof identifier !== 'string' || identifier.length < 1 || identifier.length > 100
      || !/^[a-z]/.test(identifier) || /[^a-z0-9_]/.test(identifier)) throw Error('setting_update_invalid')
  }
  if (validate(Object.freeze({ namespace, key, expectedType, value })) !== true) throw Error('setting_update_policy_rejected')
  const [beforeRows] = await connection.execute<Snapshot[]>(snapshotSql, [namespace, key])
  const before = beforeRows[0]
  if (beforeRows.length !== 1 || !before || before.revision !== expectedRevision) throw Error('setting_revision_conflict')
  if (before.value_type !== expectedType || !['public','restricted'].includes(before.sensitivity)
    || typeof before.id !== 'string' || !/^[1-9][0-9]{0,9}$/.test(before.id) || /[^0-9]/.test(before.id)
    || BigInt(before.id) > 2147483647n || !/^[a-f0-9]{64}$/.test(before.fingerprint)) throw Error('setting_update_state_invalid')
  const revision = (BigInt(expectedRevision) + 1n).toString()
  const [updated] = await connection.execute<ResultSetHeader>(
    'UPDATE system_settings SET value_text=?,revision=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND revision=?',
    [value, revision, before.id, expectedRevision])
  if (updated.affectedRows !== 1) throw Error('setting_revision_conflict')
  const [afterRows] = await connection.execute<Snapshot[]>(snapshotSql, [namespace, key])
  const after = afterRows[0]
  if (afterRows.length !== 1 || !after || after.id !== before.id || after.revision !== revision
    || !/^[a-f0-9]{64}$/.test(after.fingerprint)) throw Error('setting_update_readback_invalid')
  await connection.execute(
    'INSERT INTO system_setting_changes (setting_id,revision,request_id,actor_user_id,previous_sha256,current_sha256,recorded_at_utc) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))',
    [before.id, revision, requestId, actorUserId, before.fingerprint, after.fingerprint])
  return { id: before.id, revision }
}
