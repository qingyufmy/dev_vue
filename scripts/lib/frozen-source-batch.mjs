import { canonical, hash, primaryKey, streamIdentity, requireBackfill } from './v4-backfill-contract.mjs'

// One bounded batch, executed inside MysqlBackfillRepository.transaction. The
// outer upgrade coordinator must admit the actual schema and frozen role plan.
export function createFrozenSourceBatch(entries, options, { sourceTable, role, errorPrefix, createWriter, projectRow }) {
  const check = (value, code) => requireBackfill(value, `${errorPrefix}_batch_${code}`)
  entries = structuredClone(entries); options = structuredClone(options)
  const { runId, logicalSourceId, bindings, sequence, startCursor } = options
  check(bindings?.logicalSourceId === logicalSourceId && Number.isSafeInteger(sequence) && sequence > 0
    && entries.length > 0 && entries.length <= 100, 'options')
  if (startCursor !== null) {
    primaryKey(startCursor)
    check(startCursor.length === 1 && startCursor[0].type === 'integer' && /^[1-9]\d*$/.test(startCursor[0].value), 'cursor')
  }
  const writer = createWriter(entries, { runId, logicalSourceId })
  let previous = startCursor === null ? 0n : BigInt(startCursor[0].value)
  for (const entry of entries) {
    check(BigInt(entry.source.id) > previous, 'order')
    previous = BigInt(entry.source.id)
  }
  const stream = streamIdentity({ sourceTable, role })
  const rows = entries.map(projectRow)
  const request = { runId, stream, sequence, startCursor, rows, bindingsHash: hash(bindings) }
  check(Buffer.byteLength(canonical(request)) <= 2 * 1024 * 1024, 'byte_limit')
  const batchId = hash(request), endCursor = rows.at(-1).pk
  const receipt = { batchId, streamId: stream, sequence, requestHash: batchId, rows: rows.length, endCursor }
  const verifyEvidence = async (tx, row) => {
    const [saved] = await tx.connection.execute(`SELECT r.batch_id,r.source_pk_json,r.source_bytes_sha256,r.transformed_sha256,r.targets_json,
      a.source_bytes_sha256 archive_sha256,a.source_payload_json FROM data_migration_row_receipts r
      JOIN data_migration_source_rows a ON a.run_id=r.run_id AND a.stream_id=r.stream_id AND a.source_pk_sha256=r.source_pk_sha256
      WHERE r.run_id=? AND r.stream_id=? AND r.source_pk_sha256=? FOR UPDATE`, [runId, stream, hash(row.pk)])
    const decode = value => typeof value === 'string' ? JSON.parse(value) : value
    const actual = saved[0]
    check(saved.length === 1 && actual.batch_id === batchId && actual.source_bytes_sha256 === row.sourceHash
      && actual.archive_sha256 === row.sourceHash && actual.transformed_sha256 === row.transformedHash
      && canonical(decode(actual.source_pk_json)) === canonical(row.pk)
      && canonical(decode(actual.targets_json)) === canonical(row.targets)
      && canonical(decode(actual.source_payload_json)) === canonical(row.source), 'evidence_conflict')
  }
  return { batchId, streamId: stream, sequence, rows: rows.length, async execute(tx) {
    const run = await tx.findRun(runId)
    check(run && run.bindingsHash === hash(bindings) && canonical(run.bindings) === canonical(bindings), 'run_mismatch')
    const saved = await tx.findBatch(runId, batchId)
    if (saved) {
      check(saved.requestHash === batchId && saved.sequence === sequence && saved.rows === rows.length, 'receipt_conflict')
      const committed = await tx.findCheckpoint(runId, stream)
      check(committed && committed.sequence >= sequence && /^[0-9]+$/.test(committed.processedRows)
        && BigInt(committed.processedRows) >= BigInt(rows.length)
        && Array.isArray(committed.cursor) && committed.cursor.length === 1 && committed.cursor[0].type === 'integer'
        && typeof committed.cursor[0].value === 'string' && /^[1-9]\d*$/.test(committed.cursor[0].value)
        && (committed.sequence === sequence ? canonical(committed.cursor) === canonical(endCursor)
          : BigInt(committed.cursor[0].value) > BigInt(endCursor[0].value)), 'checkpoint_conflict')
      for (let i = 0; i < rows.length; i++) {
        await writer.write(tx, entries[i], { verifyOnly: true })
        await verifyEvidence(tx, rows[i])
      }
      return { status: 'committed', batchId, replayed: true }
    }
    const checkpoint = await tx.findCheckpoint(runId, stream)
    check(checkpoint && checkpoint.sequence + 1 === sequence && canonical(checkpoint.cursor) === canonical(startCursor), 'checkpoint_conflict')
    await tx.insertBatch(runId, receipt)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      check(!await tx.findReceipt(runId, stream, hash(row.pk)), 'row_exists')
      await writer.write(tx, entries[i])
      await tx.insertReceipt(runId, stream, batchId, row)
      await tx.connection.execute(`INSERT INTO data_migration_source_rows
        (run_id,stream_id,source_pk_sha256,source_bytes_sha256,source_payload_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
      [runId, stream, hash(row.pk), row.sourceHash, canonical(row.source)])
      await verifyEvidence(tx, row)
    }
    const total = BigInt(checkpoint.processedRows) + BigInt(rows.length)
    check(total <= 18446744073709551615n, 'count_overflow')
    await tx.advanceCheckpoint(runId, stream, checkpoint.sequence, sequence, endCursor, total.toString())
    return { status: 'committed', batchId, replayed: false }
  } }
}
