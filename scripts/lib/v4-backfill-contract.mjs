import { createHash } from 'node:crypto'

export class BackfillError extends Error {
  constructor(code) { super(code); this.code = code }
}
export function requireBackfill(condition, code) { if (!condition) throw new BackfillError(code) }
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    requireBackfill(Number.isSafeInteger(value), 'backfill_non_integral_number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  requireBackfill(value && Object.getPrototypeOf(value) === Object.prototype, 'backfill_value_invalid')
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex')
export const hashPattern = /^[a-f0-9]{64}$/
const identifier = /^[a-z][a-z0-9_]{0,63}$/
const label = /^[A-Za-z0-9_.:-]{1,64}$/
export const inplaceAccountTargets = Object.freeze({ trading_accounts: 'trading_accounts_v4_build',
  trading_account_ownership_intervals: 'trading_account_ownership_intervals_v4_build',
  trading_account_ownerships: 'trading_account_ownerships_v4_build',
  user_trading_account_settings: 'user_trading_account_settings_v4_build' })
export function exactKeys(value, keys) {
  requireBackfill(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'backfill_shape_invalid')
}
export function primaryKey(pk) {
  requireBackfill(Array.isArray(pk) && pk.length > 0 && pk.length <= 8, 'backfill_pk_invalid')
  for (const part of pk) {
    exactKeys(part, ['type', 'value'])
    requireBackfill(typeof part.value === 'string', 'backfill_pk_invalid')
    requireBackfill(part.type === 'text' || (part.type === 'integer' && /^(?:0|-?[1-9][0-9]*)$/.test(part.value)) || (part.type === 'binary' && /^(?:[a-f0-9]{2})+$/.test(part.value)), 'backfill_pk_invalid')
    requireBackfill(['text', 'integer', 'binary'].includes(part.type), 'backfill_pk_invalid')
  }
  requireBackfill(Buffer.byteLength(canonical(pk)) <= 8192, 'backfill_pk_too_large')
  return pk
}
export function streamIdentity(stream) {
  exactKeys(stream, ['sourceTable', 'role'])
  requireBackfill(identifier.test(stream.sourceTable) && label.test(stream.role), 'backfill_stream_invalid')
  return hash(stream)
}
export function validateSpec(spec) {
  exactKeys(spec, ['runId', 'bindings', 'admission'])
  requireBackfill(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(spec.runId), 'backfill_run_id_invalid')
  exactKeys(spec.admission, ['approved', 'blockers'])
  requireBackfill(spec.admission.approved === true && Array.isArray(spec.admission.blockers) && spec.admission.blockers.length === 0, 'backfill_wave_not_approved')
  const b = spec.bindings
  const inplace = Object.hasOwn(b, 'storageMode')
  exactKeys(b, ['logicalSourceId', 'sourceDatabase', 'mirrorDatabase', 'snapshotHash', 'targetServerUuid', 'targetDatabase', 'schemaHash', 'manifestHash', 'transformHash', 'streams', ...(inplace ? ['storageMode'] : [])])
  requireBackfill(/^[A-Za-z0-9_.:-]{1,128}$/.test(b.logicalSourceId), 'backfill_source_invalid')
  requireBackfill([b.sourceDatabase, b.mirrorDatabase, b.targetDatabase].every(v => typeof v === 'string' && identifier.test(v)), 'backfill_database_invalid')
  if (inplace) {
    requireBackfill(['inplace-account-v1', 'inplace-account-v2'].includes(b.storageMode) && b.targetDatabase === b.sourceDatabase
      && b.mirrorDatabase !== b.targetDatabase, 'backfill_inplace_scope_invalid')
  } else requireBackfill(b.targetDatabase !== b.sourceDatabase && b.targetDatabase !== b.mirrorDatabase, 'backfill_target_is_source')
  requireBackfill(typeof b.targetServerUuid === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.targetServerUuid), 'backfill_target_invalid')
  requireBackfill([b.snapshotHash, b.schemaHash, b.manifestHash, b.transformHash].every(v => typeof v === 'string' && hashPattern.test(v)), 'backfill_hash_invalid')
  requireBackfill(Array.isArray(b.streams) && b.streams.length > 0 && b.streams.length <= 165, 'backfill_stream_invalid')
  const streams = b.streams.map(streamIdentity)
  if (inplace) requireBackfill(b.streams.every(stream => ['trading_accounts', 'mt5_account_ownership_history'].includes(stream.sourceTable)), 'backfill_inplace_stream_invalid')
  requireBackfill(new Set(streams).size === streams.length, 'backfill_stream_duplicate')
}
function targetRef(target) {
  exactKeys(target, ['table', 'pk'])
  requireBackfill(identifier.test(target.table), 'backfill_target_ref_invalid')
  primaryKey(target.pk)
}
export function prepareBatch(spec, batch) {
  validateSpec(spec)
  exactKeys(batch, ['batchId', 'stream', 'sequence', 'startCursor', 'endCursor', 'rows'])
  requireBackfill(typeof batch.batchId === 'string' && hashPattern.test(batch.batchId), 'backfill_batch_id_invalid')
  const streamId = streamIdentity(batch.stream)
  requireBackfill(spec.bindings.streams.some(s => streamIdentity(s) === streamId), 'backfill_stream_out_of_scope')
  requireBackfill(Number.isSafeInteger(batch.sequence) && batch.sequence > 0, 'backfill_sequence_invalid')
  if (batch.startCursor !== null) primaryKey(batch.startCursor)
  primaryKey(batch.endCursor)
  requireBackfill(canonical(batch.startCursor) !== canonical(batch.endCursor), 'backfill_cursor_unchanged')
  requireBackfill(Array.isArray(batch.rows) && batch.rows.length > 0 && batch.rows.length <= 500, 'backfill_row_limit')
  const seen = new Set()
  for (const row of batch.rows) {
    exactKeys(row, ['pk', 'sourceHash', 'transformedHash', 'targets', 'payload', 'idMaps'])
    primaryKey(row.pk)
    const pkHash = hash(row.pk)
    requireBackfill(!seen.has(pkHash), 'backfill_source_row_duplicate')
    seen.add(pkHash)
    requireBackfill([row.sourceHash, row.transformedHash].every(v => typeof v === 'string' && hashPattern.test(v)), 'backfill_row_hash_invalid')
    requireBackfill(Array.isArray(row.targets) && row.targets.length > 0 && row.targets.length <= 32, 'backfill_targets_invalid')
    row.targets.forEach(targetRef)
    if (spec.bindings.storageMode) requireBackfill(row.targets.every(target => Object.hasOwn(inplaceAccountTargets, target.table)), 'backfill_inplace_target_invalid')
    requireBackfill(row.transformedHash === hash({ payload: row.payload, targets: row.targets }), 'backfill_transform_hash_mismatch')
    requireBackfill(Array.isArray(row.idMaps) && row.idMaps.length <= 32, 'backfill_maps_invalid')
    for (const mapping of row.idMaps) {
      exactKeys(mapping, ['entityKind', 'sourceTable', 'sourcePk', 'target'])
      requireBackfill(label.test(mapping.entityKind) && identifier.test(mapping.sourceTable), 'backfill_map_invalid')
      primaryKey(mapping.sourcePk)
      targetRef(mapping.target)
      requireBackfill(mapping.sourceTable === batch.stream.sourceTable && canonical(mapping.sourcePk) === canonical(row.pk), 'backfill_map_source_mismatch')
      requireBackfill(row.targets.some(target => canonical(target) === canonical(mapping.target)), 'backfill_map_target_mismatch')
    }
  }
  requireBackfill(canonical(batch.endCursor) === canonical(batch.rows.at(-1).pk), 'backfill_end_cursor_mismatch')
  requireBackfill(Buffer.byteLength(canonical(batch)) <= 2 * 1024 * 1024, 'backfill_byte_limit')
  return { streamId, requestHash: hash(batch), bindingsHash: hash(spec.bindings) }
}
