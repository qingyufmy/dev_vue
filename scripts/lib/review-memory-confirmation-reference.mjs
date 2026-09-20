import { reviewEvidenceHash } from '../../server/dist-v4/modules/reviews/infrastructure/review-evidence-integrity.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ReviewService } from '../../server/dist-v4/modules/reviews/index.js'
import { MysqlReviewRepository } from '../../server/dist-v4/modules/reviews/infrastructure/mysql-review-repository.js'
import { createMysqlReviewWorker, createMysqlRuntimeStrategyMemoryReader } from '../../server/dist-v4/modules/reviews/composition.js'

export async function verifyReviewMemoryConfirmation(db, pool, insert) {
  const caseId = randomUUID(), jobId = randomUUID()
  const role = { assessment: 'effective', summary: 'Synthetic evidence', evidenceRefs: [] }
  const content = { schemaVersion: 'review.v4.1', conclusion: 'mixed', headline: 'Reference review', summary: 'Synthetic review',
    metrics: { netProfit: '10', tradeCount: 1, winRatePercent: '100', profitFactor: null }, tradeEpisodes: [],
    roles: { analyst: role, trader: role, risk: role, execution: role }, counterexamples: [], evidenceRefs: [],
    memoryCandidates: [{ strategyId: '2', memoryKey: 'entry.confirmation', updateKind: 'short_term', title: 'Reference memory', content: 'Accepted review memory fixture', evidenceRefs: [] }],
    fullAnalysisText: 'Synthetic previously generated version' }
  await insert('review_cases_v4', { id: caseId, kind: 'daily', user_id: 7, trading_account_id: 5, standard_symbol: 'XAUUSD',
    analysis_strategy_id: 1, analysis_strategy_version_id: 11, trader_strategy_id: 2, trader_strategy_version_id: 22, terminal_period_start_utc: '2026-09-01 00:00:00.000', terminal_period_end_utc: '2026-09-02 00:00:00.000', status: 'queued', evidence_status: 'complete', evidence_revision: 1, current_version_id: null, revision: 1 })
  const evidence = { schema_version: 'reference-review-evidence/v1', trades: [{ ticket: '9100', net_profit: '10' }] }
  const evidenceHash = reviewEvidenceHash(evidence)
  await db.execute('UPDATE review_cases_v4 SET evidence_sha256=? WHERE id=?', [evidenceHash, caseId])
  await insert('review_evidence_payloads_v4', { review_case_id: caseId, evidence_revision: 1, evidence_sha256: evidenceHash, evidence_json: JSON.stringify(evidence) })
  await insert('review_jobs_v4', { id: jobId, review_case_id: caseId, generation: 1, mode: 'initial', status: 'queued', evidence_revision: 1, input_sha256: evidenceHash, fencing_token: 0 })
  const wire = value => Array.isArray(value) ? value.map(wire) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key.replace(/[A-Z]/g, ch=>'_'+ch.toLowerCase()),wire(item)])) : value
  let modelCalls = 0
  const worker = createMysqlReviewWorker(pool, { async resolve(claim) {
    assert.equal(claim.caseId, caseId)
    assert.equal(claim.evidence.trades[0].net_profit, '10')
    return { profileId: '1', provider: 'fixture', model: 'fixture', timeoutMs: 1000, maxAttempts: 1, async invoke(messages) {
      modelCalls++
      assert.equal(JSON.parse(messages.at(-1).content).evidence_sha256, evidenceHash)
      return { value: wire(content), usage: null }
    } }
  } }, 'reference-memory-review')
  const generated = await worker.process(jobId)
  assert.equal(generated.status, 'succeeded', JSON.stringify(generated))
  assert.equal((await worker.process(jobId)).status, 'ignored'); assert.equal(modelCalls, 1)
  const detail = await new MysqlReviewRepository(pool).getCase(7, caseId)
  assert.equal(detail.summary.status, 'awaiting_confirmation')
  const versionId = detail.currentVersion.id, confirmRevision = detail.summary.revision
  await insert('users', { id: 8, nickname: 'memory-other-user', email: 'memory-other@example.test', deletion_status: 'active', deleted_at: null })
  const service = new ReviewService(new MysqlReviewRepository(pool))
  const reader = createMysqlRuntimeStrategyMemoryReader(pool), scope = { userId: 7, strategyId: '2', strategyKind: 'trader' }
  const before = await reader.read(scope)
  assert.equal((await service.memoryUpdates(7, 'memory_library_2')).length, 0)
  const confirmed = await service.confirm(7, caseId, versionId, confirmRevision, 'confirm-memory-reference-001')
  assert.equal(confirmed.summary.status, 'confirmed')
  assert.deepEqual(await service.confirm(7, caseId, versionId, confirmRevision, 'confirm-memory-reference-001'), confirmed)
  const updates = await service.memoryUpdates(7, 'memory_library_2')
  assert.equal(updates.length, 1); assert.equal(updates[0].status, 'awaiting_confirmation')
  assert.deepEqual(await reader.read(scope), before)
  await assert.rejects(service.decideMemoryUpdate(8, updates[0].id, updates[0].revision, 'accept', 'accept-memory-foreign-001'), { code: 'strategy_memory_update_not_found' })
  await service.decideMemoryUpdate(7, updates[0].id, updates[0].revision, 'accept', 'accept-memory-reference-001')
  const after = await reader.read(scope)
  await service.decideMemoryUpdate(7, updates[0].id, updates[0].revision, 'accept', 'accept-memory-reference-001')
  assert.deepEqual(await reader.read(scope), after)
  assert.notEqual(after.revisionId, before.revisionId)
  assert.ok(after.contentText.includes('Accepted review memory fixture'))
  return { contentText: after.contentText, checks: ['actual-review-worker-generates-one-version-before-confirmation', 'review-confirmation-replay-creates-one-pending-memory', 'unaccepted-memory-does-not-change-runtime-input', 'accepted-memory-new-revision-reaches-runtime-reader'] }
}
