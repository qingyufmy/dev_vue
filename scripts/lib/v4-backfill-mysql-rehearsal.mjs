import { canonical, exactKeys, hash, requireBackfill as check, streamIdentity } from './v4-backfill-contract.mjs'
import { MysqlBackfillRepository, readBackfillTargetIdentity } from './v4-backfill-mysql-repository.mjs'
import { executeBackfillBatch, prepareBackfillRun, recoverBackfillBatch } from './v4-backfill-runner.mjs'
import { readMigrationStructure } from './v4-backfill-preflight.mjs'

export const REHEARSAL_SCOPE = Object.freeze({
  id: 'u2-a-synthetic-20260906', database: 'dev_vue_m1_a', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104',
  structureHash: '9bce7856c13d7b54a0042a7414d30f209e5d3f2d152d6d28d6e8bf012c4f2218',
  logicalSourceId: 'u2-synthetic-20260906-a', runId: 'd47c6d10-0000-4000-8000-202609060001',
  sentinelIds: Object.freeze([2, 3, 4, 5].map(n => 'd47c6d10-0000-4000-8000-20260906000' + n)),
})
const tables = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches', 'data_migration_id_maps', 'data_migration_row_receipts']
const pk = value => [{ type: 'integer', value: String(value) }]
const decode = value => typeof value === 'string' ? JSON.parse(value) : value
const transformHash = hash('synthetic-ledger-sentinel-v1')
export function buildMysqlRehearsal(schemaHash) {
  const spec = { runId: REHEARSAL_SCOPE.runId, admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: REHEARSAL_SCOPE.logicalSourceId, sourceDatabase: 'synthetic_no_source', mirrorDatabase: 'synthetic_no_mirror', snapshotHash: hash('synthetic-not-a-real-snapshot'),
    targetServerUuid: REHEARSAL_SCOPE.serverUuid, targetDatabase: REHEARSAL_SCOPE.database, schemaHash,
    manifestHash: hash(REHEARSAL_SCOPE), transformHash, streams: [{ sourceTable: 'synthetic_rows', role: 'transaction_fixture' }],
  } }
  const batches = REHEARSAL_SCOPE.sentinelIds.map((id, i) => {
    const n = i + 1, payload = { kind: 'synthetic-transaction-sentinel', sequence: n, amount: '123456789012.12345678' }
    const targets = [{ table: 'data_migration_runs', pk: [{ type: 'text', value: id }] }]
    return { batchId: hash([REHEARSAL_SCOPE.id, n]), stream: spec.bindings.streams[0], sequence: n, startCursor: i ? pk(i) : null, endCursor: pk(n), rows: [{
      pk: pk(n), sourceHash: hash(['synthetic-row', n]), payload, targets, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'synthetic_sentinel', sourceTable: 'synthetic_rows', sourcePk: pk(n), target: targets[0] }],
    }] }
  })
  return { spec, batches }
}
async function withConnection(pool, work) {
  const c = await pool.getConnection()
  try {
    const [[actual]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
    check(actual.db === REHEARSAL_SCOPE.database && actual.uuid === REHEARSAL_SCOPE.serverUuid, 'rehearsal_target_mismatch')
    return await work(c)
  } finally { c.release() }
}
async function counts(connection) {
  const result = {}
  for (const table of tables) {
    const [[row]] = await connection.query('SELECT CAST(COUNT(*) AS CHAR) n FROM `' + table + '`')
    result[table] = row.n
  }
  return result
}
async function verifyState(pool, fixture, n) {
  return withConnection(pool, async c => {
    const actual = await counts(c)
    const expected = [n + 1, 1, n, n, n]
    tables.forEach((t, i) => check(actual[t] === String(expected[i]), 'rehearsal_row_count_mismatch'))
    const [[run]] = await c.execute('SELECT bindings_sha256,bindings_json FROM data_migration_runs WHERE id=?', [fixture.spec.runId])
    check(run && run.bindings_sha256 === hash(fixture.spec.bindings) && canonical(decode(run.bindings_json)) === canonical(fixture.spec.bindings), 'rehearsal_run_mismatch')
    const [[checkpoint]] = await c.execute('SELECT sequence_number,processed_rows,cursor_json FROM data_migration_checkpoints WHERE run_id=? AND stream_id=?', [fixture.spec.runId, streamIdentity(fixture.spec.bindings.streams[0])])
    check(checkpoint && String(checkpoint.sequence_number) === String(n) && String(checkpoint.processed_rows) === String(n) && canonical(decode(checkpoint.cursor_json)) === canonical(n ? pk(n) : null), 'rehearsal_checkpoint_mismatch')
    for (const batch of fixture.batches.slice(0, n)) {
      const row = batch.rows[0]
      const [[sentinel]] = await c.execute('SELECT bindings_sha256,bindings_json FROM data_migration_runs WHERE id=?', [row.targets[0].pk[0].value])
      check(sentinel && sentinel.bindings_sha256 === hash(row.payload) && canonical(decode(sentinel.bindings_json)) === canonical(row.payload), 'rehearsal_payload_mismatch')
      const [[saved]] = await c.execute('SELECT request_sha256,sequence_number,row_count FROM data_migration_batches WHERE run_id=? AND batch_id=?', [fixture.spec.runId, batch.batchId])
      check(saved && saved.request_sha256 === hash(batch) && String(saved.sequence_number) === String(batch.sequence) && String(saved.row_count) === '1', 'rehearsal_batch_mismatch')
      const [[receipt]] = await c.execute('SELECT source_bytes_sha256,transformed_sha256,targets_json FROM data_migration_row_receipts WHERE run_id=? AND stream_id=? AND source_pk_sha256=?', [fixture.spec.runId, streamIdentity(batch.stream), hash(row.pk)])
      check(receipt && receipt.source_bytes_sha256 === row.sourceHash && receipt.transformed_sha256 === row.transformedHash && canonical(decode(receipt.targets_json)) === canonical(row.targets), 'rehearsal_receipt_mismatch')
      const [[mapping]] = await c.execute('SELECT source_pk_json,target_json,created_run_id FROM data_migration_id_maps WHERE logical_source_id=? AND entity_kind=? AND source_table=? AND source_pk_sha256=?', [REHEARSAL_SCOPE.logicalSourceId, 'synthetic_sentinel', 'synthetic_rows', hash(row.pk)])
      check(mapping && mapping.created_run_id === fixture.spec.runId && canonical(decode(mapping.source_pk_json)) === canonical(row.pk) && canonical(decode(mapping.target_json)) === canonical(row.targets[0]), 'rehearsal_mapping_mismatch')
    }
    return actual
  })
}

// Operator-only library: flags encode an already obtained approval; they do not grant it.
export async function runMysqlBackfillRehearsal(pool, approval) {
  exactKeys(approval, ['scope', 'apply', 'cleanup'])
  check(approval.scope === REHEARSAL_SCOPE.id && approval.apply === true && approval.cleanup === true, 'rehearsal_explicit_scope_required')
  const target = await withConnection(pool, async c => {
    const identity = await readBackfillTargetIdentity(c)
    check(identity.database === REHEARSAL_SCOPE.database && identity.serverUuid === REHEARSAL_SCOPE.serverUuid, 'rehearsal_target_mismatch')
    check((await readMigrationStructure(c)).sha256 === REHEARSAL_SCOPE.structureHash, 'rehearsal_structure_mismatch')
    const [[installed]] = await c.query('SELECT COUNT(*) n FROM schema_migrations')
    check(String(installed.n) === '26', 'rehearsal_migration_count_mismatch')
    check(Object.values(await counts(c)).every(n => n === '0'), 'rehearsal_ledger_not_empty')
    return identity
  })
  let commitFault = null, writerFailure = false, writerCalls = 0
  const faultPool = { async getConnection() {
    const c = await pool.getConnection()
    return new Proxy(c, { get(object, key) {
      if (key === 'commit') return async () => {
        const fault = commitFault; commitFault = null
        if (fault === 'before') { await c.rollback(); throw new Error('synthetic_before_commit_response') }
        await c.commit()
        if (fault === 'after') throw new Error('synthetic_after_commit_response')
      }
      const value = Reflect.get(object, key)
      return typeof value === 'function' ? value.bind(object) : value
    } })
  } }
  const repository = new MysqlBackfillRepository(faultPool), fixture = buildMysqlRehearsal(target.schemaHash)
  const writer = { transformHash, async write(c, row) {
    writerCalls++
    await c.execute('INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,?,UTC_TIMESTAMP(3))', [row.targets[0].pk[0].value, hash(row.payload), canonical(row.payload)])
    if (writerFailure) throw new Error('synthetic_writer_failure')
    return { transformedHash: row.transformedHash }
  } }
  const execute = index => executeBackfillBatch(repository, fixture.spec, fixture.batches[index], writer)
  const expectError = async (work, code) => {
    try { await work() } catch (error) { check(error.code === code, 'rehearsal_unexpected_error'); return }
    check(false, 'rehearsal_expected_error_missing')
  }
  const steps = []
  await prepareBackfillRun(repository, fixture.spec)
  await verifyState(pool, fixture, 0)
  const concurrent = await Promise.allSettled([execute(0), execute(0)])
  check(concurrent.every(r => r.status === 'fulfilled' && r.value.status === 'committed'), 'rehearsal_concurrent_batch_failed')
  check(writerCalls === 1, 'rehearsal_duplicate_writer')
  steps.push({ scenario: 'concurrent_same_batch', counts: await verifyState(pool, fixture, 1) })
  writerFailure = true
  await expectError(() => execute(1), 'backfill_storage_failed')
  steps.push({ scenario: 'writer_failure_rollback', counts: await verifyState(pool, fixture, 1) })
  writerFailure = false; await execute(1)
  steps.push({ scenario: 'explicit_retry_after_rollback', counts: await verifyState(pool, fixture, 2) })
  commitFault = 'after'; await expectError(() => execute(2), 'backfill_commit_unknown')
  check((await recoverBackfillBatch(repository, fixture.spec, fixture.batches[2])).status === 'committed', 'rehearsal_recovery_failed')
  await execute(2); check(writerCalls === 4, 'rehearsal_committed_replayed')
  steps.push({ scenario: 'commit_then_injected_response_loss', counts: await verifyState(pool, fixture, 3) })
  commitFault = 'before'; await expectError(() => execute(3), 'backfill_commit_unknown')
  check((await recoverBackfillBatch(repository, fixture.spec, fixture.batches[3])).status === 'not_committed', 'rehearsal_recovery_failed')
  await verifyState(pool, fixture, 3); await execute(3)
  check(writerCalls === 6, 'rehearsal_writer_count_mismatch')
  steps.push({ scenario: 'rollback_then_injected_response_loss', counts: await verifyState(pool, fixture, 4) })
  // Only normal completion reaches bounded cleanup. Failure evidence is deliberately retained.
  await repository.transaction(async tx => {
    const actual = await tx.targetIdentity()
    check(canonical(actual) === canonical(target), 'rehearsal_target_mismatch')
    const run = await tx.findRun(fixture.spec.runId)
    check(run && run.bindingsHash === hash(fixture.spec.bindings) && canonical(run.bindings) === canonical(fixture.spec.bindings), 'rehearsal_run_mismatch')
    const remove = async (sql, parameters, expected) => {
      const [result] = await tx.connection.execute(sql, parameters)
      check(result.affectedRows === expected, 'rehearsal_cleanup_scope_mismatch')
    }
    for (const [table, count] of [['data_migration_row_receipts', 4], ['data_migration_batches', 4], ['data_migration_checkpoints', 1]]) await remove('DELETE FROM `' + table + '` WHERE run_id=?', [fixture.spec.runId], count)
    await remove('DELETE FROM data_migration_id_maps WHERE logical_source_id=? AND created_run_id=?', [REHEARSAL_SCOPE.logicalSourceId, fixture.spec.runId], 4)
    for (const id of [...REHEARSAL_SCOPE.sentinelIds, fixture.spec.runId]) await remove('DELETE FROM data_migration_runs WHERE id=?', [id], 1)
  })
  const finalCounts = await withConnection(pool, counts)
  check(Object.values(finalCounts).every(n => n === '0'), 'rehearsal_cleanup_incomplete')
  return { scope: REHEARSAL_SCOPE.id, target, steps, writerCalls, finalCounts, realNetworkFaultTested: false, businessBackfill: false, readyForPublicUpgrade: false }
}
