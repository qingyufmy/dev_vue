import assert from 'node:assert/strict'
import { createMysqlInferenceRepository } from '../../server/dist-v4/modules/inference/composition.js'
import { contentHash } from '../../server/dist-v4/modules/inference/index.js'
import { freezeStrategyMemory } from '../../server/dist-v4/modules/inference/application/freeze-strategy-memory.js'
import { createMysqlRuntimeStrategyMemoryReader, createMysqlRuntimeMemoryPreparationWriter } from '../../server/dist-v4/modules/reviews/composition.js'

export async function verifyMemoryPreparationTransaction(connection, pool) {
  const [[scope]] = await connection.query('SELECT DATABASE() db')
  assert.match(scope.db, /^dev_vue_strategy_ref_[0-9a-f]{32}$/)
  const strategyMemory = await freezeStrategyMemory({ userId: 7, strategyId: '60001', strategyKind: 'analysis' }, createMysqlRuntimeStrategyMemoryReader(connection))
  const snapshot = { kind: 'analysis', strategy: { id: '60001', versionId: '60011', promptHash: 'a'.repeat(64), promptText: 'fixture' },
    market: { symbol: 'XAUUSD' }, macro: null, capturedAt: '2026-09-09T00:00:00.000Z', strategyMemory }
  const input = { runId: 'memory-analysis-atomic', userId: 7, expectedRevision: 1, snapshotId: 'memory-atomic-snapshot',
    snapshot, snapshotHash: contentHash(snapshot), taskId: 'memory-atomic-task', attemptId: 'memory-atomic-attempt',
    modelProfileId: null, provider: 'fixture', model: 'fixture', workerId: 'reference', deadlineAt: '2026-09-09T00:05:00.000Z' }
  await connection.execute(`INSERT INTO ai_analysis_runs
    (id,user_id,strategy_id,strategy_version_id,standard_symbol,trigger_type,idempotency_key,status,revision,created_at_utc,updated_at_utc)
    VALUES (?,7,60001,60011,'XAUUSD','manual',?,'queued',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [input.runId, input.runId])
  const utcPool = { async getConnection() {
    const db = await pool.getConnection()
    try { await db.query("SET SESSION time_zone='+00:00'"); return db } catch (error) { db.release(); throw error }
  } }
  const unused = () => { throw Error('unexpected_analysis_dependency') }
  const failed = createMysqlInferenceRepository(utcPool, unused, unused, unused, { subscribers: unused, inventory: unused, risks: unused }, db => ({ async record(value) {
    assert.deepEqual(await createMysqlRuntimeStrategyMemoryReader(db).read({ userId: 7, strategyId: '60001', strategyKind: 'analysis' }),
      await createMysqlRuntimeStrategyMemoryReader(connection).read({ userId: 7, strategyId: '60001', strategyKind: 'analysis' }))
    await createMysqlRuntimeMemoryPreparationWriter(db).record(value)
    throw Error('injected_memory_audit_failure')
  } }))
  await assert.rejects(failed.beginAnalysis(input), { message: 'injected_memory_audit_failure' })
  for (const [table, field, id] of [
    ['inference_snapshots', 'id', input.snapshotId], ['inference_snapshot_payloads', 'snapshot_id', input.snapshotId],
    ['strategy_memory_injection_logs_v4', 'runtime_id', input.runId], ['ai_model_tasks', 'id', input.taskId],
    ['ai_model_attempts', 'id', input.attemptId], ['outbox_events', 'aggregate_id', input.runId],
  ]) {
    const [[row]] = await connection.execute(`SELECT COUNT(*) n FROM ${table} WHERE ${field}=?`, [id])
    assert.equal(Number(row.n), 0)
  }
  const [[queued]] = await connection.execute('SELECT status,revision FROM ai_analysis_runs WHERE id=?', [input.runId])
  assert.equal(queued.status, 'queued'); assert.equal(Number(queued.revision), 1)
  const mutableInput = structuredClone(input)
  const mutationPool = { async getConnection() {
    mutableInput.snapshot.market.symbol = 'EURUSD'
    mutableInput.snapshot.strategyMemory.contentText = 'changed after transaction entry'
    mutableInput.snapshotId = 'changed-snapshot-id'
    return utcPool.getConnection()
  } }
  const repository = createMysqlInferenceRepository(mutationPool, unused, unused, unused, { subscribers: unused, inventory: unused, risks: unused }, createMysqlRuntimeMemoryPreparationWriter)
  const claim = await repository.beginAnalysis(mutableInput)
  assert.equal(claim.run.status, 'running')
  const [[audit]] = await connection.execute(`SELECT input_snapshot_sha256,token_count,injected,estimated_token_count
    FROM strategy_memory_injection_logs_v4 WHERE runtime_kind='analysis' AND runtime_id=?`, [input.runId])
  assert.equal(audit.input_snapshot_sha256, input.snapshotHash)
  assert.equal(audit.token_count, null); assert.equal(audit.injected, 0)
  assert.equal(audit.estimated_token_count, strategyMemory.budget.estimatedTokens)
  const [[stored]] = await connection.execute('SELECT payload_json FROM inference_snapshot_payloads WHERE snapshot_id=?', [input.snapshotId])
  const payload = typeof stored.payload_json === 'string' ? JSON.parse(stored.payload_json) : stored.payload_json
  assert.deepEqual(payload, snapshot); assert.equal(contentHash(payload), input.snapshotHash)
  return { passed: true, checks: ['actual-beginAnalysis-audit-failure-rolls-back-six-tables-and-run', 'actual-beginAnalysis-commits-frozen-input-and-preparation', 'actual-beginAnalysis-isolates-nested-input-mutation-during-connection-acquisition'],
    scope: 'Actual analysis repository and memory writer on isolated reference MySQL; no model call, Trader transaction or existing database upgrade proof.' }
}
