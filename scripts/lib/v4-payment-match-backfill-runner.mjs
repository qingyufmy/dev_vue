import { BackfillError, canonical, hash, prepareBatch, requireBackfill as check, streamIdentity, validateSpec } from './v4-payment-match-backfill-contract.mjs'

async function withRetry(repository, work) {
  for (let attempt = 0; ; attempt++) {
    try { return await repository.transaction(work) }
    catch (error) {
      // Only the adapter can establish that rollback completed. No retry of unknown commit.
      if (attempt >= 2 || error?.code !== 'backfill_deadlock_rolled_back') throw error
    }
  }
}
async function verifyTarget(tx, bindings) {
  const actual = await tx.targetIdentity()
  check(actual.storageMode === bindings.storageMode, 'backfill_storage_mode_mismatch')
  check(actual.serverUuid === bindings.targetServerUuid && actual.database === bindings.targetDatabase, 'backfill_target_identity_mismatch')
  check(actual.schemaHash === bindings.schemaHash, 'backfill_schema_drift')
}
async function lockedRun(tx, spec) {
  const run = await tx.findRun(spec.runId)
  check(run && run.bindingsHash === hash(spec.bindings) && canonical(run.bindings) === canonical(spec.bindings), 'backfill_run_bindings_mismatch')
  return run
}
function committedReceipt(saved, prepared) {
  check(saved.requestHash === prepared.requestHash, 'backfill_batch_content_conflict')
  return { status: 'committed', batchId: saved.batchId, sequence: saved.sequence, rows: saved.rows }
}

export async function prepareBackfillRun(repository, spec) {
  spec = structuredClone(spec)
  validateSpec(spec)
  return withRetry(repository, async tx => {
    await verifyTarget(tx, spec.bindings)
    const run = await tx.findRun(spec.runId)
    if (run) {
      check(run.bindingsHash === hash(spec.bindings) && canonical(run.bindings) === canonical(spec.bindings), 'backfill_run_bindings_mismatch')
      return { status: 'prepared', runId: spec.runId, existing: true }
    }
    await tx.insertRun(spec.runId, spec.bindings, hash(spec.bindings))
    for (const stream of spec.bindings.streams) await tx.insertCheckpoint(spec.runId, streamIdentity(stream))
    return { status: 'prepared', runId: spec.runId, existing: false }
  })
}

export async function executeBackfillBatch(repository, spec, input, writer) {
  // Snapshot inputs before awaits; the writer receives a clone, never the receipt evidence object.
  spec = structuredClone(spec)
  const batch = structuredClone(input)
  const prepared = prepareBatch(spec, batch)
  check(writer && writer.transformHash === spec.bindings.transformHash && typeof writer.write === 'function', 'backfill_writer_mismatch')
  check(writer.storageMode === spec.bindings.storageMode, 'backfill_writer_storage_mode_mismatch')
  return withRetry(repository, async tx => {
    await verifyTarget(tx, spec.bindings)
    await lockedRun(tx, spec)
    const saved = await tx.findBatch(spec.runId, batch.batchId)
    if (saved) return committedReceipt(saved, prepared)
    const checkpoint = await tx.findCheckpoint(spec.runId, prepared.streamId)
    check(checkpoint && checkpoint.sequence + 1 === batch.sequence && canonical(checkpoint.cursor) === canonical(batch.startCursor), 'backfill_checkpoint_conflict')
    const receipt = { batchId: batch.batchId, streamId: prepared.streamId, sequence: batch.sequence, requestHash: prepared.requestHash, rows: batch.rows.length, endCursor: batch.endCursor }
    await tx.insertBatch(spec.runId, receipt)
    for (const row of batch.rows) {
      check(!await tx.findReceipt(spec.runId, prepared.streamId, hash(row.pk)), 'backfill_row_already_disposed')
      for (const mapping of row.idMaps) {
        const current = await tx.findMapping(spec.bindings.logicalSourceId, mapping)
        if (current) check(canonical(current.sourcePk) === canonical(mapping.sourcePk) && canonical(current.target) === canonical(mapping.target), 'backfill_id_map_conflict')
        else await tx.insertMapping(spec.runId, spec.bindings.logicalSourceId, mapping)
      }
      const written = await writer.write(tx.connection, structuredClone(row))
      check(written?.transformedHash === row.transformedHash, 'backfill_writer_receipt_mismatch')
      await tx.insertReceipt(spec.runId, prepared.streamId, batch.batchId, row)
    }
    const total = BigInt(checkpoint.processedRows) + BigInt(batch.rows.length)
    check(total <= 18446744073709551615n, 'backfill_row_count_overflow')
    await tx.advanceCheckpoint(spec.runId, prepared.streamId, checkpoint.sequence, batch.sequence, batch.endCursor, total.toString())
    return committedReceipt(receipt, prepared)
  })
}

export async function recoverBackfillBatch(repository, spec, input) {
  spec = structuredClone(spec)
  const batch = structuredClone(input)
  const prepared = prepareBatch(spec, batch)
  try {
    return await repository.transaction(async tx => {
      await verifyTarget(tx, spec.bindings)
      await lockedRun(tx, spec)
      // Current locking reads wait for an earlier disconnected transaction's outcome.
      const saved = await tx.findBatch(spec.runId, batch.batchId)
      if (saved) return committedReceipt(saved, prepared)
      const checkpoint = await tx.findCheckpoint(spec.runId, prepared.streamId)
      check(checkpoint && checkpoint.sequence + 1 === batch.sequence && canonical(checkpoint.cursor) === canonical(batch.startCursor), 'backfill_recovery_checkpoint_conflict')
      return { status: 'not_committed', batchId: batch.batchId }
    })
  } catch (error) {
    if (error instanceof BackfillError && !['backfill_commit_unknown', 'backfill_storage_failed', 'backfill_rollback_unknown', 'backfill_deadlock_rolled_back'].includes(error.code)) throw error
    return { status: 'unknown', batchId: batch.batchId }
  }
}
