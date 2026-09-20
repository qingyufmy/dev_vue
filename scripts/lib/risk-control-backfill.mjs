import { createHash } from 'node:crypto'
import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { mapLegacyRiskControl } from './risk-legacy-control-mapping.mjs'

const stream = { sourceTable: 'global_risk_control', role: 'risk-control-v1' }
const streamId = hash(stream)
const pk = [{ type: 'integer', value: '1' }]
const targets = [{ table: 'global_risk_controls', pk }]

// Uses the existing migration run/batch/row/source tables. The caller supplies
// the verified schema/target admission; this module never performs DDL or commits.
export async function backfillRiskControl(repository, input, verifyTarget) {
  const spec = structuredClone(input)
  check(typeof verifyTarget === 'function', 'risk_control_verifier_required')
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(spec.runId), 'risk_control_run_invalid')
  check(/^[a-f0-9]{64}$/.test(spec.sourceSha256), 'risk_control_source_hash_invalid')
  check(spec.bindings?.kind === 'risk-control-backfill/v1', 'risk_control_bindings_invalid')
  const batchId = hash({ sourceSha256: spec.sourceSha256, bindings: spec.bindings })
  return repository.transaction(async tx => {
    await verifyTarget(tx.connection, spec.bindings)
    const run = await tx.findRun(spec.runId)
    if (run) check(run.bindingsHash === hash(spec.bindings) && canonical(run.bindings) === canonical(spec.bindings), 'risk_control_run_conflict')
    else {
      await tx.insertRun(spec.runId, spec.bindings, hash(spec.bindings))
      await tx.insertCheckpoint(spec.runId, streamId)
    }
    const saved = await tx.findBatch(spec.runId, batchId)
    if (saved) {
      check(saved.requestHash === spec.sourceSha256 && saved.rows === 1 && saved.sequence === 1, 'risk_control_receipt_conflict')
      const [archives] = await tx.connection.execute(`SELECT source_bytes_sha256,source_payload_json
        FROM data_migration_source_rows WHERE run_id=? AND stream_id=? AND source_pk_sha256=? FOR UPDATE`,
      [spec.runId, streamId, hash(pk)])
      check(archives.length === 1 && archives[0].source_bytes_sha256 === spec.sourceSha256, 'risk_control_archive_missing')
      const source = typeof archives[0].source_payload_json === 'string' ? JSON.parse(archives[0].source_payload_json) : archives[0].source_payload_json
      // Recompute raw mapping hash without depending on current user membership or target values.
      const fields = ['id', 'global_kill_switch', 'reason', 'changed_by', 'updated_at']
      check(source && Object.keys(source).sort().join(',') === [...fields].sort().join(','), 'risk_control_archive_corrupt')
      const ordered = Object.fromEntries(fields.map(key => [key, source[key]]))
      check(createHash('sha256').update(JSON.stringify(ordered)).digest('hex') === spec.sourceSha256, 'risk_control_archive_corrupt')
      return { status: 'committed', replay: true, rows: 1 }
    }
    const checkpoint = await tx.findCheckpoint(spec.runId, streamId)
    check(checkpoint?.sequence === 0 && checkpoint.cursor === null && checkpoint.processedRows === '0', 'risk_control_checkpoint_conflict')
    const [rows] = await tx.connection.query(`SELECT id,global_kill_switch,reason,changed_by,
      DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') updated_at FROM global_risk_control ORDER BY id LIMIT 2 FOR UPDATE`)
    const actor = rows[0]?.changed_by
    const [users] = await tx.connection.execute('SELECT id FROM users WHERE id=? FOR SHARE', [actor ?? 0])
    const mapped = mapLegacyRiskControl(rows, new Set(users.map(user => String(user.id))))
    check(mapped.sourceSha256 === spec.sourceSha256, 'risk_control_source_drift')
    const [current] = await tx.connection.query('SELECT id FROM global_risk_controls ORDER BY id LIMIT 2 FOR UPDATE')
    check(current.length === 0, 'risk_control_target_occupied')
    const t = mapped.target
    await tx.connection.execute(`INSERT INTO global_risk_controls
      (id,kill_switch,reason,changed_by_user_id,revision,updated_at_utc) VALUES (?,?,?,?,?,?)`,
    [t.id, t.kill_switch, t.reason, t.changed_by_user_id, t.revision, t.updated_at_utc])
    await tx.insertBatch(spec.runId, { batchId, streamId, sequence: 1, requestHash: spec.sourceSha256, rows: 1, endCursor: pk })
    await tx.insertReceipt(spec.runId, streamId, batchId, { pk, sourceHash: mapped.sourceSha256,
      transformedHash: hash({ target: t, actorMapping: mapped.actorMapping }), targets })
    await tx.connection.execute(`INSERT INTO data_migration_source_rows
      (run_id,stream_id,source_pk_sha256,source_bytes_sha256,source_payload_json,created_at_utc)
      VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`, [spec.runId, streamId, hash(pk), mapped.sourceSha256, JSON.stringify(mapped.source)])
    await tx.advanceCheckpoint(spec.runId, streamId, 0, 1, pk, '1')
    return { status: 'committed', replay: false, rows: 1 }
  })
}
