import { describe, expect, it, vi } from 'vitest'
import { ReviewWorker, type ReviewJobClaim, type ReviewWorkerRepository } from '../src/modules/reviews/index.js'

const claim: ReviewJobClaim = {
  jobId: 'review-job-1', caseId: 'review-case-1', userId: 7, tradingAccountId: 'account-1', kind: 'daily', generation: 1,
  evidenceRevision: 2, evidenceHash: 'a'.repeat(64), evidence: { frozen: true }, allowedEvidenceRefs: ['market_analysis:analysis-1'],
  strategyId: 'strategy-1', allowedStrategyIds: ['strategy-1', 'strategy-2'], analysisPrompt: '只分析行情', traderPrompt: '结合账户决定动作', fencingToken: 3, workerId: 'review:test', nextAttemptNumber: 1,
}

const wireContent = {
  schema_version: 'review.v4.1', conclusion: 'mixed', headline: '复盘完成', summary: '分析有效，执行一般',
  metrics: { net_profit: '3.2', trade_count: 1, win_rate_percent: '100', profit_factor: '1.2' }, trade_episodes: [],
  roles: Object.fromEntries(['analyst', 'trader', 'risk', 'execution'].map(role => [role, { assessment: 'effective', summary: `${role}摘要`, evidence_refs: ['market_analysis:analysis-1'] }])),
  counterexamples: [], memory_candidates: [], evidence_refs: ['market_analysis:analysis-1'], full_analysis_text: '完整复盘正文',
}

class MemoryWorkerRepository implements ReviewWorkerRepository {
  starts: number[] = []; failures: Array<{ final: boolean; code: string }> = []; completed = false; failedJob: string | null = null; leaseExpiresAt: string | null = null
  async claimJob(_jobId: string, _workerId: string, _claimedAt: string, leaseExpiresAt: string) { this.leaseExpiresAt = leaseExpiresAt; return claim }
  async startModelAttempt(input: Parameters<ReviewWorkerRepository['startModelAttempt']>[0]) { this.starts.push(input.attemptNumber) }
  async failJob(input: Parameters<ReviewWorkerRepository['failJob']>[0]) { this.failedJob = input.errorCode }
  async failModelAttempt(input: Parameters<ReviewWorkerRepository['failModelAttempt']>[0]) { this.failures.push({ final: input.final, code: input.errorCode }) }
  async completeJob() { this.completed = true; return { versionId: 'version-1' } }
}

describe('Stage 12R review worker', () => {
  it('uses frozen evidence and produces an immutable version without executing a trade', async () => {
    const repository = new MemoryWorkerRepository()
    const invoke = vi.fn(async (_messages: Array<{ role: 'system' | 'user'; content: string }>, _signal: AbortSignal) => ({ value: wireContent, usage: { total_tokens: 100 } }))
    const worker = new ReviewWorker(repository, { resolve: async () => ({ profileId: '1', provider: 'openai-compatible', model: 'review-model', timeoutMs: 10_000, maxAttempts: 2, invoke }) }, 'review:test')
    await expect(worker.process(claim.jobId, new Date('2026-09-04T08:00:00.000Z'))).resolves.toEqual({ status: 'succeeded', versionId: 'version-1' })
    expect(repository.completed).toBe(true)
    expect(repository.starts).toEqual([1])
    expect(repository.leaseExpiresAt).toBe('2026-09-04T08:35:00.000Z')
    expect(invoke.mock.calls[0]?.[0]).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('allowed_evidence_refs') }))
  })

  it('counts provider retries separately inside one review business job', async () => {
    const repository = new MemoryWorkerRepository(); let calls = 0
    const worker = new ReviewWorker(repository, { resolve: async () => ({
      profileId: '1', provider: 'provider', model: 'model', timeoutMs: 10_000, maxAttempts: 2,
      invoke: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('model_http_429'), { status: 'failed', retryable: true }); return { value: wireContent, usage: null } },
    }) }, 'review:test')
    await expect(worker.process(claim.jobId)).resolves.toMatchObject({ status: 'succeeded' })
    expect(repository.starts).toEqual([1, 2])
    expect(repository.failures).toEqual([{ final: false, code: 'model_http_429' }])
  })

  it('fails closed when model evidence references were not in the frozen source set', async () => {
    const repository = new MemoryWorkerRepository()
    const worker = new ReviewWorker(repository, { resolve: async () => ({ profileId: '1', provider: 'provider', model: 'model', timeoutMs: 10_000, maxAttempts: 3, invoke: async () => ({ value: { ...wireContent, evidence_refs: ['future:1'] }, usage: null }) }) }, 'review:test')
    await expect(worker.process(claim.jobId)).resolves.toEqual({ status: 'failed', code: 'review_evidence_reference_invalid' })
    expect(repository.completed).toBe(false)
    expect(repository.failures).toEqual([{ final: true, code: 'review_evidence_reference_invalid' }])
  })

  it('rejects memory candidates for strategies outside the frozen review scope', async () => {
    const repository = new MemoryWorkerRepository()
    const candidate = { strategy_id: 'strategy-other', memory_key: 'entry.confirmation', update_kind: 'short_term', title: '越界候选', content: '不能写入其它策略。', evidence_refs: ['market_analysis:analysis-1'] }
    const worker = new ReviewWorker(repository, { resolve: async () => ({ profileId: '1', provider: 'provider', model: 'model', timeoutMs: 10_000, maxAttempts: 2, invoke: async () => ({ value: { ...wireContent, memory_candidates: [candidate] }, usage: null }) }) }, 'review:test')
    await expect(worker.process(claim.jobId)).resolves.toEqual({ status: 'failed', code: 'review_memory_strategy_invalid' })
    expect(repository.completed).toBe(false)
  })
})
