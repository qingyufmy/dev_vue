import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryAll, queryOne, queryRun, withTransaction } = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({ queryAll, queryOne, queryRun, withTransaction }))

import {
  assertMonthlyReviewCheckpointCoverage,
  buildMonthlyReviewChunks,
  claimMonthlyReviewCheckpoint,
  ensureMonthlyReviewCheckpoints,
  persistMonthlyReviewCheckpointContent,
  verifyMonthlyReviewCheckpointCoverage,
} from '../../server/routes/ai/period-review-monthly-checkpoints.js'

function source(periodCaseId, contentHash = `content-${periodCaseId}`) {
  return { period_case_id:periodCaseId, period_key:`2026-07-${String(periodCaseId).padStart(2, '0')}`,
    review_status:'approved', evidence_hash:`evidence-${periodCaseId}`, content_hash:contentHash }
}

function evidence(ids = Array.from({ length:31 }, (_, index) => index + 1), hash = 'evidence-set-1') {
  return { evidence_hash:hash, sources:ids.map(id => source(id)) }
}

describe('monthly review checkpoint persistence foundation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withTransaction.mockImplementation(async callback => callback(vi.fn(async () => [[], { affectedRows:1 }])))
    queryRun.mockResolvedValue({ affectedRows:1 })
  })

  it('splits 31 frozen source days into stable chunks of 8', () => {
    const plan = buildMonthlyReviewChunks({ sources:[...evidence().sources].reverse() })
    expect(plan.chunks.map(chunk => chunk.period_case_ids.length)).toEqual([8, 8, 8, 7])
    expect(plan.chunks.flatMap(chunk => chunk.period_case_ids)).toEqual(Array.from({ length:31 }, (_, index) => index + 1))
    expect(plan.expectedPeriodCaseIds).toEqual(Array.from({ length:31 }, (_, index) => index + 1))
    expect(new Set(plan.chunks.map(chunk => chunk.source_hash)).size).toBe(4)
  })

  it('keeps later calendar buckets stable when an early day is removed', () => {
    const sources = Array.from({ length:31 }, (_, index) => ({
      period_case_id:900 - index,
      period_key:`2026-07-${String(index + 1).padStart(2, '0')}`,
      content_hash:`day-${index + 1}`,
    }))
    const original = buildMonthlyReviewChunks({ sources })
    const changed = buildMonthlyReviewChunks({ sources:sources.slice(1), evidence_hash:'revision-2' })
    expect(original.chunks.map(chunk => chunk.period_case_ids.length)).toEqual([8, 8, 8, 7])
    expect(changed.chunks.map(chunk => chunk.period_case_ids.length)).toEqual([7, 8, 8, 7])
    expect(changed.chunks[1].chunk_index).toBe(1)
    expect(changed.chunks[1].source_hash).toBe(original.chunks[1].source_hash)
    expect(changed.chunks[2].source_hash).toBe(original.chunks[2].source_hash)
    expect(changed.chunks[3].source_hash).toBe(original.chunks[3].source_hash)
  })

  it('keeps succeeded chunks and lets restart claim only an incomplete chunk', async () => {
    const plan = buildMonthlyReviewChunks(evidence())
    const run = vi.fn(async sql => {
      if (sql.includes('SELECT * FROM period_review_monthly_checkpoints')) return [[
        { id:11, period_review_job_id:7, evidence_hash:plan.evidenceHash, source_hash:plan.chunks[0].sourceHash,
          expected_ids_hash:plan.chunks[0].expectedIdSetHash, chunk_index:0, status:'succeeded' },
        { id:12, period_review_job_id:7, evidence_hash:plan.evidenceHash, source_hash:plan.chunks[1].sourceHash,
          expected_ids_hash:plan.chunks[1].expectedIdSetHash, chunk_index:1, status:'queued' },
      ], {}]
      return [{ affectedRows:1, insertId:13 }, {}]
    })
    withTransaction.mockImplementationOnce(async callback => callback(run))
    await ensureMonthlyReviewCheckpoints({ periodReviewJobId:7, evidence:evidence() })
    expect(run.mock.calls.filter(([sql]) => sql.includes('INSERT INTO period_review_monthly_checkpoints'))).toHaveLength(2)

    const claimRun = vi.fn(async sql => {
      if (sql.includes('SELECT * FROM period_review_monthly_checkpoints')) return [[
        { id:12, chunk_index:1, status:'queued', fencing_token:4, attempt_count:0 },
      ], {}]
      return [{ affectedRows:1 }, {}]
    })
    withTransaction.mockImplementationOnce(async callback => callback(claimRun))
    const claimed = await claimMonthlyReviewCheckpoint({ periodReviewJobId:7, evidenceHash:plan.evidenceHash, nowUtcMs:1000 })
    expect(claimed).toMatchObject({ id:12, chunk_index:1, status:'leased', fencing_token:5 })
    expect(claimRun.mock.calls[0][1]).toEqual([7, plan.evidenceHash, 1000, 1000])
    expect(claimRun.mock.calls.some(([sql]) => sql.includes("status = 'queued'"))).toBe(true)
    expect(claimRun.mock.calls[0][0]).toContain("task.status IN ('queued','retry_wait')")
  })

  it('supersedes old evidence rows when the source set changes', async () => {
    const first = buildMonthlyReviewChunks(evidence())
    const changedEvidence = evidence(Array.from({ length:31 }, (_, index) => index + 1), 'evidence-set-2')
    changedEvidence.sources[3] = source(4, 'changed-content')
    const run = vi.fn(async sql => {
      if (sql.includes('SELECT * FROM period_review_monthly_checkpoints')) return [[
        { id:21, period_review_job_id:7, evidence_hash:first.evidenceHash, source_hash:first.chunks[0].sourceHash,
          expected_ids_hash:first.chunks[0].expectedIdSetHash, chunk_index:0, status:'succeeded' },
        { id:22, period_review_job_id:7, evidence_hash:first.evidenceHash, source_hash:first.chunks[1].sourceHash,
          expected_ids_hash:first.chunks[1].expectedIdSetHash, chunk_index:1, status:'succeeded',
          content_json:'{"daily_assessments":[{"period_case_id":9}]}', content_hash:'content-hash',
          model_task_id:'model-task-22', completed_at_utc_msc:90 },
      ], {}]
      if (sql.includes('SELECT * FROM period_review_monthly_checkpoints') && sql.includes('evidence_hash = ?')) return [[], {}]
      return [{ affectedRows:1, insertId:30 }, {}]
    })
    withTransaction.mockImplementation(async callback => callback(run))
    const result = await ensureMonthlyReviewCheckpoints({ periodReviewJobId:7, evidence:changedEvidence })
    expect(result.superseded).toBe(1)
    expect(run.mock.calls.some(([sql, params]) => sql.includes("status = 'superseded'") && params.includes('monthly_review_source_changed'))).toBe(true)
    expect(run.mock.calls.some(([sql]) => sql.includes('reused_from_checkpoint_id'))).toBe(true)
  })

  it('rejects missing, duplicate, and fabricated period case IDs without merging conflicts', () => {
    const missing = verifyMonthlyReviewCheckpointCoverage([
      { id:1, chunk_index:0, content_json:JSON.stringify({ daily_assessments:[{ period_case_id:1 }] }) },
    ], [1, 2])
    expect(missing.ok).toBe(false)
    expect(missing.missingIds).toEqual([2])
    expect(missing.assessments).toBeNull()

    const duplicate = verifyMonthlyReviewCheckpointCoverage([
      { id:1, chunk_index:0, content_json:JSON.stringify({ daily_assessments:[{ period_case_id:1 }] }) },
      { id:2, chunk_index:1, content_json:JSON.stringify({ daily_assessments:[{ period_case_id:1 }] }) },
    ], [1])
    expect(duplicate.duplicateIds).toEqual([1])
    expect(duplicate.conflictGroups[0].records).toHaveLength(2)

    const fabricated = verifyMonthlyReviewCheckpointCoverage([
      { id:1, chunk_index:0, content_json:JSON.stringify({ daily_assessments:[{ period_case_id:99 }] }) },
    ], [1])
    expect(fabricated.fabricatedIds).toEqual([99])
    expect(() => assertMonthlyReviewCheckpointCoverage([
      { id:1, chunk_index:0, content_json:JSON.stringify({ daily_assessments:[{ period_case_id:1 }] }) },
    ], [1, 2])).toThrow('monthly_review_checkpoint_coverage_invalid')
  })

  it('does not persist content after the exact lease/fence is stale', async () => {
    queryOne.mockResolvedValue({ id:12, status:'leased', expected_period_case_ids_json:'[1]', chunk_index:0 })
    queryRun.mockResolvedValue({ affectedRows:0 })
    await expect(persistMonthlyReviewCheckpointContent({ checkpointId:12, leaseToken:'old-lease', fencingToken:3,
      content:{ daily_assessments:[{ period_case_id:1, summary:'有效' }] } }))
      .rejects.toThrow('monthly_review_checkpoint_fence_lost')
    expect(queryRun).toHaveBeenCalledTimes(1)
    expect(queryRun.mock.calls[0][0]).toContain("status = 'succeeded'")
  })
})
