import { BackfillError, canonical, hash, hashPattern, exactKeys, primaryKey, streamIdentity, requireBackfill } from './v4-backfill-contract.mjs'
export { BackfillError, canonical, hash, streamIdentity, requireBackfill }
const identifier = /^[a-z][a-z0-9_]{0,63}$/
const label = /^[A-Za-z0-9_.:-]{1,64}$/
export const inplaceSettingsTargets = Object.freeze({ system_settings: 'system_settings' })
export function validateSpec(spec) {
  exactKeys(spec, ['runId', 'bindings', 'admission'])
  requireBackfill(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(spec.runId), 'backfill_run_id_invalid')
  exactKeys(spec.admission, ['approved', 'blockers'])
  requireBackfill(spec.admission.approved === true && Array.isArray(spec.admission.blockers) && spec.admission.blockers.length === 0, 'backfill_wave_not_approved')
  const b = spec.bindings
  const inplace = Object.hasOwn(b, 'storageMode')
  requireBackfill(inplace, 'backfill_settings_mode_required')
  exactKeys(b, ['logicalSourceId', 'sourceDatabase', 'mirrorDatabase', 'snapshotHash', 'targetServerUuid', 'targetDatabase', 'schemaHash', 'manifestHash', 'transformHash', 'streams', ...(inplace ? ['storageMode'] : [])])
  requireBackfill(/^[A-Za-z0-9_.:-]{1,128}$/.test(b.logicalSourceId), 'backfill_source_invalid')
  requireBackfill([b.sourceDatabase, b.mirrorDatabase, b.targetDatabase].every(v => typeof v === 'string' && identifier.test(v)), 'backfill_database_invalid')
  if (inplace) {
    requireBackfill(['inplace-settings-v1'].includes(b.storageMode) && b.targetDatabase === b.sourceDatabase
      && b.mirrorDatabase !== b.targetDatabase, 'backfill_inplace_scope_invalid')
  } else requireBackfill(b.targetDatabase !== b.sourceDatabase && b.targetDatabase !== b.mirrorDatabase, 'backfill_target_is_source')
  requireBackfill(typeof b.targetServerUuid === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.targetServerUuid), 'backfill_target_invalid')
  requireBackfill([b.snapshotHash, b.schemaHash, b.manifestHash, b.transformHash].every(v => typeof v === 'string' && hashPattern.test(v)), 'backfill_hash_invalid')
  requireBackfill(Array.isArray(b.streams) && b.streams.length > 0 && b.streams.length <= 165, 'backfill_stream_invalid')
  const streams = b.streams.map(streamIdentity)
  requireBackfill(b.streams.length === 1 && b.streams[0].sourceTable === 'system_config' && b.streams[0].role === 'settings-v1', 'backfill_settings_stream_invalid')
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
    if (spec.bindings.storageMode) requireBackfill(row.targets.every(target => Object.hasOwn(inplaceSettingsTargets, target.table)), 'backfill_inplace_target_invalid')
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
